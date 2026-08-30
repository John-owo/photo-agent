import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES, MockBackend } from "../src/backends.js";
import { ingestPair } from "../src/ingest.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { CodexProvider, MockProvider } from "../src/providers.js";
import { acquireMutationLock, SessionStore } from "../src/runtime.js";
import { BackendCapabilityManifestSchema } from "../src/schemas.js";
import { translateIntent } from "../src/translator.js";
import { recoverSession, resumeCodexSession, runSinglePhoto } from "../src/workflow.js";
import { createXmpSidecar, writeXmpSidecar } from "../src/xmp.js";

async function fixturePair(): Promise<{ root: string; raw: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-test-"));
  const raw = join(root, "sample.NEF");
  const preview = join(root, "sample.JPG");
  await writeFile(raw, "synthetic raw fixture", "utf8");
  await writeFixtureJpeg(preview);
  return { root, raw, preview };
}

type RecoveryReportFixture = {
  evidence_status: "consistent" | "contradictory" | "insufficient" | "readback_failed";
  reason: string;
  workflow_copy_intent: unknown;
  workflow_copy: unknown | null;
  checkpoint_artifacts: string[];
  operation_artifacts: string[];
  readback_artifacts: string[];
  operation_evidence_status: "none" | "consistent" | "insufficient" | "contradictory";
  copy_creation_reconciled: boolean;
  copy_creation_retried: false;
  mutation_retried: false;
  read_back: {
    photo_id: string;
    identity?: { catalog_id: string; uuid: string };
  } | null;
};

async function recoveryReportPaths(sessionDir: string): Promise<string[]> {
  return (await readdir(join(sessionDir, "recovery")))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(sessionDir, "recovery", name));
}

