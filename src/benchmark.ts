import {
  PHOTO_AGENT_BENCH_CONDITIONS,
  PHOTO_AGENT_BENCH_REGISTRY_VERSION,
  SCHEMA_VERSION,
  PhotoAgentBenchCaseOutcomeSchema,
  PhotoAgentBenchDatasetSchema,
  PhotoAgentBenchGoldenVectorSchema,
  PhotoAgentBenchReportSchema,
  PhotoAgentBenchSplitSchema,
} from "./schemas.js";
import type {
  PhotoAgentBenchCase,
  PhotoAgentBenchCaseOutcome,
  PhotoAgentBenchDataset,
  PhotoAgentBenchGoldenVector,
  PhotoAgentBenchReport,
  PhotoAgentBenchSplit,
} from "./types.js";

type BenchCondition = (typeof PHOTO_AGENT_BENCH_CONDITIONS)[number];

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateSplitAgainstDataset(
  dataset: PhotoAgentBenchDataset,
  split: PhotoAgentBenchSplit,
): void {
  const groups = [
    split.construction_shoot_ids,
    split.validation_shoot_ids,
    split.test_shoot_ids,
    split.excluded_shoot_ids,
  ].map((ids) => new Set(ids));
  const knownShoots = new Set(dataset.cases.map((benchmarkCase) => benchmarkCase.shoot_id));
  for (const shootId of groups.flatMap((group) => [...group])) {
    if (!knownShoots.has(shootId)) {
      throw new Error(`PhotoAgent Bench split references unknown shoot: ${shootId}`);
    }
  }
  for (const benchmarkCase of dataset.cases) {
    const membership = groups.filter((group) => group.has(benchmarkCase.shoot_id)).length;
    if (membership !== 1) {
      throw new Error(
        `PhotoAgent Bench split must assign each dataset shoot exactly once: ${benchmarkCase.shoot_id}`,
      );
    }
  }

  const testCases = dataset.cases.filter((benchmarkCase) => groups[2]?.has(benchmarkCase.shoot_id));
  const testConditions = new Set(testCases.map((benchmarkCase) => benchmarkCase.condition));
  const missingConditions = PHOTO_AGENT_BENCH_CONDITIONS.filter(
    (condition) => !testConditions.has(condition),
  );
  if (missingConditions.length > 0) {
    throw new Error(
      `PhotoAgent Bench test split is missing conditions: ${missingConditions.join(", ")}`,
    );
  }
}

export function buildPhotoAgentBenchDataset(
  datasetId: string,
  datasetRevision: string,
  datasetSha256: string,
  cases: readonly PhotoAgentBenchCase[],
): PhotoAgentBenchDataset {
  return PhotoAgentBenchDatasetSchema.parse({
    schema_version: SCHEMA_VERSION,
    benchmark_registry_version: PHOTO_AGENT_BENCH_REGISTRY_VERSION,
    dataset_id: datasetId,
    dataset_revision: datasetRevision,
    dataset_sha256: datasetSha256,
    cases: [...cases],
  });
}

export function validatePhotoAgentBenchDataset(dataset: unknown): PhotoAgentBenchDataset {
  return PhotoAgentBenchDatasetSchema.parse(dataset);
}

export function buildPhotoAgentBenchSplit(
  splitId: string,
  splitRevision: string,
  splitSha256: string,
  constructionShootIds: readonly string[],
  validationShootIds: readonly string[],
  testShootIds: readonly string[],
  excludedShootIds: readonly string[] = [],
): PhotoAgentBenchSplit {
  return PhotoAgentBenchSplitSchema.parse({
    schema_version: SCHEMA_VERSION,
    split_id: splitId,
    split_revision: splitRevision,
    split_sha256: splitSha256,
    construction_shoot_ids: [...constructionShootIds],
    validation_shoot_ids: [...validationShootIds],
    test_shoot_ids: [...testShootIds],
    excluded_shoot_ids: [...excludedShootIds],
  });
}

export function validatePhotoAgentBenchSplit(split: unknown): PhotoAgentBenchSplit {
  return PhotoAgentBenchSplitSchema.parse(split);
}

/**
 * Materialize a denominator-preserving benchmark report from explicit case
 * outcomes. Missing test outcomes become REVIEW_REQUIRED, never pass.
 */
