import {
  SCHEMA_VERSION,
  STYLE_HISTORY_EVALUATION_REGISTRY_VERSION,
  StyleHistoryEvaluationCaseSchema,
  StyleHistoryEvaluationGoldenVectorSchema,
  StyleHistoryEvaluationReportSchema,
  StyleHistoryEvaluationRequestSchema,
  StyleHistoryEvaluationSplitSchema,
  StyleHistorySnapshotSchema,
} from "./schemas.js";
import { retrieveStyleHistory } from "./style-history.js";
import type {
  StyleHistoryEvaluationCase,
  StyleHistoryEvaluationGoldenVector,
  StyleHistoryEvaluationReport,
  StyleHistoryEvaluationRequest,
  StyleHistoryEvaluationSplit,
  StyleHistoryExample,
  StyleHistorySnapshot,
} from "./types.js";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hasContext(example: StyleHistoryExample): boolean {
  return Object.keys(example.context).length > 0;
}

function validateSplitAgainstSnapshot(
  snapshot: StyleHistorySnapshot,
  split: StyleHistoryEvaluationSplit,
): void {
  const construction = new Set(split.construction_shoot_ids);
  const heldOut = new Set(split.held_out_shoot_ids);
  const excluded = new Set(split.excluded_shoot_ids);
  const knownShoots = new Set(snapshot.examples.map((example) => example.shoot_id));

  for (const shootId of [
    ...split.construction_shoot_ids,
    ...split.held_out_shoot_ids,
    ...split.excluded_shoot_ids,
  ]) {
    if (!knownShoots.has(shootId)) {
      throw new Error(`Style history evaluation split references unknown shoot: ${shootId}`);
    }
  }

  for (const example of snapshot.examples) {
    const membership = [
      construction.has(example.shoot_id),
      heldOut.has(example.shoot_id),
      excluded.has(example.shoot_id),
    ].filter(Boolean).length;
    if (membership !== 1) {
      throw new Error(
        `Style history evaluation split must assign each snapshot shoot exactly once: ${example.shoot_id}`,
      );
    }
  }
}

function makeEvaluationQuery(
  request: StyleHistoryEvaluationRequest,
  example: StyleHistoryExample,
): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    query_id: `${request.evaluation_id.slice(0, 80)}:${example.example_id.slice(0, 100)}`,
    context: example.context,
    protected_attributes: request.protected_attributes,
    target_profile: example.perceptual_profile,
    exclude_shoot_ids: [example.shoot_id],
    exclude_example_ids: [example.example_id],
    max_results: request.max_results,
    min_confidence: request.min_confidence,
  };
}

function caseForFailure(
  example: StyleHistoryExample,
  failures: readonly string[],
  reviewOutcomes: readonly string[],
): StyleHistoryEvaluationCase {
  return {
    held_out_example_id: example.example_id,
    held_out_shoot_id: example.shoot_id,
    reference_example_ids: [],
    matched: false,
    evidence_confidence: 0,
    failures: [...failures].slice(0, 16),
    review_outcomes: [...reviewOutcomes].slice(0, 16),
  };
}

export function buildStyleHistoryEvaluationSplit(
  splitId: string,
  splitRevision: string,
  splitSha256: string,
  constructionShootIds: readonly string[],
  heldOutShootIds: readonly string[],
  excludedShootIds: readonly string[] = [],
): StyleHistoryEvaluationSplit {
  return StyleHistoryEvaluationSplitSchema.parse({
    schema_version: SCHEMA_VERSION,
    split_id: splitId,
    split_revision: splitRevision,
    split_sha256: splitSha256,
    construction_shoot_ids: [...constructionShootIds],
    held_out_shoot_ids: [...heldOutShootIds],
    excluded_shoot_ids: [...excludedShootIds],
  });
}

export function validateStyleHistoryEvaluationSplit(split: unknown): StyleHistoryEvaluationSplit {
  return StyleHistoryEvaluationSplitSchema.parse(split);
}

export function validateStyleHistoryEvaluationRequest(
  request: unknown,
): StyleHistoryEvaluationRequest {
  return StyleHistoryEvaluationRequestSchema.parse(request);
}

export function validateStyleHistoryEvaluationReport(
  report: unknown,
): StyleHistoryEvaluationReport {
  return StyleHistoryEvaluationReportSchema.parse(report);
}

/**
 * Evaluate Style Memory on a frozen shoot-level held-out split. Construction
 * examples are the only retrieval population; this function never touches a
 * backend, photos, RAW metadata, or copied edit settings.
 */
