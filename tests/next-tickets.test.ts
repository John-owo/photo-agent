import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { exportFinal } from "../src/delivery.js";
import { AcceptingMockEvaluator, ScriptedEvaluator } from "../src/evaluation.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { MockProvider } from "../src/providers.js";
import {
  PARAMETER_REGISTRY,
  PARAMETER_REGISTRY_VERSION,
  registeredParameters,
  selectPropagatableOperations,
  validateNormalizedPlan,
} from "../src/parameter-registry.js";
import { resolveLightroomSettings } from "../src/translator.js";
import type { EvaluationResult } from "../src/types.js";
import { runSinglePhoto } from "../src/workflow.js";

async function fixturePair(): Promise<{ root: string; raw: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-next-tickets-"));
  const raw = join(root, "sample.NEF");
  const preview = join(root, "sample.JPG");
  await writeFile(raw, "synthetic raw fixture", "utf8");
  await writeFixtureJpeg(preview);
  return { root, raw, preview };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const refinement: EvaluationResult = {
  schema_version: "0.2.0",
  verdict: "refine",
  confidence: 0.9,
  rationale: "One deterministic refinement is justified",
  issues: ["Exposure needs a small correction"],
  refinement_plan: {
    schema_version: "0.1.0",
    operations: [
      {
        parameter: "exposure_ev",
        mode: "delta",
        value: -0.2,
        confidence: 0.9,
        rationale: "Fixture refinement",
      },
    ],
    warnings: [],
  },
};

describe("T11 evaluated iteration evidence", () => {
  it("links an accepted evaluation to exact plan, readback, and render artifacts", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new AcceptingMockEvaluator(),
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("ACCEPTED");
    const evaluationPath = join(result.sessionDir, "evaluations", "iteration-1.json");
    const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
      operation_id: string;
      evidence: {
        render: { path: string; sha256: string };
        preview: { path: string; sha256: string };
        backend_render: { path: string; sha256: string };
        plan: { path: string; sha256: string };
        readback: { path: string; sha256: string };
      };
    };
    expect(evaluation.operation_id).toMatch(/^photoagent-iteration-/);
    for (const link of Object.values(evaluation.evidence)) {
      expect(link.sha256).toBe(await sha256(join(result.sessionDir, link.path)));
    }
    expect(evaluation.evidence.render.path).toBe("renders/iteration-1/preview.jpg");
    expect(evaluation.evidence.plan.path).toBe("plans/iteration-1.json");
    expect(evaluation.evidence.readback.path).toBe("backend-readback-iteration-1.json");

    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      terminal_state: string;
      iteration_records: Array<{
        state: string;
        evaluation?: { verdict: string; rationale: string };
      }>;
    };
    expect(report.terminal_state).toBe("ACCEPTED");
    expect(report.iteration_records).toHaveLength(1);
    expect(report.iteration_records[0]).toMatchObject({
      state: "ACCEPTED",
      evaluation: { verdict: "accept", rationale: expect.any(String) },
    });
  });

  it("records both sides of a refine-then-accept loop", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([
        refinement,
        {
          schema_version: "0.2.0",
          verdict: "accept",
          confidence: 0.9,
          rationale: "Refinement accepted",
          issues: [],
        },
      ]),
      maxIterations: 3,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("ACCEPTED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { iteration_records: Array<{ state: string; plan: { sha256: string } }> };
    expect(report.iteration_records.map((record) => record.state)).toEqual([
      "REFINING",
      "ACCEPTED",
    ]);
    expect(report.iteration_records[0]?.plan.sha256).not.toBe(
      report.iteration_records[1]?.plan.sha256,
    );
    await expect(
      access(join(result.sessionDir, "evaluations", "iteration-2.json")),
    ).resolves.toBeUndefined();
  });

  it("fails closed and records an evaluator failure", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: {
        name: "failing-fixture",
        requiresCloudPreview: false,
        evaluate: async () => {
          throw new Error("evaluator unavailable");
        },
      },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { reason: string; iteration_records: Array<{ state: string; error?: string }> };
    expect(report.reason).toBe("controller_error");
    expect(report.iteration_records[0]).toMatchObject({
      state: "REVIEW_REQUIRED",
      error: "evaluator unavailable",
    });
    expect(await readFile(join(result.sessionDir, "state.json"), "utf8")).toContain(
      "REVIEW_REQUIRED",
    );
  });
});