export function runPhotoAgentBench(
  dataset: unknown,
  split: unknown,
  runId: string,
  outcomes: readonly unknown[],
): PhotoAgentBenchReport {
  const parsedDataset = PhotoAgentBenchDatasetSchema.parse(dataset);
  const parsedSplit = PhotoAgentBenchSplitSchema.parse(split);
  validateSplitAgainstDataset(parsedDataset, parsedSplit);

  const testShootIds = new Set(parsedSplit.test_shoot_ids);
  const testCases = parsedDataset.cases
    .filter((benchmarkCase) => testShootIds.has(benchmarkCase.shoot_id))
    .sort((left, right) => left.case_id.localeCompare(right.case_id));
  const testCaseById = new Map(
    testCases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase]),
  );
  const parsedOutcomes = outcomes.map((outcome) => PhotoAgentBenchCaseOutcomeSchema.parse(outcome));
  const outcomeByCaseId = new Map<string, PhotoAgentBenchCaseOutcome>();
  for (const outcome of parsedOutcomes) {
    if (outcomeByCaseId.has(outcome.case_id)) {
      throw new Error(`PhotoAgent Bench outcome case may only appear once: ${outcome.case_id}`);
    }
    if (!testCaseById.has(outcome.case_id)) {
      throw new Error(`PhotoAgent Bench outcome is not in the test split: ${outcome.case_id}`);
    }
    outcomeByCaseId.set(outcome.case_id, outcome);
  }

  const failures: string[] = [];
  const reviewOutcomes: string[] = [];
  const results = testCases.map((benchmarkCase) => {
    const outcome =
      outcomeByCaseId.get(benchmarkCase.case_id) ??
      PhotoAgentBenchCaseOutcomeSchema.parse({
        case_id: benchmarkCase.case_id,
        verdict: "review_required",
        confidence: 0,
        evidence: ["No benchmark outcome was supplied"],
        failures: [],
        review_outcomes: ["benchmark_case_outcome_missing"],
      });
    if (!outcomeByCaseId.has(benchmarkCase.case_id)) {
      reviewOutcomes.push("benchmark_case_outcome_missing");
    }
    failures.push(...outcome.failures.map((failure) => `${benchmarkCase.case_id}: ${failure}`));
    reviewOutcomes.push(...outcome.review_outcomes);
    return {
      case_id: benchmarkCase.case_id,
      shoot_id: benchmarkCase.shoot_id,
      asset_id: benchmarkCase.asset_id,
      condition: benchmarkCase.condition,
      verdict: outcome.verdict,
      confidence: outcome.confidence,
      evidence: outcome.evidence,
      failures: outcome.failures,
      review_outcomes: outcome.review_outcomes,
    };
  });

  const coverage = PHOTO_AGENT_BENCH_CONDITIONS.map((condition: BenchCondition) => ({
    condition,
    population: testCases.filter((benchmarkCase) => benchmarkCase.condition === condition).length,
  }));
  const passCount = results.filter((result) => result.verdict === "pass").length;
  const failureCount = results.filter((result) => result.verdict === "fail").length;
  const reviewRequiredCount = results.filter(
    (result) => result.verdict === "review_required",
  ).length;
  return PhotoAgentBenchReportSchema.parse({
    schema_version: SCHEMA_VERSION,
    benchmark_registry_version: PHOTO_AGENT_BENCH_REGISTRY_VERSION,
    run_id: runId,
    dataset_id: parsedDataset.dataset_id,
    dataset_revision: parsedDataset.dataset_revision,
    dataset_sha256: parsedDataset.dataset_sha256,
    split_id: parsedSplit.split_id,
    split_revision: parsedSplit.split_revision,
    split_sha256: parsedSplit.split_sha256,
    condition_coverage: coverage,
    population: results.length,
    sample_size: results.length,
    pass_count: passCount,
    failure_count: failureCount,
    review_required_count: reviewRequiredCount,
    cases: results,
    failures: unique(failures).slice(0, 64),
    review_outcomes: unique(reviewOutcomes).slice(0, 64),
  });
}

export function validatePhotoAgentBenchReport(report: unknown): PhotoAgentBenchReport {
  return PhotoAgentBenchReportSchema.parse(report);
}

export type PhotoAgentBenchGoldenVectorResult = {
  id: string;
  control_group: string;
  report: PhotoAgentBenchReport;
};

/** Execute one independently owned, outcome-driven benchmark vector. */
export function runPhotoAgentBenchGoldenVector(vector: unknown): PhotoAgentBenchGoldenVectorResult {
  const parsed: PhotoAgentBenchGoldenVector = PhotoAgentBenchGoldenVectorSchema.parse(vector);
  const report = runPhotoAgentBench(parsed.dataset, parsed.split, parsed.run_id, parsed.outcomes);
  if (
    JSON.stringify(canonicalize(report)) !== JSON.stringify(canonicalize(parsed.expected_report))
  ) {
    throw new Error(`PhotoAgent Bench golden vector failed: ${parsed.id}`);
  }
  return { id: parsed.id, control_group: parsed.control_group, report };
}

/** Run benchmark vectors independently and reject duplicate IDs. */
export function runPhotoAgentBenchGoldenVectors(
  vectors: readonly unknown[],
): PhotoAgentBenchGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = PhotoAgentBenchGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate PhotoAgent Bench golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runPhotoAgentBenchGoldenVector(parsed);
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

export const assertPhotoAgentBenchGoldenVector = runPhotoAgentBenchGoldenVector;