export function evaluateStyleHistoryHeldOut(
  snapshot: unknown,
  request: unknown,
): StyleHistoryEvaluationReport {
  const parsedSnapshot = StyleHistorySnapshotSchema.parse(snapshot);
  const parsedRequest = StyleHistoryEvaluationRequestSchema.parse(request);
  validateSplitAgainstSnapshot(parsedSnapshot, parsedRequest.split);

  const constructionShoots = new Set(parsedRequest.split.construction_shoot_ids);
  const heldOutShoots = new Set(parsedRequest.split.held_out_shoot_ids);
  const constructionExamples = parsedSnapshot.examples.filter((example) =>
    constructionShoots.has(example.shoot_id),
  );
  const heldOutExamples = parsedSnapshot.examples
    .filter((example) => heldOutShoots.has(example.shoot_id))
    .sort((left, right) => left.example_id.localeCompare(right.example_id));
  const constructionSnapshot = StyleHistorySnapshotSchema.parse({
    ...parsedSnapshot,
    examples: constructionExamples,
  });

  const failures: string[] = [];
  const reviewOutcomes: string[] = [];
  const selectedHeldOut = heldOutExamples.slice(0, parsedRequest.max_examples);
  if (selectedHeldOut.length < heldOutExamples.length) {
    reviewOutcomes.push("held_out_evaluation_truncated");
  }

  const cases: StyleHistoryEvaluationCase[] = selectedHeldOut.map((example) => {
    if (example.failures.length > 0) {
      const exampleFailures = example.failures.map(
        (failure) => `${example.example_id}: ${failure}`,
      );
      failures.push(...exampleFailures);
      reviewOutcomes.push("held_out_example_failure_excluded");
      return caseForFailure(example, exampleFailures, ["held_out_example_failure_excluded"]);
    }
    if (!hasContext(example)) {
      const missingContext = `${example.example_id}: scene context is missing`;
      failures.push(missingContext);
      reviewOutcomes.push("held_out_context_missing");
      return caseForFailure(example, [missingContext], ["held_out_context_missing"]);
    }

    const retrieval = retrieveStyleHistory(
      constructionSnapshot,
      makeEvaluationQuery(parsedRequest, example),
    );
    const references = retrieval.matches.map((match) => match.example_id);
    const caseReviewOutcomes = [...retrieval.review_outcomes];
    if (references.length === 0) caseReviewOutcomes.push("held_out_no_reference");
    const evaluationCase: StyleHistoryEvaluationCase = {
      held_out_example_id: example.example_id,
      held_out_shoot_id: example.shoot_id,
      reference_example_ids: references,
      matched: references.length > 0,
      ...(references.length > 0 ? { top_match_score: retrieval.matches[0]?.score } : {}),
      evidence_confidence: retrieval.evidence_confidence,
      failures: retrieval.failures,
      review_outcomes: unique(caseReviewOutcomes).slice(0, 16),
    };
    failures.push(...retrieval.failures);
    reviewOutcomes.push(...caseReviewOutcomes);
    return StyleHistoryEvaluationCaseSchema.parse(evaluationCase);
  });

  const matchedCases = cases.filter((evaluationCase) => evaluationCase.matched);
  const evidenceConfidence = matchedCases.length
    ? matchedCases.reduce((sum, evaluationCase) => sum + evaluationCase.evidence_confidence, 0) /
      matchedCases.length
    : 0;
  return StyleHistoryEvaluationReportSchema.parse({
    schema_version: SCHEMA_VERSION,
    evaluation_registry_version: STYLE_HISTORY_EVALUATION_REGISTRY_VERSION,
    history_registry_version: parsedSnapshot.history_registry_version,
    evaluation_id: parsedRequest.evaluation_id,
    dataset_id: parsedSnapshot.dataset_id,
    dataset_revision: parsedSnapshot.dataset_revision,
    dataset_sha256: parsedSnapshot.dataset_sha256,
    split_id: parsedRequest.split.split_id,
    split_revision: parsedRequest.split.split_revision,
    split_sha256: parsedRequest.split.split_sha256,
    construction_population: constructionExamples.length,
    population: heldOutExamples.length,
    sample_size: cases.length,
    matched_sample_size: matchedCases.length,
    evidence_confidence: evidenceConfidence,
    cases,
    failures: unique(failures).slice(0, 64),
    review_outcomes: unique(reviewOutcomes).slice(0, 64),
  });
}

export type StyleHistoryEvaluationGoldenVectorResult = {
  id: string;
  control_group: string;
  report: StyleHistoryEvaluationReport;
};

/** Execute one isolated held-out evaluation golden vector. */
export function runStyleHistoryEvaluationGoldenVector(
  vector: unknown,
): StyleHistoryEvaluationGoldenVectorResult {
  const parsed: StyleHistoryEvaluationGoldenVector =
    StyleHistoryEvaluationGoldenVectorSchema.parse(vector);
  const report = evaluateStyleHistoryHeldOut(parsed.snapshot, parsed.request);
  if (
    JSON.stringify(canonicalize(report)) !== JSON.stringify(canonicalize(parsed.expected_report))
  ) {
    throw new Error(`Style history evaluation golden vector failed: ${parsed.id}`);
  }
  return { id: parsed.id, control_group: parsed.control_group, report };
}

/** Run held-out evaluation vectors independently and reject duplicate IDs. */
export function runStyleHistoryEvaluationGoldenVectors(
  vectors: readonly unknown[],
): StyleHistoryEvaluationGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = StyleHistoryEvaluationGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate Style history evaluation golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runStyleHistoryEvaluationGoldenVector(parsed);
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

export const assertStyleHistoryEvaluationGoldenVector = runStyleHistoryEvaluationGoldenVector;
