import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { ingestPair } from "../src/ingest.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { CodexProvider, MockProvider } from "../src/providers.js";
import { acquireMutationLock, SessionStore } from "../src/runtime.js";
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
    expect(await readFile(join(session.dir, "recovery-readback.json"), "utf8")).toContain(
      "interrupted_state",
    );
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
