import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, STYLE_HISTORY_EVALUATION_REGISTRY_VERSION } from "../src/schemas.js";
import { buildStyleHistorySnapshot } from "../src/style-history.js";
import {
  buildStyleHistoryEvaluationSplit,
  evaluateStyleHistoryHeldOut,
  runStyleHistoryEvaluationGoldenVectors,
} from "../src/style-history-evaluation.js";
import type {
  StyleHistoryEvaluationRequest,
  StyleHistoryEvaluationSplit,
  StyleHistoryExample,
  StylePerceptualProfile,
} from "../src/types.js";

const datasetSha256 = "a".repeat(64);
const splitSha256 = "b".repeat(64);

function profile(overrides: Partial<StylePerceptualProfile> = {}): StylePerceptualProfile {
  return {
    luminance: 0.1,
    contrast: 0.2,
    colorfulness: 0.15,
    warmth: 0.1,
    natural_skin_tones: true,
    ...overrides,
  };
}

function example(
  exampleId: string,
  shootId: string,
  context: StyleHistoryExample["context"],
  options: Partial<
    Pick<StyleHistoryExample, "confidence" | "failures" | "perceptual_profile" | "evidence">
  > = {},
): StyleHistoryExample {
  return {
    example_id: exampleId,
    shoot_id: shootId,
    context,
    perceptual_profile: options.perceptual_profile ?? profile(),
    evidence: options.evidence ?? [`review:${exampleId}`],
    confidence: options.confidence ?? 0.92,
    failures: options.failures ?? [],
  };
}

function split(): StyleHistoryEvaluationSplit {
  return buildStyleHistoryEvaluationSplit(
    "split-2026-08-31",
    "r1",
    splitSha256,
    ["shoot-construction", "shoot-construction-failed"],
    ["shoot-heldout", "shoot-heldout-failed", "shoot-heldout-empty"],
    ["shoot-excluded"],
  );
}

function request(
  overrides: Partial<StyleHistoryEvaluationRequest> = {},
): StyleHistoryEvaluationRequest {
  return {
    schema_version: SCHEMA_VERSION,
    evaluation_registry_version: STYLE_HISTORY_EVALUATION_REGISTRY_VERSION,
    evaluation_id: "style-memory-evaluation-001",
    split: split(),
    protected_attributes: ["natural_skin_tones"],
    max_results: 8,
    max_examples: 100,
    min_confidence: 0.65,
    ...overrides,
  };
}

function snapshot() {
  return buildStyleHistorySnapshot("style-memory", "revision-1", datasetSha256, [
    example("construction-safe", "shoot-construction", {
      lighting_type: "stage",
      subject_type: "portrait",
      camera: "Nikon Z8",
      lens: "85mm",
      iso: 800,
      delivery: "web",
    }),
    example(
      "construction-failed",
      "shoot-construction-failed",
      { lighting_type: "stage" },
      { failures: ["render evidence missing"] },
    ),
    example("heldout-safe", "shoot-heldout", {
      lighting_type: "stage",
      subject_type: "portrait",
      camera: "Nikon Z8",
      lens: "85mm",
      iso: 800,
      delivery: "web",
    }),
    example(
      "heldout-failed",
      "shoot-heldout-failed",
      { lighting_type: "stage" },
      { failures: ["manual review incomplete"] },
    ),
    example("heldout-empty", "shoot-heldout-empty", {}),
    example("excluded-example", "shoot-excluded", { lighting_type: "stage" }),
  ]);
}

describe("T46 held-out Style Memory evaluation", () => {
  it("uses only construction shoots and reports held-out evidence boundaries", () => {
    const report = evaluateStyleHistoryHeldOut(snapshot(), request());

    expect(report).toMatchObject({
      evaluation_id: "style-memory-evaluation-001",
      dataset_id: "style-memory",
      split_id: "split-2026-08-31",
      construction_population: 2,
      population: 3,
      sample_size: 3,
      matched_sample_size: 1,
      evidence_confidence: 0.92,
    });
    expect(report.cases.map((evaluationCase) => evaluationCase.held_out_example_id)).toEqual([
      "heldout-empty",
      "heldout-failed",
      "heldout-safe",
    ]);
    expect(report.cases[2]).toMatchObject({
      held_out_example_id: "heldout-safe",
      matched: true,
      reference_example_ids: ["construction-safe"],
    });
    expect(
      report.cases.flatMap((evaluationCase) => evaluationCase.reference_example_ids),
    ).not.toContain("construction-failed");
    expect(report.review_outcomes).toEqual(
      expect.arrayContaining([
        "held_out_context_missing",
        "held_out_example_failure_excluded",
        "history_example_failure_excluded",
      ]),
    );
    expect(report.failures).toEqual(
      expect.arrayContaining([
        "heldout-failed: manual review incomplete",
        "construction-failed: render evidence missing",
        "heldout-empty: scene context is missing",
      ]),
    );
  });

  it("freezes shoot-level membership and rejects overlap or unassigned data", () => {
    expect(() =>
      buildStyleHistoryEvaluationSplit(
        "invalid-overlap",
        "r1",
        splitSha256,
        ["same-shoot"],
        ["same-shoot"],
      ),
    ).toThrow(/may only appear once/);

    expect(() =>
      evaluateStyleHistoryHeldOut(
        snapshot(),
        request({
          split: buildStyleHistoryEvaluationSplit(
            "invalid-coverage",
            "r1",
            splitSha256,
            ["shoot-construction"],
            ["shoot-heldout"],
          ),
        }),
      ),
    ).toThrow(/assign each snapshot shoot exactly once/);
  });

  it("reports deterministic truncation without changing the frozen population", () => {
    const report = evaluateStyleHistoryHeldOut(snapshot(), request({ max_examples: 1 }));

    expect(report.population).toBe(3);
    expect(report.sample_size).toBe(1);
    expect(report.review_outcomes).toContain("held_out_evaluation_truncated");
    expect(report.cases[0]?.held_out_example_id).toBe("heldout-empty");
  });

  it("keeps held-out golden vectors isolated and rejects duplicate ids", () => {
    const report = evaluateStyleHistoryHeldOut(snapshot(), request());
    const vector = {
      id: "held-out-evaluation-vector",
      control_group: "frozen-shoot-split",
      snapshot: snapshot(),
      request: request(),
      expected_report: report,
    };

    expect(runStyleHistoryEvaluationGoldenVectors([vector])[0]?.report).toEqual(report);
    expect(() => runStyleHistoryEvaluationGoldenVectors([vector, vector])).toThrow(
      /Duplicate Style history evaluation golden vector/,
    );
  });
});
