import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { applyPropagationPlan, runRepresentativeEdits } from "../src/batch-edit.js";
import {
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
    expect(receivedPath).toMatch(/inputs[\\/][a-f0-9]{16}\.jpg$/);
    expect((await readFile(receivedPath)).length).toBeGreaterThan(0);
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
    await expect(
      applyPropagationPlan({
        manifest: result.manifest,
        plan: propagation,
        sessionDir: result.sessionDir,
        backendFactory: (asset) => new MockBackend(asset.raw_path),
        confirmApply: false,
      }),
    ).rejects.toThrow("confirmApply=true");
    const applied = await applyPropagationPlan({
      manifest: result.manifest,
      plan: propagation,
      sessionDir: result.sessionDir,
      backendFactory: (asset) => new MockBackend(asset.raw_path),
      confirmApply: true,
    });
    expect(applied.map((item) => item.state)).toEqual(["APPLIED", "APPLIED"]);
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
});
