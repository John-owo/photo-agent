import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { applyPropagationPlan, runRepresentativeEdits } from "../src/batch-edit.js";
import {
  ConservativeShootAnalyzer,
  createSafePropagationPlan,
  createShootSession,
  indexShoot,
  loadReviewedShootAnalyzer,
  resumeShootDryRun,
  runShootDryRun,
} from "../src/batch.js";
import { AcceptingMockEvaluator, ScriptedEvaluator } from "../src/evaluation.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { MockProvider } from "../src/providers.js";
import type { EvaluationResult, ShootAnalyzer } from "../src/types.js";
import { runSinglePhoto } from "../src/workflow.js";

async function pair(root: string, stem = "sample"): Promise<{ raw: string; preview: string }> {
  const raw = join(root, `${stem}.NEF`);
  const preview = join(root, `${stem}.JPG`);
  await writeFile(raw, `synthetic raw ${stem}`, "utf8");
  await writeFixtureJpeg(preview);
  return { raw, preview };
}

const refinementPlan = {
  schema_version: "0.1.0" as const,
  operations: [
    {
      parameter: "exposure_ev" as const,
      mode: "delta" as const,
      value: -0.2,
      confidence: 0.9,
      rationale: "Fixture refinement",
    },
  ],
  warnings: [],
};

function refinement(rationale = "Refine once"): EvaluationResult {
  return {
    schema_version: "0.2.0",
    verdict: "refine",
    confidence: 0.9,
    rationale,
    issues: ["Exposure needs a small correction"],
    refinement_plan: refinementPlan,
    usage: { evaluator_calls: 1, total_tokens: 25, estimated_cost_usd: 0.001 },
  };
}

describe("v0.2 closed-loop editing", () => {
  it("requires explicit cloud opt-in and sanitizes evaluator renders", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v02-cloud-eval-"));
    const { raw, preview } = await pair(root);
    let receivedPath = "";
    const evaluator = {
      name: "cloud-fixture",
      requiresCloudPreview: true,
      evaluate: async (input: { renderPath: string; iteration: number }) => {
        receivedPath = input.renderPath;
        return {
          schema_version: "0.2.0" as const,
          verdict: "accept" as const,
          confidence: 0.9,
          rationale: "cloud fixture accepted",
          issues: [],
        };
      },
    };
    await expect(
      runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: new MockProvider(),
        backend: new MockBackend(raw),
        evaluator,
        sessionRoot: join(root, "blocked"),
        apply: true,
        allowCloudPreview: false,
      }),
    ).rejects.toThrow("evaluator requires --allow-cloud-preview");
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator,
      sessionRoot: join(root, "allowed"),
      apply: true,
      allowCloudPreview: true,
    });
    expect(result.state).toBe("ACCEPTED");
    expect(receivedPath).toMatch(/evaluations[\\/]iteration-1-analysis\.jpg$/);
    expect((await readFile(receivedPath)).length).toBeGreaterThan(0);
  });

  it("accepts an evaluated render and records iteration cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v02-"));
    const { raw, preview } = await pair(root);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new AcceptingMockEvaluator(),
      maxIterations: 3,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("ACCEPTED");
    expect(result.iterations).toBe(1);
    expect(await readFile(join(result.sessionDir, "iteration-report.json"), "utf8")).toContain(
      '"reason": "accepted"',
    );
  });

  it("refines once, re-renders, and then accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v02-"));
    const { raw, preview } = await pair(root);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([
        refinement(),
        {
          schema_version: "0.2.0",
          verdict: "accept",
          confidence: 0.9,
          rationale: "Refinement is acceptable",
          issues: [],
          usage: { evaluator_calls: 1, total_tokens: 20 },
        },
      ]),
      maxIterations: 3,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("ACCEPTED");
    expect(result.iterations).toBe(2);
    expect(await readFile(join(result.sessionDir, "session.log"), "utf8")).toContain(
      '"state":"REFINING"',
    );
  });

  it("escalates a repeated refinement instead of silently retrying", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v02-"));
    const { raw, preview } = await pair(root);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([refinement(), refinement("Repeated refinement")]),
      maxIterations: 3,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(result.iterations).toBe(2);
    expect(await readFile(join(result.sessionDir, "iteration-report.json"), "utf8")).toContain(
      "closed_loop_stalled",
    );
  });
});