describe("v0.1-alpha contracts", () => {
  it("translates semantic strength into stable Lightroom-independent deltas", () => {
    const plan = translateIntent({
      schema_version: "0.1.0",
      creative_goal: "test",
      adjustments: [
        {
          parameter: "exposure",
          direction: "increase",
          strength: "medium",
          rationale: "test",
          confidence: 0.9,
        },
        {
          parameter: "temperature",
          direction: "decrease",
          strength: "strong",
          rationale: "test",
          confidence: 0.9,
        },
        {
          parameter: "contrast",
          direction: "increase",
          strength: "slight",
          rationale: "test",
          confidence: 0.4,
        },
      ],
      overall_confidence: 0.9,
    });
    expect(plan.operations.map((operation) => [operation.parameter, operation.value])).toEqual([
      ["exposure_ev", 0.4],
      ["temperature_k", -750],
    ]);
    expect(plan.warnings).toHaveLength(1);
  });

  it("stops on ambiguous RAW/preview pairing", async () => {
    const { root, preview } = await fixturePair();
    const otherRaw = join(root, "different.NEF");
    await writeFile(otherRaw, "synthetic raw fixture", "utf8");
    await expect(ingestPair(otherRaw, preview)).rejects.toThrow("basename mismatch");
  });

  it("persists a dry-run session without mutating a backend", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: false,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual([]);
    expect(await readFile(join(result.sessionDir, "semantic-intent.json"), "utf8")).toContain(
      "creative_goal",
    );
  });

  it("does not create a Workflow Copy for an executable no-op", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const emptyProvider = {
      requiresCloudPreview: false,
      analyze: async () => ({
        intent: {
          schema_version: "0.1.0" as const,
          creative_goal: "already matches",
          adjustments: [],
          overall_confidence: 1,
        },
        metadata: {
          provider: "mock" as const,
          model: "mock-empty-plan",
          promptVersion: "test",
          promptHash: "0".repeat(64),
          cloudPreview: false,
        },
      }),
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: emptyProvider,
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual([]);
  });

  it.each([
    ["a clamped adjustment", { Exposure2012: 5, Contrast2012: 100 }],
    ["an unresolvable adjustment", { Exposure2012: "unavailable" }],
  ])("does not create a Workflow Copy for %s", async (_label, developOverride) => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const readCurrentEdit = backend.readCurrentEdit.bind(backend);
    backend.readCurrentEdit = async (photoId) => {
      const state = await readCurrentEdit(photoId);
      return {
        ...state,
        develop_settings: { ...state.develop_settings, ...developOverride },
      };
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
    expect(backend.calls).not.toContain("create_workflow_copy");
  });

  it("validates the iteration budget before creating a Workflow Copy", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      maxIterations: 0,
    });

    expect(result.state).toBe("FAILED");
    expect(backend.calls).toEqual([]);
  });

  it.each(["virtual_copy", "uncertain"] as const)(
    "stops %s source identity before Workflow Copy creation",
    async (sourceIdentity) => {
      const { root, raw, preview } = await fixturePair();
      const backend = new MockBackend(raw, { sourceIdentity });
      const result = await runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: new MockProvider(),
        backend,
        sessionRoot: join(root, "sessions"),
        apply: true,
        allowCloudPreview: false,
      });

      expect(result.state).toBe("REVIEW_REQUIRED");
      expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
      expect(backend.calls).not.toContain("create_workflow_copy");
    },
  );

  it.each(["virtual_copy", "uncertain"] as const)(
    "keeps %s source identity in REVIEW_REQUIRED when its path also mismatches",
    async (sourceIdentity) => {
      const { root, raw, preview } = await fixturePair();
      const backend = new MockBackend(join(root, "different.NEF"), { sourceIdentity });
      const result = await runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: new MockProvider(),
        backend,
        sessionRoot: join(root, "sessions"),
        apply: true,
        allowCloudPreview: false,
      });

      expect(result.state).toBe("REVIEW_REQUIRED");
      expect(backend.calls).not.toContain("create_workflow_copy");
    },
  );

  it("requires an explicit cloud-preview opt-in", async () => {
    const { root, raw, preview } = await fixturePair();
    const cloudProvider = {
      requiresCloudPreview: true,
      analyze: async () => new MockProvider().analyze(),
    };
    await expect(
      runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: cloudProvider,
        backend: new MockBackend(raw),
        sessionRoot: join(root, "sessions"),
        apply: false,
        allowCloudPreview: false,
      }),
    ).rejects.toThrow("allow-cloud-preview");
  });

  it("creates a Codex-local handoff without calling a provider API", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new CodexProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("CODEX_INPUT_REQUIRED");
    expect(result.handoffPath).toMatch(/codex-analysis-request\.md$/);
    expect(backend.calls).toEqual([]);
    expect(await readFile(result.handoffPath!, "utf8")).toContain("raw-photo-lightroom-preset");
  });

  it("resumes a Codex handoff and guards a cloud evaluator", async () => {
    const { root, raw, preview } = await fixturePair();
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new CodexProvider(),
      backend: new MockBackend(raw),
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    const intentFile = join(initial.sessionDir, "codex-intent.json");
    await writeFile(
      intentFile,
      JSON.stringify({
        schema_version: "0.1.0",
        creative_goal: "local Codex review",
        adjustments: [
          {
            parameter: "exposure",
            direction: "increase",
            strength: "slight",
            rationale: "Fixture intent",
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      }),
      "utf8",
    );
    const backend = new MockBackend(raw);
    let cloudCalls = 0;
    const cloudEvaluator = {
      name: "cloud-resume-fixture",
      requiresCloudPreview: true,
      evaluate: async () => {
        cloudCalls += 1;
        throw new Error("cloud evaluator should not be called without opt-in");
      },
    };
    await expect(
      resumeCodexSession({
        sessionDir: initial.sessionDir,
        intentFile,
        backend,
        apply: true,
        allowCloudPreview: false,
        evaluator: cloudEvaluator,
      }),
    ).rejects.toThrow("evaluator requires --allow-cloud-preview");
    expect(cloudCalls).toBe(0);
    expect(backend.calls).toEqual([]);
    const result = await resumeCodexSession({
      sessionDir: initial.sessionDir,
      intentFile,
      backend,
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.renderPath).toMatch(/mock-render\.jpg$/);
    expect(result.manifest.backend).toEqual({ name: "mock", version: "0.1.0" });
    expect(result.manifest.provider.name).toBe("codex");
    expect(backend.calls).toContain("apply_global_adjustment");
  });

  it("routes the mock apply path through one verified Workflow Copy", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.renderPath).toMatch(/mock-render\.jpg$/);
    expect(backend.calls).toEqual([
      "connect",
      "handshake",
      "read_current_edit",
      "create_workflow_copy",
      "read_current_edit",
      "create_checkpoint",
      "apply_global_adjustment",
      "read_current_edit",
      "render_preview",
      "close",
    ]);
    expect(await readFile(join(result.sessionDir, "workflow-copy.json"), "utf8")).toContain(
      '"is_virtual_copy": true',
    );
    const workflowCopy = JSON.parse(
      await readFile(join(result.sessionDir, "workflow-copy.json"), "utf8"),
    ) as { copy: { catalog_id: string } };
    expect(backend.operationTargets).toEqual([
      workflowCopy.copy.catalog_id,
      workflowCopy.copy.catalog_id,
      workflowCopy.copy.catalog_id,
    ]);
    await backend.connect();
    await backend.handshake();
    const masterAfter = await backend.readCurrentEdit(raw);
    const copyAfter = await backend.readCurrentEdit(workflowCopy.copy.catalog_id);
    await backend.close();
    expect(masterAfter.develop_settings.Exposure2012).toBe(0);
    expect(copyAfter.develop_settings.Exposure2012).toBe(0.2);
    expect(await readFile(raw, "utf8")).toBe("synthetic raw fixture");
    expect(await readFile(join(result.sessionDir, "checkpoints", "before.json"), "utf8")).toContain(
      "PhotoAgent_",
    );
  });

  it("does not mutate a Copy when the create result has the wrong operation id", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const createWorkflowCopy = backend.createWorkflowCopy.bind(backend);
    backend.createWorkflowCopy = async (sourcePhotoId, expectedSourceUuid, operationId) => ({
      ...(await createWorkflowCopy(sourcePhotoId, expectedSourceUuid, operationId)),
      operation_id: "unexpected-operation-id",
    });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.operationTargets).toEqual([]);
    expect(backend.calls).not.toContain("create_checkpoint");
  });

  it("does not mutate a Copy when the create result names a different Master", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const createWorkflowCopy = backend.createWorkflowCopy.bind(backend);
    backend.createWorkflowCopy = async (sourcePhotoId, expectedSourceUuid, operationId) => {
      const result = await createWorkflowCopy(sourcePhotoId, expectedSourceUuid, operationId);
      return {
        ...result,
        master: result.master
          ? { ...result.master, uuid: "unexpected-master-uuid" }
          : result.master,
      };
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.operationTargets).toEqual([]);
    expect(backend.calls).not.toContain("create_checkpoint");
  });

  it("rejects invalid state transitions", async () => {
    const { root, raw, preview } = await fixturePair();
    const source = await ingestPair(raw, preview);
    const store = await SessionStore.create(join(root, "sessions"), source, "mock");
    await expect(store.transition("RENDERING")).rejects.toThrow("PENDING -> RENDERING");
  });

  it("reclaims a lock only when the recorded owner is dead and stale", async () => {
    const { root } = await fixturePair();
    const lockPath = join(root, "mutation.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 999999,
        created_at: new Date(Date.now() - 60_000).toISOString(),
        session_id: "old-session",
      }),
      "utf8",
    );
    const unlock = await acquireMutationLock(lockPath, { staleAfterMs: 1_000 });
    expect(await readFile(lockPath, "utf8")).toContain('"pid"');
    await unlock();
  });

  it("does not reclaim a live lock", async () => {
    const { root } = await fixturePair();
    const lockPath = join(root, "mutation.lock");
    const unlock = await acquireMutationLock(lockPath);
    await expect(acquireMutationLock(lockPath, { staleAfterMs: 0 })).rejects.toThrow(
      "already held",
    );
    await unlock();
  });

  it("recovers an interrupted backend mutation without retrying it", async () => {
    const { root, raw, preview } = await fixturePair();
    const source = await ingestPair(raw, preview);
    const session = await SessionStore.create(join(root, "sessions"), source, "mock");
    await session.transition("ANALYZING");
    await session.transition("PLAN_READY");
    await session.transition("APPLYING");
    const backend = new MockBackend(raw);
    const result = await recoverSession({ sessionDir: session.dir, backend });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.manifest.backend).toEqual({ name: "mock", version: "0.1.0" });
    expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
    const reports = await recoveryReportPaths(session.dir);
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture & {
      interrupted_state: string;
    };
    expect(report.interrupted_state).toBe("APPLYING");
    expect(report.evidence_status).toBe("insufficient");
    expect(report.read_back?.photo_id).toBe(raw);
  });

  it("records Copy creation intent and never retries when the create response is lost", async () => {
    const { root, raw, preview } = await fixturePair();
    const sessionRoot = join(root, "sessions");
    const backend = new MockBackend(raw);
    const createWorkflowCopy = backend.createWorkflowCopy.bind(backend);
    let createdCopyCount = 0;
    let createCalls = 0;
    const observedCopyIds: string[] = [];
    let intentObservedBeforeCreate: unknown;
    backend.createWorkflowCopy = async (sourcePhotoId, expectedSourceUuid, operationId) => {
      createCalls += 1;
      const sessionEntry = (await readdir(sessionRoot, { withFileTypes: true })).find((entry) =>
        entry.isDirectory(),
      );
      intentObservedBeforeCreate = JSON.parse(
        await readFile(join(sessionRoot, sessionEntry!.name, "workflow-copy-intent.json"), "utf8"),
      ) as unknown;
      const created = await createWorkflowCopy(sourcePhotoId, expectedSourceUuid, operationId);
      if (created.result === "created") createdCopyCount += 1;
      if (created.copy) observedCopyIds.push(created.copy.catalog_id);
      if (createCalls === 1) {
        throw new Error("simulated timeout after Workflow Copy side effect");
      }
      return created;
    };

    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot,
      apply: true,
      allowCloudPreview: false,
    });

    expect(initial.state).toBe("REVIEW_REQUIRED");
    expect(createdCopyCount).toBe(1);
    expect(backend.calls.filter((call) => call === "create_workflow_copy")).toHaveLength(1);
    const copyIntent = JSON.parse(
      await readFile(join(initial.sessionDir, "workflow-copy-intent.json"), "utf8"),
    ) as {
      operation_id: string;
      source: Record<string, unknown>;
    };
    expect(copyIntent.operation_id).toMatch(/^photoagent-vc-/);
    expect(copyIntent.source).toEqual({
      catalog_id: raw,
      uuid: "mock-master-uuid",
      master_id: raw,
      master_uuid: "mock-master-uuid",
      is_virtual_copy: false,
    });
    expect(intentObservedBeforeCreate).toEqual(copyIntent);

    const resumeBackend = new MockBackend(raw);
    await expect(
      resumeCodexSession({
        sessionDir: initial.sessionDir,
        intentFile: join(initial.sessionDir, "codex-intent.json"),
        backend: resumeBackend,
        apply: true,
        allowCloudPreview: false,
      }),
    ).rejects.toThrow("only CODEX_INPUT_REQUIRED sessions can be resumed");
    expect(resumeBackend.calls).toEqual([]);

    backend.calls.length = 0;
    backend.operationTargets.length = 0;
    const recovered = await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls.filter((call) => call === "create_workflow_copy")).toHaveLength(0);
    expect(backend.calls.filter((call) => call === "reconcile_workflow_copy")).toHaveLength(1);
    expect(backend.calls).toEqual([
      "connect",
      "handshake",
      "read_current_edit",
      "reconcile_workflow_copy",
      "read_current_edit",
      "close",
    ]);
    expect(backend.calls).not.toContain("create_checkpoint");
    expect(backend.calls).not.toContain("apply_global_adjustment");
    expect(backend.calls).not.toContain("render_preview");
    expect(backend.operationTargets).toEqual([]);
    expect(createdCopyCount).toBe(1);
    expect(new Set(observedCopyIds).size).toBe(1);

    const reports = await recoveryReportPaths(initial.sessionDir);
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("consistent");
    expect(report.reason).toMatch(/workflow[ _]copy.*reconcil/i);
    expect(report.workflow_copy_intent).toEqual(copyIntent);
    expect(report.workflow_copy).toMatchObject({
      operation_id: copyIntent.operation_id,
      result: "reconciled",
      copy: { catalog_id: observedCopyIds[0] },
    });
    expect(report.copy_creation_reconciled).toBe(true);
    expect(report.copy_creation_retried).toBe(false);
    expect(report.mutation_retried).toBe(false);
    expect(report.checkpoint_artifacts).toEqual([]);
    expect(report.operation_artifacts).toEqual([]);
    expect(report.read_back).toMatchObject({
      photo_id: observedCopyIds[0],
      identity: { catalog_id: observedCopyIds[0] },
    });
  });

  it("fails closed when read-only Workflow Copy reconciliation is unavailable", async () => {
    const { root, raw, preview } = await fixturePair();
    const legacyManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      capabilities: MOCK_CAPABILITIES.capabilities.filter(
        (capability) => capability !== "reconcile_workflow_copy",
      ),
      operations: Object.fromEntries(
        Object.entries(MOCK_CAPABILITIES.operations).filter(
          ([operation]) => operation !== "reconcile_workflow_copy",
        ),
      ),
    });
    const backend = new MockBackend(raw, { manifest: legacyManifest });
    const createWorkflowCopy = backend.createWorkflowCopy.bind(backend);
    backend.createWorkflowCopy = async (sourcePhotoId, expectedSourceUuid, operationId) => {
      await createWorkflowCopy(sourcePhotoId, expectedSourceUuid, operationId);
      throw new Error("simulated timeout after Workflow Copy side effect");
    };

    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");

    backend.calls.length = 0;
    const recovered = await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
    expect(backend.calls).not.toContain("create_workflow_copy");
    expect(backend.calls).not.toContain("reconcile_workflow_copy");
    const reports = await recoveryReportPaths(initial.sessionDir);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("insufficient");
    expect(report.reason).toMatch(/read.only.*reconcil.*unavailable/i);
    expect(report.workflow_copy_intent).toMatchObject({ operation_id: expect.any(String) });
    expect(report.workflow_copy).toBeNull();
    expect(report.copy_creation_retried).toBe(false);
    expect(report.mutation_retried).toBe(false);
  });

  it("reads the recorded Copy after an uncertain Develop response without retrying it", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const applyGlobalAdjustment = backend.applyGlobalAdjustment.bind(backend);
    let applyCalls = 0;
    backend.applyGlobalAdjustment = async (photoId, settings) => {
      applyCalls += 1;
      await applyGlobalAdjustment(photoId, settings);
      throw new Error("simulated timeout after Develop side effect");
    };
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");
    expect(applyCalls).toBe(1);
    const workflowCopy = JSON.parse(
      await readFile(join(initial.sessionDir, "workflow-copy.json"), "utf8"),
    ) as { copy: { catalog_id: string } };

    backend.calls.length = 0;
    backend.operationTargets.length = 0;
    const recovered = await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(applyCalls).toBe(1);
    expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
    expect(backend.operationTargets).toEqual([]);
    const reports = await recoveryReportPaths(initial.sessionDir);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("insufficient");
    expect(report.operation_evidence_status).toBe("insufficient");
    expect(report.copy_creation_retried).toBe(false);
    expect(report.mutation_retried).toBe(false);
    expect(report.reason).toMatch(/develop.iteration.*uncertain/i);
    expect(report.workflow_copy).toMatchObject({
      copy: { catalog_id: workflowCopy.copy.catalog_id },
    });
    expect(report.checkpoint_artifacts).toEqual(
      expect.arrayContaining([expect.stringMatching(/checkpoints[\\/]iteration-1-before\.json$/)]),
    );
    expect(report.operation_artifacts).toEqual(
      expect.arrayContaining([expect.stringMatching(/operations[\\/]iteration-1-intent\.json$/)]),
    );
    expect(report.readback_artifacts).toEqual([]);
    expect(report.read_back).toMatchObject({
      photo_id: workflowCopy.copy.catalog_id,
      develop_settings: { Exposure2012: 0.2 },
    });
  });

  it("preserves checkpoint intent when checkpoint response is uncertain and never retries it", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const createCheckpoint = backend.createCheckpoint.bind(backend);
    let checkpointCalls = 0;
    backend.createCheckpoint = async (photoId, name, settings) => {
      checkpointCalls += 1;
      await createCheckpoint(photoId, name, settings);
      throw new Error("simulated timeout after Checkpoint side effect");
    };
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");
    expect(checkpointCalls).toBe(1);

    backend.calls.length = 0;
    backend.operationTargets.length = 0;
    await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(checkpointCalls).toBe(1);
    expect(backend.calls).toEqual(["connect", "handshake", "read_current_edit", "close"]);
    expect(backend.operationTargets).toEqual([]);
    const reports = await recoveryReportPaths(initial.sessionDir);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("insufficient");
    expect(report.operation_evidence_status).toBe("insufficient");
    expect(report.reason).toMatch(/develop.iteration.*uncertain/i);
    expect(report.operation_artifacts).toEqual([
      expect.stringMatching(/operations[\\/]iteration-1-intent\.json$/),
    ]);
    expect(report.checkpoint_artifacts).toEqual([]);
    expect(report.readback_artifacts).toEqual([]);
    expect(report.read_back?.photo_id).toMatch(/^mock-copy-/);
  });

  it("recovers the exact recorded Copy without changing durable Copy or checkpoint evidence", async () => {
    const { root, raw, preview } = await fixturePair();
    const sessionRoot = join(root, "sessions");
    const backend = new MockBackend(raw);
    const readTargets: string[] = [];
    let intentObservedBeforeCheckpoint: unknown;
    const readCurrentEdit = backend.readCurrentEdit.bind(backend);
    const createCheckpoint = backend.createCheckpoint.bind(backend);
    backend.readCurrentEdit = async (photoId) => {
      readTargets.push(photoId);
      return readCurrentEdit(photoId);
    };
    backend.createCheckpoint = async (photoId, name, settings) => {
      const sessionEntry = (await readdir(sessionRoot, { withFileTypes: true })).find((entry) =>
        entry.isDirectory(),
      );
      intentObservedBeforeCheckpoint = JSON.parse(
        await readFile(
          join(sessionRoot, sessionEntry!.name, "operations", "iteration-1-intent.json"),
          "utf8",
        ),
      ) as unknown;
      return createCheckpoint(photoId, name, settings);
    };
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot,
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");

    const copyPath = join(initial.sessionDir, "workflow-copy.json");
    const copyIntentPath = join(initial.sessionDir, "workflow-copy-intent.json");
    const operationIntentPath = join(
      initial.sessionDir,
      "operations",
      "iteration-1-intent.json",
    );
    const checkpointPath = join(
      initial.sessionDir,
      "checkpoints",
      "iteration-1-before.json",
    );
    const readbackPath = join(initial.sessionDir, "backend-readback-iteration-1.json");
    const workflowCopyBytes = await readFile(copyPath);
    const checkpointBytes = await readFile(checkpointPath);
    const workflowCopy = JSON.parse(workflowCopyBytes.toString("utf8")) as {
      copy: {
        catalog_id: string;
        uuid: string;
        master_id: string;
        master_uuid: string;
        is_virtual_copy: true;
      };
    };
    const copyIntent = JSON.parse(await readFile(copyIntentPath, "utf8")) as unknown;
    const operationIntent = JSON.parse(await readFile(operationIntentPath, "utf8")) as {
      operation_id: string;
      target: unknown;
      checkpoint_name: string;
      requested_settings: Record<string, unknown>;
    };
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
      operation_id: string;
    };
    const readback = JSON.parse(await readFile(readbackPath, "utf8")) as {
      operation_id: string;
    };
    expect(operationIntent.operation_id).toEqual(expect.any(String));
    expect(operationIntent.target).toEqual(workflowCopy.copy);
    expect(operationIntent.checkpoint_name).toMatch(/iteration_1_before$/);
    expect(operationIntent.requested_settings).toMatchObject({ Exposure2012: 0.2 });
    expect(intentObservedBeforeCheckpoint).toEqual(operationIntent);
    expect(checkpoint.operation_id).toBe(operationIntent.operation_id);
    expect(readback.operation_id).toBe(operationIntent.operation_id);

    backend.calls.length = 0;
    backend.operationTargets.length = 0;
    readTargets.length = 0;
    const recovered = await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(readTargets).toEqual([workflowCopy.copy.catalog_id]);
    expect(readTargets).not.toContain(raw);
    expect(backend.calls).not.toContain("create_workflow_copy");
    expect(backend.calls).not.toContain("create_checkpoint");
    expect(backend.calls).not.toContain("apply_global_adjustment");
    expect(backend.calls).not.toContain("render_preview");
    expect(backend.operationTargets).toEqual([]);

    const firstReports = await recoveryReportPaths(initial.sessionDir);
    expect(firstReports).toHaveLength(1);
    const firstReportBytes = await readFile(firstReports[0]!);
    const firstReport = JSON.parse(firstReportBytes.toString("utf8")) as RecoveryReportFixture;
    expect(firstReport.evidence_status).toBe("consistent");
    expect(firstReport.reason).toMatch(/recorded.workflow.copy.*(reconcil|consistent)/i);
    expect(firstReport.workflow_copy_intent).toEqual(copyIntent);
    expect(firstReport.workflow_copy).toEqual(workflowCopy);
    expect(firstReport.checkpoint_artifacts).toEqual(
      expect.arrayContaining([expect.stringMatching(/checkpoints[\\/]iteration-1-before\.json$/)]),
    );
    expect(firstReport.operation_artifacts).toEqual(
      expect.arrayContaining([expect.stringMatching(/operations[\\/]iteration-1-intent\.json$/)]),
    );
    expect(firstReport.read_back?.photo_id).toBe(workflowCopy.copy.catalog_id);
    expect(firstReport.read_back?.identity).toMatchObject({
      catalog_id: workflowCopy.copy.catalog_id,
      uuid: workflowCopy.copy.uuid,
    });
    expect(await readFile(copyPath)).toEqual(workflowCopyBytes);
    expect(await readFile(checkpointPath)).toEqual(checkpointBytes);

    await recoverSession({ sessionDir: initial.sessionDir, backend });
    const secondReports = await recoveryReportPaths(initial.sessionDir);
    expect(secondReports).toHaveLength(2);
    expect(secondReports[1]).not.toBe(secondReports[0]);
    expect(await readFile(firstReports[0]!)).toEqual(firstReportBytes);
    expect(await readFile(copyPath)).toEqual(workflowCopyBytes);
    expect(await readFile(checkpointPath)).toEqual(checkpointBytes);
  });

  it("reports contradictory recorded Copy identity without mutating or overwriting evidence", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");
    const copyPath = join(initial.sessionDir, "workflow-copy.json");
    const checkpointPath = join(
      initial.sessionDir,
      "checkpoints",
      "iteration-1-before.json",
    );
    const copyBytes = await readFile(copyPath);
    const checkpointBytes = await readFile(checkpointPath);
    const workflowCopy = JSON.parse(copyBytes.toString("utf8")) as {
      copy: { catalog_id: string };
    };
    const readCurrentEdit = backend.readCurrentEdit.bind(backend);
    backend.readCurrentEdit = async (photoId) => {
      const current = await readCurrentEdit(photoId);
      return {
        ...current,
        identity: current.identity
          ? { ...current.identity, uuid: "contradictory-backend-copy-uuid" }
          : current.identity,
      };
    };
    backend.calls.length = 0;
    backend.operationTargets.length = 0;

    const recovered = await recoverSession({ sessionDir: initial.sessionDir, backend });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).not.toContain("create_workflow_copy");
    expect(backend.calls).not.toContain("create_checkpoint");
    expect(backend.calls).not.toContain("apply_global_adjustment");
    expect(backend.calls).not.toContain("render_preview");
    expect(backend.operationTargets).toEqual([]);
    const reports = await recoveryReportPaths(initial.sessionDir);
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("contradictory");
    expect(report.reason).toMatch(/contradict|mismatch/i);
    expect(report.read_back).toMatchObject({
      photo_id: workflowCopy.copy.catalog_id,
      identity: {
        catalog_id: workflowCopy.copy.catalog_id,
        uuid: "contradictory-backend-copy-uuid",
      },
    });
    expect(await readFile(copyPath)).toEqual(copyBytes);
    expect(await readFile(checkpointPath)).toEqual(checkpointBytes);
  });

  it("fails closed before backend access when recovery photoId contradicts the recorded Copy", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const initial = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(initial.state).toBe("REVIEW_REQUIRED");
    const workflowCopy = JSON.parse(
      await readFile(join(initial.sessionDir, "workflow-copy.json"), "utf8"),
    ) as { copy: { catalog_id: string } };
    backend.calls.length = 0;
    backend.operationTargets.length = 0;

    const recovered = await recoverSession({
      sessionDir: initial.sessionDir,
      backend,
      photoId: `${workflowCopy.copy.catalog_id}-different`,
    });

    expect(recovered.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual([]);
    expect(backend.operationTargets).toEqual([]);
    const reports = await recoveryReportPaths(initial.sessionDir);
    expect(reports).toHaveLength(1);
    const report = JSON.parse(await readFile(reports[0]!, "utf8")) as RecoveryReportFixture;
    expect(report.evidence_status).toBe("contradictory");
    expect(report.reason).toMatch(/photo.?id.*recorded.(identity|workflow.copy)/i);
    expect(report.read_back).toBeNull();
  });

  it("writes a deterministic XMP sidecar and refuses overwrite", async () => {
    const { root } = await fixturePair();
    const destination = join(root, "exports", "sample.xmp");
    const settings = { Exposure2012: 0.4, Temperature: 4950, WhiteBalance: "Custom" };
    const content = createXmpSidecar(settings);
    expect(content).toContain('crs:Exposure2012="0.4"');
    expect(content).toContain('crs:Temperature="4950"');
    await expect(writeXmpSidecar(destination, settings)).resolves.toBe(destination);
    await expect(writeXmpSidecar(destination, settings)).rejects.toThrow();
  });
});