describe("T13 preview and final-export seam", () => {
  it("writes a session-only preview policy and deterministic sanitized artifact", async () => {
    const { root, raw, preview } = await fixturePair();
    const evaluator = {
      name: "path-fixture",
      requiresCloudPreview: false,
      evaluate: async (input: { renderPath: string }) => {
        expect(input.renderPath).toMatch(/renders[\\/]iteration-1[\\/]preview\.jpg$/);
        return {
          schema_version: "0.2.0" as const,
          verdict: "accept" as const,
          confidence: 0.9,
          rationale: "preview path is session scoped",
          issues: [],
        };
      },
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    const policy = JSON.parse(
      await readFile(join(result.sessionDir, "preview-policy.json"), "utf8"),
    ) as { preview: Record<string, unknown>; final_export: Record<string, unknown> };
    expect(policy.preview).toMatchObject({
      naming: "renders/iteration-{n}/preview.jpg",
      retention: "session",
      sanitized: true,
    });
    expect(policy.final_export).toMatchObject({
      availability: "explicit_only",
      requires_explicit_destination: true,
      requires_delivery_settings: true,
      preview_is_not_final: true,
    });
    const render = JSON.parse(
      await readFile(join(result.sessionDir, "render-iteration-1.json"), "utf8"),
    ) as { preview: { path: string; delivery_export: boolean } };
    expect(render.preview).toMatchObject({
      path: "renders/iteration-1/preview.jpg",
      delivery_export: false,
    });
  });

  it("requires an explicit destination and delivery settings for final export", async () => {
    const { root, raw } = await fixturePair();
    const backend = new MockBackend(raw);
    await backend.connect();
    await backend.handshake();
    const settings = {
      format: "jpeg" as const,
      quality: 90,
      width: 4000,
      height: 3000,
      filename: "sample-final.jpg",
    };
    await expect(exportFinal({ backend, photoId: raw, destination: "", settings })).rejects.toThrow(
      "explicit destination",
    );
    await expect(
      exportFinal({
        backend,
        photoId: raw,
        destination: join(root, "session", "renders"),
        sessionDir: join(root, "session"),
        settings,
      }),
    ).rejects.toThrow("session preview directory");
    await expect(
      exportFinal({
        backend,
        photoId: raw,
        destination: join(root, "delivery"),
        settings: { ...settings, filename: "../escape.jpg" },
      }),
    ).rejects.toThrow("single file name");
    const exported = await exportFinal({
      backend,
      photoId: raw,
      destination: join(root, "delivery"),
      settings,
    });
    expect(exported.path).toMatch(/sample-final\.jpg$/);
    await backend.close();
  });
});

describe("T16 baseline Parameter Registry", () => {
  it("covers every normalized baseline parameter with units and policy", () => {
    expect(Object.keys(PARAMETER_REGISTRY).sort()).toEqual([...registeredParameters()].sort());
    expect(PARAMETER_REGISTRY_VERSION).toBe("0.1.0");
    for (const definition of Object.values(PARAMETER_REGISTRY)) {
      expect(definition.unit).toBeTruthy();
      expect(definition.absolute_range[0]).toBeLessThan(definition.absolute_range[1]);
      expect(definition.delta_range[0]).toBeLessThan(definition.delta_range[1]);
      expect(definition.propagation.required_conditions).toBeDefined();
    }
    expect(PARAMETER_REGISTRY.temperature_k.propagation.eligible).toBe(false);
    expect(PARAMETER_REGISTRY.exposure_ev.propagation.eligible).toBe(true);
  });

  it("rejects out-of-range and conflicting operations before resolution", () => {
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        operations: [
          {
            parameter: "exposure_ev",
            mode: "delta",
            value: 6,
            confidence: 0.9,
            rationale: "too large",
          },
        ],
        warnings: [],
      }),
    ).toThrow(/outside/);
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        operations: [
          {
            parameter: "contrast",
            mode: "delta",
            value: 4,
            confidence: 0.9,
            rationale: "first",
          },
          {
            parameter: "contrast",
            mode: "absolute",
            value: 4,
            confidence: 0.9,
            rationale: "conflict",
          },
        ],
        warnings: [],
      }),
    ).toThrow(/Conflicting operations/);
  });

  it("preserves absolute and delta translator semantics while filtering propagation", () => {
    expect(
      resolveLightroomSettings(
        { Exposure2012: 0, Temperature: 5200, Tint: 0 },
        {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "exposure_ev",
              mode: "absolute",
              value: 1.25,
              confidence: 0.9,
              rationale: "absolute fixture",
            },
            {
              parameter: "temperature_k",
              mode: "delta",
              value: 250,
              confidence: 0.9,
              rationale: "white balance fixture",
            },
          ],
          warnings: [],
        },
      ),
    ).toEqual({ Exposure2012: 1.25, Temperature: 5450, WhiteBalance: "Custom" });
    expect(
      selectPropagatableOperations(
        {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "exposure_ev",
              mode: "delta",
              value: 0.2,
              confidence: 0.9,
              rationale: "propagate",
            },
            {
              parameter: "temperature_k",
              mode: "delta",
              value: 250,
              confidence: 0.9,
              rationale: "context sensitive",
            },
            {
              parameter: "contrast",
              mode: "delta",
              value: 8,
              confidence: 0.4,
              rationale: "low confidence",
            },
          ],
          warnings: [],
        },
        ["exposure_ev", "temperature_k", "contrast"],
      ).map((operation) => operation.parameter),
    ).toEqual(["exposure_ev"]);
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        parameter_registry_version: "9.9.9",
        operations: [],
        warnings: [],
      }),
    ).toThrow(/Unsupported parameter registry version/);
  });
});

