import {
  EVALUATOR_CALIBRATION_REGISTRY_VERSION,
  EvaluatorCalibrationGoldenVectorSchema,
  EvaluatorCalibrationModelMetricsSchema,
  EvaluatorCalibrationReportSchema,
  EvaluatorCalibrationStudySchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type {
  EvaluatorCalibrationModelMetrics,
  EvaluatorCalibrationReport,
  EvaluatorCalibrationStudy,
  EvaluatorCalibrationGoldenVector,
  ModelPairEvaluation,
} from "./types.js";

type ComparablePreference = "option_a" | "option_b" | "tie";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isComparablePreference(value: string): value is ComparablePreference {
  return value === "option_a" || value === "option_b" || value === "tie";
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function validateModelCatalog(study: EvaluatorCalibrationStudy): void {
  const modelIds = new Set(study.models.map((model) => modelKey(model.provider, model.model)));
  if (modelIds.size < 2) throw new Error("Calibration requires at least two distinct models");
}

function buildModelMetrics(
  study: EvaluatorCalibrationStudy,
  provider: string,
  model: string,
  humanLabels: Map<string, EvaluatorCalibrationStudy["human_labels"][number]>,
  evaluations: Map<string, ModelPairEvaluation>,
  failures: string[],
  reviewOutcomes: string[],
): EvaluatorCalibrationModelMetrics {
  const population = study.pairs.length;
  const modelEvaluations = study.pairs
    .map((pair) => evaluations.get(pair.pair_id))
    .filter((evaluation): evaluation is ModelPairEvaluation => evaluation !== undefined);
  const sampleSize = modelEvaluations.length;
  const humanLabelledSampleSize = modelEvaluations.filter((evaluation) =>
    humanLabels.has(evaluation.pair_id),
  ).length;
  const agreementCandidates = modelEvaluations.filter((evaluation) => {
    const humanLabel = humanLabels.get(evaluation.pair_id);
    return (
      evaluation.status === "scored" &&
      humanLabel !== undefined &&
      isComparablePreference(evaluation.preference) &&
      isComparablePreference(humanLabel.preference)
    );
  });
  const agreements = agreementCandidates.filter(
    (evaluation) => humanLabels.get(evaluation.pair_id)?.preference === evaluation.preference,
  ).length;
  const failedEvaluations = modelEvaluations.flatMap((evaluation) =>
    evaluation.failures.map((failure) => `${evaluation.pair_id}: ${failure}`),
  );
  failures.push(...failedEvaluations);
  const modelReviewOutcomes = modelEvaluations.flatMap((evaluation) =>
    evaluation.review_outcomes.map((outcome) => `${evaluation.pair_id}: ${outcome}`),
  );
  reviewOutcomes.push(...modelReviewOutcomes);
  for (const pair of study.pairs) {
    if (!evaluations.has(pair.pair_id)) {
      reviewOutcomes.push(`model_evaluation_missing:${modelKey(provider, model)}:${pair.pair_id}`);
    }
    if (!humanLabels.has(pair.pair_id)) {
      reviewOutcomes.push(`human_label_missing:${pair.pair_id}`);
    }
  }
  return EvaluatorCalibrationModelMetricsSchema.parse({
    provider,
    model,
    population,
    sample_size: sampleSize,
    human_labelled_sample_size: humanLabelledSampleSize,
    agreement_sample_size: agreementCandidates.length,
    agreement_rate: ratio(agreements, agreementCandidates.length),
    human_unacceptable_rate: ratio(
      modelEvaluations.filter(
        (evaluation) => humanLabels.get(evaluation.pair_id)?.unacceptable_result,
      ).length,
      humanLabelledSampleSize,
    ),
    unacceptable_result_rate: ratio(
      modelEvaluations.filter((evaluation) => evaluation.unacceptable_result).length,
      sampleSize,
    ),
    review_rate: ratio(
      modelEvaluations.filter((evaluation) => evaluation.status === "review_required").length,
      sampleSize,
    ),
    convergence_rate: ratio(
      modelEvaluations.filter((evaluation) => evaluation.converged).length,
      sampleSize,
    ),
    recovery_success_rate: ratio(
      modelEvaluations.filter((evaluation) => evaluation.recovery_success).length,
      sampleSize,
    ),
    failures: unique(failedEvaluations).slice(0, 64),
    review_outcomes: unique([
      ...modelReviewOutcomes,
      ...study.pairs
        .filter((pair) => !evaluations.has(pair.pair_id))
        .map((pair) => `model_evaluation_missing:${modelKey(provider, model)}:${pair.pair_id}`),
      ...study.pairs
        .filter((pair) => !humanLabels.has(pair.pair_id))
        .map((pair) => `human_label_missing:${pair.pair_id}`),
    ]).slice(0, 64),
  });
}

/**
 * Materialize an evaluator-vs-human calibration report. Human labels are a
 * separate required source; no model output is ever used as a human label.
 */
export function runEvaluatorCalibration(studyInput: unknown): EvaluatorCalibrationReport {
  const study = EvaluatorCalibrationStudySchema.parse(studyInput);
  validateModelCatalog(study);
  const humanLabels = new Map(study.human_labels.map((label) => [label.pair_id, label]));
  const failures: string[] = [];
  const reviewOutcomes: string[] = [];
  if (humanLabels.size < study.pairs.length) reviewOutcomes.push("human_labels_incomplete");

  const modelMetrics = study.models
    .map((model) => {
      const evaluations = new Map(
        study.model_evaluations
          .filter(
            (evaluation) =>
              evaluation.provider === model.provider && evaluation.model === model.model,
          )
          .map((evaluation) => [evaluation.pair_id, evaluation]),
      );
      return buildModelMetrics(
        study,
        model.provider,
        model.model,
        humanLabels,
        evaluations,
        failures,
        reviewOutcomes,
      );
    })
    .sort((left, right) =>
      modelKey(left.provider, left.model).localeCompare(modelKey(right.provider, right.model)),
    );

  return EvaluatorCalibrationReportSchema.parse({
    schema_version: SCHEMA_VERSION,
    calibration_registry_version: EVALUATOR_CALIBRATION_REGISTRY_VERSION,
    study_id: study.study_id,
    benchmark_version: study.benchmark_version,
    dataset_id: study.dataset_id,
    dataset_revision: study.dataset_revision,
    dataset_sha256: study.dataset_sha256,
    randomization: study.randomization,
    human_label_source: "human",
    population: study.pairs.length,
    sample_size: study.pairs.length,
    human_labelled_count: humanLabels.size,
    unlabelled_count: study.pairs.length - humanLabels.size,
    models: modelMetrics,
    failures: unique(failures).slice(0, 128),
    review_outcomes: unique(reviewOutcomes).slice(0, 128),
  });
}

export function validateEvaluatorCalibrationReport(report: unknown): EvaluatorCalibrationReport {
  return EvaluatorCalibrationReportSchema.parse(report);
}

/** Execute one isolated calibration vector with explicit human-source checks. */
export type EvaluatorCalibrationGoldenVectorResult = {
  id: string;
  control_group: string;
  report: EvaluatorCalibrationReport;
};

export function runEvaluatorCalibrationGoldenVector(
  vector: unknown,
): EvaluatorCalibrationGoldenVectorResult {
  const parsed: EvaluatorCalibrationGoldenVector =
    EvaluatorCalibrationGoldenVectorSchema.parse(vector);
  const report = runEvaluatorCalibration(parsed.study);
  if (
    JSON.stringify(canonicalize(report)) !== JSON.stringify(canonicalize(parsed.expected_report))
  ) {
    throw new Error(`Evaluator calibration golden vector failed: ${parsed.id}`);
  }
  return { id: parsed.id, control_group: parsed.control_group, report };
}

export function runEvaluatorCalibrationGoldenVectors(
  vectors: readonly unknown[],
): EvaluatorCalibrationGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = EvaluatorCalibrationGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate evaluator calibration golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runEvaluatorCalibrationGoldenVector(parsed);
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export const assertEvaluatorCalibrationGoldenVector = runEvaluatorCalibrationGoldenVector;