describe("v0.3 shoot workflow", () => {
  it("requires cloud opt-in and sanitizes shoot-analyzer previews", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-cloud-"));
    await pair(root, "CLOUD_1");
    const created = await createShootSession({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
    });
    let receivedPath = "";
    const analyzer: ShootAnalyzer = {
      requiresCloudPreview: true,
      cull: async (asset) => {
        receivedPath = asset.preview_path ?? "";
        return { selection_status: "review", confidence: 0.5, rationale: "cloud fixture" };
      },
      classify: async () => ({
        lighting_type: "unknown",
        confidence: 0.5,
        rationale: "cloud fixture",
      }),
    };
    const blockedSessionRoot = join(root, "blocked-sessions");
    await expect(
      runShootDryRun({ shootRoot: root, sessionRoot: blockedSessionRoot, analyzer }),
    ).rejects.toThrow("shoot analyzer requires --allow-cloud-preview");
    await expect(access(blockedSessionRoot)).rejects.toThrow();
    await expect(resumeShootDryRun({ sessionDir: created.sessionDir, analyzer })).rejects.toThrow(
      "shoot analyzer requires --allow-cloud-preview",
    );
    const result = await resumeShootDryRun({
      sessionDir: created.sessionDir,
      analyzer,
      allowCloudPreview: true,
    });
    expect(result.manifest.summary.analyzed_jobs).toBe(1);
    expect(receivedPath).toMatch(/inputs[\\/][a-f0-9]{64}\.jpg$/);
    expect((await readFile(receivedPath)).length).toBeGreaterThan(0);
  });

  it("writes a resumable cancelled manifest for a partial shoot", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-cancelled-shoot-"));
    await pair(root, "cancel_1");
    await pair(root, "cancel_2");
    await pair(root, "cancel_3");
    const controller = new AbortController();
    let calls = 0;
    const analyzer: ShootAnalyzer = {
      cull: async () => {
        calls += 1;
        if (calls === 2) controller.abort("fixture shoot cancellation");
        return { selection_status: "keep", confidence: 0.9, rationale: "cancellation fixture" };
      },
      classify: async () => ({
        lighting_type: "daylight",
        confidence: 0.9,
        rationale: "cancellation fixture",
      }),
    };
    const cancelled = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer,
      signal: controller.signal,
    });
    expect(cancelled.manifest.status).toBe("CANCELLED");
    expect(cancelled.manifest.decisions).toHaveLength(1);
    expect(cancelled.manifest.pending_asset_ids).toHaveLength(2);
    expect(cancelled.manifest.status_reason).toContain("Workflow cancelled during read_only");
    expect(
      JSON.parse(await readFile(join(cancelled.sessionDir, "cancellation.json"), "utf8")),
    ).toMatchObject({
      phase: "read_only",
      pending_asset_ids: cancelled.manifest.pending_asset_ids,
    });
    const resumed = await resumeShootDryRun({
      sessionDir: cancelled.sessionDir,
      analyzer: {
        cull: async () => ({
          selection_status: "keep",
          confidence: 0.9,
          rationale: "resume fixture",
        }),
        classify: async () => ({
          lighting_type: "daylight",
          confidence: 0.9,
          rationale: "resume fixture",
        }),
      },
    });
    expect(resumed.manifest.status).toBe("COMPLETED");
    expect(resumed.manifest.pending_asset_ids).toEqual([]);
    expect(resumed.manifest.summary.resumed_jobs).toBe(1);
    expect(resumed.manifest.summary.analyzed_jobs).toBe(2);
  });

  it("refuses ambiguous or missing RAW/preview mappings", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-"));
    await pair(root, "paired");
    await writeFile(join(root, "missing.NEF"), "missing preview", "utf8");
    await writeFile(join(root, "ambiguous.NEF"), "ambiguous", "utf8");
    await writeFixtureJpeg(join(root, "ambiguous.JPG"));
    await writeFixtureJpeg(join(root, "ambiguous.PNG"));
    const assets = await indexShoot(root);
    expect(assets.find((item) => item.relative_raw_path === "paired.NEF")?.source_confidence).toBe(
      "high",
    );
    expect(assets.find((item) => item.relative_raw_path === "missing.NEF")?.source_confidence).toBe(
      "missing_preview",
    );
    expect(
      assets.find((item) => item.relative_raw_path === "ambiguous.NEF")?.source_confidence,
    ).toBe("ambiguous");
  });

  it("preserves local metadata and non-ASCII relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-metadata-"));
    const folder = join(root, "婚禮");
    await mkdir(folder, { recursive: true });
    const { raw } = await pair(folder, "相片_0001");
    await writeFile(
      raw + ".xmp",
      '<x:xmpmeta><rdf:Description tiff:Make="NIKON CORPORATION" tiff:Model="NIKON Z 8" exif:DateTimeOriginal="2026:08:31 12:34:56" aux:Lens="NIKKOR Z 24-70mm f/2.8 S" /></x:xmpmeta>',
      "utf8",
    );
    const [asset] = await indexShoot(root);
    expect(asset?.relative_raw_path).toBe("婚禮/相片_0001.NEF");
    expect(asset?.capture_time).toBe("2026:08:31 12:34:56");
    expect(asset?.camera).toBe("NIKON CORPORATION NIKON Z 8");
    expect(asset?.lens).toBe("NIKKOR Z 24-70mm f/2.8 S");
    expect(asset?.width).toBe(1);
    expect(asset?.height).toBe(1);
    expect(asset?.ingestion_errors).toEqual([]);
  });

  it("isolates corrupt previews while completing readable assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-corrupt-"));
    await pair(root, "readable");
    await writeFile(join(root, "corrupt.NEF"), "corrupt raw", "utf8");
    await writeFile(join(root, "corrupt.JPG"), "not an image", "utf8");
    const calls: string[] = [];
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer: {
        cull: async (asset) => {
          calls.push(asset.relative_raw_path);
          return { selection_status: "select", confidence: 0.9, rationale: "readable fixture" };
        },
        classify: async () => ({
          lighting_type: "daylight",
          confidence: 0.9,
          rationale: "readable fixture",
        }),
      },
    });
    const corrupt = result.manifest.assets.find(
      (asset) => asset.relative_raw_path === "corrupt.NEF",
    );
    expect(corrupt?.ingestion_errors.some((item) => item.source === "preview")).toBe(true);
    expect(result.manifest.summary.input).toBe(2);
    expect(result.manifest.summary.select).toBe(1);
    expect(result.manifest.summary.review).toBe(1);
    expect(result.manifest.summary.failed).toBe(0);
    expect(calls).toEqual(["readable.NEF"]);
  });

  it("keeps low-confidence and configured high-value rejects in review", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-culling-policy-"));
    await pair(root, "ordinary");
    await pair(root, "important");
    const indexed = await indexShoot(root);
    const importantId = indexed.find((asset) => asset.relative_raw_path === "important.NEF")?.id;
    expect(importantId).toBeTruthy();
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer: {
        cull: async (asset) => ({
          selection_status: "reject",
          confidence: asset.relative_raw_path.startsWith("ordinary") ? 0.4 : 0.95,
          rationale: "policy fixture",
          evidence: { technical: ["fixture sharpness"], aesthetic: ["fixture value"] },
        }),
        classify: async () => ({
          lighting_type: "daylight",
          confidence: 0.9,
          rationale: "policy fixture",
        }),
      },
      highValueAssetIds: [importantId!],
    });
    expect(result.manifest.summary.reject).toBe(0);
    expect(result.manifest.summary.review).toBe(2);
    expect(result.manifest.assets.find((asset) => asset.id === importantId)?.high_value).toBe(true);
    expect(
      result.manifest.decisions.every((item) => item.culling.selection_status === "review"),
    ).toBe(true);
    expect(result.manifest.decisions[0]?.culling.evidence).toEqual({
      technical: ["fixture sharpness"],
      aesthetic: ["fixture value"],
    });
  });

  it("leaves weak lighting unclustered and marks culling outliers", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-cluster-boundaries-"));
    await pair(root, "good");
    await pair(root, "outlier");
    await pair(root, "mixed");
    await pair(root, "weak");
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer: {
        cull: async (asset) => ({
          selection_status: asset.relative_raw_path === "outlier.NEF" ? "review" : "keep",
          confidence: asset.relative_raw_path === "outlier.NEF" ? 0.5 : 0.9,
          rationale: "cluster boundary fixture",
        }),
        classify: async (asset) => ({
          lighting_type:
            asset.relative_raw_path === "mixed.NEF"
              ? "mixed"
              : asset.relative_raw_path === "weak.NEF"
                ? "daylight"
                : "daylight",
          confidence: asset.relative_raw_path === "weak.NEF" ? 0.4 : 0.9,
          rationale: "cluster boundary fixture",
        }),
      },
    });
    const daylight = result.manifest.clusters.find(
      (cluster) => cluster.lighting_type === "daylight",
    );
    expect(daylight?.member_ids).toHaveLength(2);
    expect(daylight?.outlier_ids).toHaveLength(1);
    expect(daylight?.representative_id).toBeTruthy();
    expect(result.manifest.unclustered_asset_ids).toHaveLength(2);
    expect(result.manifest.unclustered_asset_ids).toEqual(
      expect.arrayContaining([
        result.manifest.assets.find((asset) => asset.relative_raw_path === "mixed.NEF")?.id,
        result.manifest.assets.find((asset) => asset.relative_raw_path === "weak.NEF")?.id,
      ]),
    );
  });

  it("reports exact duplicate RAW content without cleanup authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-duplicates-"));
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await pair(first, "same");
    await pair(second, "same");
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer: new ConservativeShootAnalyzer(),
    });
    expect(result.manifest.duplicate_groups).toHaveLength(1);
    expect(result.manifest.duplicate_groups[0]?.asset_ids).toHaveLength(2);
    expect(new Set(result.manifest.duplicate_groups[0]?.asset_ids).size).toBe(2);
    expect(result.manifest.near_duplicate_groups).toHaveLength(1);
    expect(result.manifest.near_duplicate_groups[0]?.ranked_asset_ids).toHaveLength(2);
    expect(await access(join(first, "same.NEF"))).toBeUndefined();
    expect(await access(join(second, "same.NEF"))).toBeUndefined();
  });

  it("processes 120 pairs with isolated jobs and a resumable report layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-"));
    for (let index = 0; index < 120; index += 1) {
      await pair(root, `DSC_${String(index).padStart(4, "0")}`);
    }
    const analyzer: ShootAnalyzer = {
      cull: async (asset) => {
        if (asset.relative_raw_path === "DSC_0060.NEF") throw new Error("fixture analyzer failure");
        return {
          selection_status: asset.relative_raw_path.endsWith("0.NEF") ? "select" : "review",
          confidence: 0.8,
          rationale: "Deterministic test decision only",
        };
      },
      classify: async () => ({
        lighting_type: "daylight",
        confidence: 0.8,
        rationale: "Deterministic test classification only",
      }),
    };
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer,
    });
    expect(result.manifest.summary.input).toBe(120);
    expect(result.manifest.summary.failed).toBe(1);
    expect(result.manifest.decisions).toHaveLength(120);
    expect(result.manifest.burst_groups).toHaveLength(1);
    expect(result.manifest.burst_groups[0]?.ranked_asset_ids).toHaveLength(120);
    expect(result.manifest.burst_groups[0]?.ranking_rationale).toContain("culling status");
    expect(result.manifest.near_duplicate_groups.length).toBeGreaterThan(0);
    expect(await readFile(join(result.sessionDir, "culling.csv"), "utf8")).toContain(
      "selection_status".replace("selection_", ""),
    );
    expect(await readFile(join(result.sessionDir, "clusters.json"), "utf8")).toContain("daylight");
  }, 30_000);

  it("resumes durable jobs without re-running completed work", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-resume-"));
    for (let index = 0; index < 3; index += 1) await pair(root, `IMG_${index + 1}`);
    const created = await createShootSession({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
    });
    const first = created.plan.assets[0]!;
    await writeFile(
      join(created.sessionDir, "jobs", `${first.id}.json`),
      JSON.stringify({
        asset_id: first.id,
        culling: { selection_status: "keep", confidence: 0.9, rationale: "pre-crash job" },
        lighting: { lighting_type: "shade", confidence: 0.9, rationale: "pre-crash job" },
        state: "completed",
      }),
      "utf8",
    );
    let analyzed = 0;
    const analyzer: ShootAnalyzer = {
      cull: async () => {
        analyzed += 1;
        return { selection_status: "review", confidence: 0.5, rationale: "resumed fixture" };
      },
      classify: async () => ({
        lighting_type: "shade",
        confidence: 0.8,
        rationale: "resumed fixture",
      }),
    };
    const resumed = await resumeShootDryRun({ sessionDir: created.sessionDir, analyzer });
    expect(resumed.manifest.summary.resumed_jobs).toBe(1);
    expect(resumed.manifest.summary.analyzed_jobs).toBe(2);
    expect(analyzed).toBe(2);
    const secondResume = await resumeShootDryRun({ sessionDir: created.sessionDir, analyzer });
    expect(secondResume.manifest.summary.resumed_jobs).toBe(3);
    expect(secondResume.manifest.summary.analyzed_jobs).toBe(0);
    expect(analyzed).toBe(2);
  });

  it("builds an explicit safe propagation plan only for shortlisted cluster members", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-propagate-"));
    for (let index = 1; index <= 4; index += 1) await pair(root, `DSC_${index}`);
    const analyzer: ShootAnalyzer = {
      cull: async (asset) => ({
        selection_status: asset.relative_raw_path.includes("_3.") ? "review" : "keep",
        confidence: asset.relative_raw_path.includes("_1.") ? 0.95 : 0.8,
        rationale: "propagation fixture",
      }),
      classify: async () => ({
        lighting_type: "daylight",
        confidence: 0.9,
        rationale: "propagation fixture",
      }),
    };
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer,
    });
    const propagation = createSafePropagationPlan({
      manifest: result.manifest,
      clusterId: "cluster-001",
      representativePlan: {
        schema_version: "0.1.0",
        operations: [
          {
            parameter: "exposure_ev",
            mode: "delta",
            value: 0.2,
            confidence: 0.9,
            rationale: "safe global fixture",
          },
          {
            parameter: "temperature_k",
            mode: "delta",
            value: 250,
            confidence: 0.9,
            rationale: "must not propagate without WB logic",
          },
        ],
        warnings: [],
      },
      allowedParameters: ["exposure_ev", "temperature_k"],
    });
    expect(propagation.operation_parameters).toEqual(["exposure_ev"]);
    expect(propagation.targets).toHaveLength(2);
    expect(propagation.excluded).toHaveLength(1);
    expect(propagation.excluded[0]?.reason).toBe("cluster_outlier");
    expect(propagation.requires_explicit_apply).toBe(true);

    const representatives = await runRepresentativeEdits({
      manifest: result.manifest,
      sessionRoot: join(root, "representatives"),
      providerFactory: () => new MockProvider(),
      backendFactory: (asset) => new MockBackend(asset.raw_path),
      evaluatorFactory: () => new AcceptingMockEvaluator(),
      apply: true,
      allowCloudPreview: false,
      maxIterations: 3,
    });
    expect(representatives).toHaveLength(1);
    expect(representatives[0]?.state).toBe("ACCEPTED");
    const resumedRepresentatives = await runRepresentativeEdits({
      manifest: result.manifest,
      sessionRoot: join(root, "representatives"),
      providerFactory: () => {
        throw new Error("accepted representative must not be rerun");
      },
      backendFactory: () => {
        throw new Error("accepted representative backend must not be recreated");
      },
      apply: true,
      allowCloudPreview: false,
      maxIterations: 3,
    });
    expect(resumedRepresentatives[0]?.state).toBe("ACCEPTED");
    expect(resumedRepresentatives[0]?.result?.state).toBe("ACCEPTED");
    const representativeJobPath = join(root, "representatives", "jobs", "cluster-001.json");
    const runningJob = JSON.parse(await readFile(representativeJobPath, "utf8")) as Record<
      string,
      unknown
    >;
    runningJob.state = "RUNNING";
    runningJob.workflow_session_root = join(root, "missing-workflow-root");
    delete runningJob.result;
    await writeFile(representativeJobPath, JSON.stringify(runningJob), "utf8");
    const interruptedRepresentatives = await runRepresentativeEdits({
      manifest: result.manifest,
      sessionRoot: join(root, "representatives"),
      providerFactory: () => {
        throw new Error("incomplete representative must not be rerun");
      },
      backendFactory: () => {
        throw new Error("incomplete representative backend must not be recreated");
      },
      apply: true,
      allowCloudPreview: false,
      maxIterations: 3,
    });
    expect(interruptedRepresentatives[0]?.state).toBe("REVIEW_REQUIRED");
    expect(interruptedRepresentatives[0]?.reason).toBe(
      "incomplete_representative_requires_recovery",
    );
    await expect(
      applyPropagationPlan({
        manifest: result.manifest,
        plan: propagation,
        sessionDir: result.sessionDir,
        backendFactory: (asset) => new MockBackend(asset.raw_path),
        confirmApply: false,
        representativeResults: representatives,
      }),
    ).rejects.toThrow("confirmApply=true");
    await expect(
      applyPropagationPlan({
        manifest: result.manifest,
        plan: propagation,
        sessionDir: result.sessionDir,
        backendFactory: (asset) => new MockBackend(asset.raw_path),
        confirmApply: true,
        representativeResults: [],
      }),
    ).rejects.toThrow("ACCEPTED representative");
    const forgedOperationsPlan = {
      ...propagation,
      operation_parameters: [...propagation.operation_parameters, "temperature_k" as const],
      targets: propagation.targets.map((target) => ({
        ...target,
        operations: [
          ...target.operations,
          {
            parameter: "temperature_k" as const,
            mode: "delta" as const,
            value: 250,
            confidence: 0.9,
            rationale: "forged context-sensitive operation",
          },
        ],
      })),
    };
    await expect(
      applyPropagationPlan({
        manifest: result.manifest,
        plan: forgedOperationsPlan,
        sessionDir: result.sessionDir,
        backendFactory: () => {
          throw new Error("registry rejection must happen before backend creation");
        },
        confirmApply: true,
        representativeResults: representatives,
      }),
    ).rejects.toThrow("not authorized by the parameter registry");
    const propagationBackends: MockBackend[] = [];
    const applied = await applyPropagationPlan({
      manifest: result.manifest,
      plan: propagation,
      sessionDir: result.sessionDir,
      backendFactory: (asset) => {
        const backend = new MockBackend(asset.raw_path);
        propagationBackends.push(backend);
        return backend;
      },
      confirmApply: true,
      representativeResults: representatives,
    });
    expect(applied.map((item) => item.state)).toEqual(["APPLIED", "APPLIED"]);
    expect(propagationBackends).toHaveLength(2);
    for (const backend of propagationBackends) {
      expect(backend.calls).toEqual([
        "connect",
        "handshake",
        "read_current_edit",
        "create_workflow_copy",
        "read_current_edit",
        "create_checkpoint",
        "apply_global_adjustment",
        "read_current_edit",
        "close",
      ]);
    }
    expect(applied.every((item) => item.workflow_copy_verified === true)).toBe(true);
    const stoppedBackends: MockBackend[] = [];
    const stopped = await applyPropagationPlan({
      manifest: result.manifest,
      plan: propagation,
      sessionDir: result.sessionDir,
      backendFactory: (asset) => {
        const backend = new MockBackend(asset.raw_path);
        stoppedBackends.push(backend);
        if (stoppedBackends.length === 1) {
          backend.createWorkflowCopy = async (
            _sourcePhotoId,
            _expectedSourceUuid,
            operationId,
          ) => ({
            operation_id: operationId,
            result: "REVIEW_REQUIRED",
            partial: false,
            selection_restoration: { status: "not_needed", verified: true },
            reason: "fixture shared uncertainty",
          });
        }
        return backend;
      },
      confirmApply: true,
      representativeResults: representatives,
    });
    expect(stopped.map((item) => item.state)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(stopped[1]?.reason).toContain("shared_backend_uncertainty");
    expect(stoppedBackends).toHaveLength(1);

    const closeFailureBackends: MockBackend[] = [];
    const closeFailure = await applyPropagationPlan({
      manifest: result.manifest,
      plan: propagation,
      sessionDir: result.sessionDir,
      backendFactory: (asset) => {
        const backend = new MockBackend(asset.raw_path);
        backend.close = async () => {
          backend.calls.push("close_failure");
          throw new Error("fixture close uncertainty");
        };
        closeFailureBackends.push(backend);
        return backend;
      },
      confirmApply: true,
      representativeResults: representatives,
    });
    expect(closeFailure.map((item) => item.state)).toEqual(["REVIEW_REQUIRED", "REVIEW_REQUIRED"]);
    expect(closeFailure[0]?.reason).toContain("backend_close_failed:fixture close uncertainty");
    expect(closeFailure[1]?.reason).toContain("shared_backend_uncertainty");
    expect(closeFailureBackends).toHaveLength(1);
  });

  it("uses a schema-validated review file without inventing missing decisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-review-file-"));
    await pair(root, "REVIEW_1");
    await pair(root, "REVIEW_2");
    const reviewPath = join(root, "review.json");
    await writeFile(
      reviewPath,
      JSON.stringify({
        schema_version: "0.3.0",
        decisions: [
          {
            relative_raw_path: "REVIEW_1.NEF",
            culling: { selection_status: "select", confidence: 0.9, rationale: "reviewed" },
            lighting: { lighting_type: "shade", confidence: 0.9, rationale: "reviewed" },
          },
        ],
      }),
      "utf8",
    );
    const result = await runShootDryRun({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
      analyzer: await loadReviewedShootAnalyzer(reviewPath),
    });
    expect(result.manifest.summary.select).toBe(1);
    expect(result.manifest.summary.review).toBe(1);
    expect(
      result.manifest.clusters.find((item) => item.lighting_type === "shade")?.representative_id,
    ).toBeTruthy();
  });

  it("rejects unknown, duplicate, and mismatched reviewed asset references", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-v03-review-validation-"));
    await pair(root, "REVIEW_A");
    await pair(root, "REVIEW_B");
    const created = await createShootSession({
      shootRoot: root,
      sessionRoot: join(root, "sessions"),
    });
    const [first, second] = created.plan.assets;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const decision = {
      culling: { selection_status: "keep", confidence: 0.9, rationale: "validated" },
      lighting: { lighting_type: "daylight", confidence: 0.9, rationale: "validated" },
    };
    const writeReview = async (name: string, decisions: unknown[]) => {
      const reviewPath = join(root, name);
      await writeFile(reviewPath, JSON.stringify({ schema_version: "0.3.0", decisions }), "utf8");
      return loadReviewedShootAnalyzer(reviewPath);
    };
    await expect(
      resumeShootDryRun({
        sessionDir: created.sessionDir,
        analyzer: await writeReview("unknown.json", [{ ...decision, asset_id: "missing" }]),
      }),
    ).rejects.toThrow("unknown asset id");
    await expect(
      resumeShootDryRun({
        sessionDir: created.sessionDir,
        analyzer: await writeReview("duplicate.json", [
          { ...decision, asset_id: first!.id },
          { ...decision, relative_raw_path: first!.relative_raw_path },
        ]),
      }),
    ).rejects.toThrow("duplicate decision");
    await expect(
      resumeShootDryRun({
        sessionDir: created.sessionDir,
        analyzer: await writeReview("mismatch.json", [
          { ...decision, asset_id: first!.id, relative_raw_path: second!.relative_raw_path },
        ]),
      }),
    ).rejects.toThrow("different assets");
  });
});