describe("T12 workflow budgets", () => {
  it("stops before a render budget can start another iteration", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([refinement]),
      maxIterations: 3,
      budget: { maxRenders: 1 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      reason: string;
      render_count: number;
      budget: { max_renders: number };
      iteration_records: Array<{ state: string }>;
    };
    expect(report).toMatchObject({
      reason: "render_budget_exhausted",
      render_count: 1,
      budget: { max_renders: 1 },
    });
    expect(report.iteration_records.map((record) => record.state)).toEqual(["REFINING"]);
  });

  it("does not accept an evaluation that exceeds token or cost limits", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: {
        name: "over-budget-fixture",
        requiresCloudPreview: false,
        evaluate: async () => ({
          schema_version: "0.2.0" as const,
          verdict: "accept" as const,
          confidence: 0.99,
          rationale: "The fixture would otherwise be accepted",
          issues: [],
          usage: { evaluator_calls: 1, total_tokens: 101, estimated_cost_usd: 0.02 },
        }),
      },
      budget: { maxTotalTokens: 100, maxCostUsd: 0.01 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      reason: string;
      iterations: number;
      render_count: number;
      evaluator_calls: number;
      total_tokens: number;
      estimated_cost_usd: number;
      iteration_records: Array<{ state: string; error?: string }>;
    };
    expect(report).toMatchObject({
      reason: "token_budget_exhausted",
      iterations: 1,
      render_count: 1,
      evaluator_calls: 1,
      total_tokens: 101,
      estimated_cost_usd: 0.02,
    });
    expect(report.iteration_records[0]).toMatchObject({
      state: "REVIEW_REQUIRED",
      error: "token_budget_exhausted",
    });
  });

  it("records a zero-time budget as review without mutating the backend", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      budget: { maxElapsedMs: 0 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).not.toContain("create_workflow_copy");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { reason: string; iterations: number; render_count: number };
    expect(report).toMatchObject({
      reason: "time_budget_exhausted",
      iterations: 0,
      render_count: 0,
    });
  });
});
