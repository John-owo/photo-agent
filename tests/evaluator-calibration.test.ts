import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION, EVALUATOR_CALIBRATION_REGISTRY_VERSION } from "../src/schemas.js";
import {
  runEvaluatorCalibration,
  runEvaluatorCalibrationGoldenVectors,
} from "../src/evaluator-calibration.js";
import type { EvaluatorCalibrationStudy, ModelPairEvaluation } from "../src/types.js";

const datasetSha256 = "a".repeat(64);
const assignmentSha256 = "b".repeat(64);

const pairs: EvaluatorCalibrationStudy["pairs"] = [
  {
    pair_id: "pair-1",
    benchmark_case_id: "case-portrait",
    option_a_id: "candidate-a-1",
    option_b_id: "candidate-b-1",
    presentation_order: "option_b_first",
    blinded: true,
  },
  {
    pair_id: "pair-2",
    benchmark_case_id: "case-night",
    option_a_id: "candidate-a-2",
    option_b_id: "candidate-b-2",
    presentation_order: "option_a_first",
    blinded: true,
  },
  {
    pair_id: "pair-3",
    benchmark_case_id: "case-event",
    option_a_id: "candidate-a-3",
    option_b_id: "candidate-b-3",
    presentation_order: "option_b_first",
    blinded: true,
  },
];

function modelEvaluation(
  provider: string,
  model: string,
  pairId: string,
  overrides: Partial<ModelPairEvaluation> = {},
): ModelPairEvaluation {
  return {
    pair_id: pairId,
    provider,
    model,
    status: "scored",
    preference: "option_a",
    unacceptable_result: false,
    converged: true,
    recovery_success: true,
    evidence: [`${provider}:${model}:${pairId}`],
    failures: [],
    review_outcomes: [],
    ...overrides,
  };
}

function study(overrides: Partial<EvaluatorCalibrationStudy> = {}): EvaluatorCalibrationStudy {
  return {
    schema_version: SCHEMA_VERSION,
    calibration_registry_version: EVALUATOR_CALIBRATION_REGISTRY_VERSION,
    study_id: "calibration-study-001",
    benchmark_version: "photoagent-bench@0.1.0",
    dataset_id: "photoagent-bench",
    dataset_revision: "dataset-r1",
    dataset_sha256: datasetSha256,
    randomization: {
      algorithm: "sha256_seeded_fisher_yates",
      seed: "seed-001",
      assignment_sha256: assignmentSha256,
      blinded: true,
    },
    pairs,
    models: [
      { provider: "openai", model: "model-a" },
      { provider: "local", model: "model-b" },
    ],
    human_labels: [
      {
        pair_id: "pair-1",
        source: "human",
        preference: "option_a",
        unacceptable_result: false,
        evidence: ["human-reviewer-1"],
      },
      {
        pair_id: "pair-2",
        source: "human",
        preference: "option_b",
        unacceptable_result: true,
        evidence: ["human-reviewer-1"],
      },
    ],
    model_evaluations: [
      modelEvaluation("openai", "model-a", "pair-1", { preference: "option_a" }),
      modelEvaluation("openai", "model-a", "pair-2", { preference: "option_b" }),
      modelEvaluation("openai", "model-a", "pair-3", { preference: "option_b" }),
      modelEvaluation("local", "model-b", "pair-1", { preference: "option_a" }),
      modelEvaluation("local", "model-b", "pair-2", { preference: "option_a" }),
      modelEvaluation("local", "model-b", "pair-3", {
        status: "review_required",
        preference: "review_required",
        unacceptable_result: true,
        converged: false,
        recovery_success: false,
        review_outcomes: ["ambiguous result"],
      }),
    ],
    ...overrides,
  };
}

describe("T50 evaluator-human calibration contract", () => {
  it("reports blind randomization, population, agreement, and reliability metrics", () => {
    const report = runEvaluatorCalibration(study());

    expect(report).toMatchObject({
      schema_version: SCHEMA_VERSION,
      calibration_registry_version: EVALUATOR_CALIBRATION_REGISTRY_VERSION,
      benchmark_version: "photoagent-bench@0.1.0",
      human_label_source: "human",
      population: 3,
      sample_size: 3,
      human_labelled_count: 2,
      unlabelled_count: 1,
      randomization: {
        algorithm: "sha256_seeded_fisher_yates",
        seed: "seed-001",
        assignment_sha256: assignmentSha256,
        blinded: true,
      },
    });
    const local = report.models.find((model) => model.provider === "local");
    const openai = report.models.find((model) => model.provider === "openai");
    expect(local).toMatchObject({
      population: 3,
      sample_size: 3,
      human_labelled_sample_size: 2,
      agreement_sample_size: 2,
      convergence_rate: 2 / 3,
      recovery_success_rate: 2 / 3,
      review_rate: 1 / 3,
    });
    expect(local?.agreement_rate).toBeCloseTo(0.5);
    expect(local?.unacceptable_result_rate).toBeCloseTo(1 / 3);
    expect(local?.human_unacceptable_rate).toBeCloseTo(0.5);
    expect(openai).toMatchObject({
      human_labelled_sample_size: 2,
      agreement_sample_size: 2,
      review_rate: 0,
      convergence_rate: 1,
      recovery_success_rate: 1,
    });
    expect(openai?.agreement_rate).toBe(1);
    expect(report.review_outcomes).toEqual(
      expect.arrayContaining(["human_labels_incomplete", "human_label_missing:pair-3"]),
    );
  });

  it("never accepts model output as a human label", () => {
    expect(() =>
      runEvaluatorCalibration(
        study({
          human_labels: [
            {
              pair_id: "pair-1",
              source: "model",
              preference: "option_a",
              unacceptable_result: false,
              evidence: ["not-human"],
            },
          ] as never,
        }),
      ),
    ).toThrow();
    expect(runEvaluatorCalibration(study()).human_label_source).toBe("human");
  });

  it("keeps missing model observations and failures visible", () => {
    const report = runEvaluatorCalibration(
      study({
        model_evaluations: [
          modelEvaluation("openai", "model-a", "pair-1"),
          modelEvaluation("local", "model-b", "pair-1", {
            status: "failed",
            preference: "review_required",
            converged: false,
            recovery_success: false,
            failures: ["provider timeout"],
          }),
        ],
      }),
    );

    expect(report.failures).toContain("pair-1: provider timeout");
    expect(report.review_outcomes).toEqual(
      expect.arrayContaining([
        "model_evaluation_missing:openai:model-a:pair-2",
        "model_evaluation_missing:local:model-b:pair-2",
      ]),
    );
    expect(report.models.find((model) => model.provider === "openai")?.sample_size).toBe(1);
  });

  it("keeps calibration golden vectors isolated and rejects duplicate ids", () => {
    const expected = runEvaluatorCalibration(study());
    const vector = {
      id: "calibration-vector",
      control_group: "human-agreement",
      study: study(),
      expected_report: expected,
    };

    expect(runEvaluatorCalibrationGoldenVectors([vector])[0]?.report).toEqual(expected);
    expect(() => runEvaluatorCalibrationGoldenVectors([vector, vector])).toThrow(
      /Duplicate evaluator calibration golden vector/,
    );
  });
});
