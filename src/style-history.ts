import {
  STYLE_HISTORY_MATCH_FIELDS,
  STYLE_HISTORY_MIN_CONFIDENCE,
  STYLE_HISTORY_MIN_MATCH_SCORE,
  STYLE_HISTORY_REGISTRY_VERSION,
  StyleHistoryGoldenVectorSchema,
  StyleHistoryQuerySchema,
  StyleHistoryRetrievalSchema,
  StyleHistorySnapshotSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type { STYLE_HISTORY_PROTECTED_ATTRIBUTES } from "./schemas.js";
import type {
  StyleHistoryExample,
  StyleHistoryGoldenVector,
  StyleHistoryMatch,
  StyleHistoryQuery,
  StyleHistoryRetrieval,
  StyleHistorySnapshot,
  StylePerceptualProfile,
} from "./types.js";

type MatchField = (typeof STYLE_HISTORY_MATCH_FIELDS)[number];

const MATCH_WEIGHTS: Record<MatchField, number> = {
  lighting_type: 0.25,
  subject_type: 0.25,
  camera: 0.15,
  lens: 0.1,
  iso: 0.15,
  delivery: 0.1,
};

function normalizeString(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scoreIso(requested: number, candidate: number): number {
  const stops = Math.abs(Math.log2(candidate / requested));
  return Math.max(0, 1 - stops / 4);
}

function contextValue(
  context: StyleHistoryQuery["context"] | StyleHistoryExample["context"],
  field: MatchField,
): string | number | undefined {
  switch (field) {
    case "lighting_type":
      return context.lighting_type;
    case "subject_type":
      return context.subject_type;
    case "camera":
      return context.camera;
    case "lens":
      return context.lens;
    case "iso":
      return context.iso;
    case "delivery":
      return context.delivery;
  }
}

function scoreContextField(
  queryContext: StyleHistoryQuery["context"],
  exampleContext: StyleHistoryExample["context"],
  field: MatchField,
): number {
  const requested = contextValue(queryContext, field);
  if (requested === undefined) return 0;
  const candidate = contextValue(exampleContext, field);
  if (candidate === undefined) return 0;
  if (field === "iso") {
    return typeof requested === "number" && typeof candidate === "number"
      ? scoreIso(requested, candidate)
      : 0;
  }
  return normalizeString(String(requested)) === normalizeString(String(candidate)) ? 1 : 0;
}

function scorePerceptualProfile(
  target: StylePerceptualProfile | undefined,
  candidate: StylePerceptualProfile,
): number {
  if (!target) return 0;
  if (target.natural_skin_tones && !candidate.natural_skin_tones) return 0;
  const distance =
    Math.abs(target.luminance - candidate.luminance) +
    Math.abs(target.contrast - candidate.contrast) +
    Math.abs(target.colorfulness - candidate.colorfulness) +
    Math.abs(target.warmth - candidate.warmth);
  return Math.max(0, 1 - distance / 8);
}

function contextScore(
  query: StyleHistoryQuery,
  example: StyleHistoryExample,
  perceptualScore: number,
): { score: number; components: StyleHistoryMatch["match_components"] } {
  const components = {
    lighting_type: scoreContextField(query.context, example.context, "lighting_type"),
    subject_type: scoreContextField(query.context, example.context, "subject_type"),
    camera: scoreContextField(query.context, example.context, "camera"),
    lens: scoreContextField(query.context, example.context, "lens"),
    iso: scoreContextField(query.context, example.context, "iso"),
    delivery: scoreContextField(query.context, example.context, "delivery"),
    perceptual_profile: perceptualScore,
  };
  const metadataFields = STYLE_HISTORY_MATCH_FIELDS.filter(
    (field) => contextValue(query.context, field) !== undefined,
  );
  const metadataWeight = metadataFields.reduce((sum, field) => sum + MATCH_WEIGHTS[field], 0);
  const metadataScore =
    metadataWeight === 0
      ? 0
      : metadataFields.reduce((sum, field) => sum + components[field] * MATCH_WEIGHTS[field], 0) /
        metadataWeight;
  if (!query.target_profile) return { score: metadataScore, components };
  return {
    score: metadataScore * 0.75 + perceptualScore * 0.25,
    components,
  };
}

function referenceRelationship(
  target: StylePerceptualProfile | undefined,
  candidate: StylePerceptualProfile,
): StyleHistoryMatch["reference_relationship"] {
  if (!target) return undefined;
  const round = (value: number) => Number(value.toFixed(4));
  return {
    luminance_delta: round(candidate.luminance - target.luminance),
    contrast_delta: round(candidate.contrast - target.contrast),
    colorfulness_delta: round(candidate.colorfulness - target.colorfulness),
    warmth_delta: round(candidate.warmth - target.warmth),
    natural_skin_tones_preserved: true,
  };
}

function hasProtectedAttribute(
  query: StyleHistoryQuery,
  attribute: (typeof STYLE_HISTORY_PROTECTED_ATTRIBUTES)[number],
): boolean {
  return query.protected_attributes.includes(attribute);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Build a reproducibly identified history snapshot without reading photos. */
export function buildStyleHistorySnapshot(
  datasetId: string,
  datasetRevision: string,
  datasetSha256: string,
  examples: readonly StyleHistoryExample[],
): StyleHistorySnapshot {
  return StyleHistorySnapshotSchema.parse({
    schema_version: SCHEMA_VERSION,
    history_registry_version: STYLE_HISTORY_REGISTRY_VERSION,
    dataset_id: datasetId,
    dataset_revision: datasetRevision,
    dataset_sha256: datasetSha256,
    examples,
  });
}

export function validateStyleHistorySnapshot(snapshot: unknown): StyleHistorySnapshot {
  return StyleHistorySnapshotSchema.parse(snapshot);
}

export function validateStyleHistoryQuery(query: unknown): StyleHistoryQuery {
  return StyleHistoryQuerySchema.parse(query);
}

/**
 * Retrieve scene-conditioned references by metadata and perceptual profile.
 * The result carries relationships and evidence, never copied backend
 * settings, so irrelevant history cannot silently become an edit plan.
 */
export function retrieveStyleHistory(snapshot: unknown, query: unknown): StyleHistoryRetrieval {
  const parsedSnapshot = StyleHistorySnapshotSchema.parse(snapshot);
  const parsedQuery = StyleHistoryQuerySchema.parse(query);
  const excludedShoots = new Set(parsedQuery.exclude_shoot_ids);
  const excludedExamples = new Set(parsedQuery.exclude_example_ids);
  const failures: string[] = [];
  const reviewOutcomes: string[] = [];
  let lowConfidenceExcluded = false;
  let irrelevantExcluded = false;
  let protectedAttributeExcluded = false;

  const candidates: Array<{
    example: StyleHistoryExample;
    score: number;
    components: StyleHistoryMatch["match_components"];
    confidence: number;
    perceptualScore: number;
  }> = [];

  for (const example of parsedSnapshot.examples) {
    if (excludedShoots.has(example.shoot_id) || excludedExamples.has(example.example_id)) continue;
    if (example.failures.length > 0) {
      failures.push(...example.failures.map((failure) => `${example.example_id}: ${failure}`));
      reviewOutcomes.push("history_example_failure_excluded");
      continue;
    }
    if (
      (hasProtectedAttribute(parsedQuery, "natural_skin_tones") ||
        parsedQuery.target_profile?.natural_skin_tones === true) &&
      !example.perceptual_profile.natural_skin_tones
    ) {
      protectedAttributeExcluded = true;
      continue;
    }
    const perceptualScore = scorePerceptualProfile(
      parsedQuery.target_profile,
      example.perceptual_profile,
    );
    const scored = contextScore(parsedQuery, example, perceptualScore);
    if (scored.score < STYLE_HISTORY_MIN_MATCH_SCORE) {
      irrelevantExcluded = true;
      continue;
    }
    const confidence = Math.min(1, example.confidence * (0.5 + scored.score / 2));
    if (confidence < Math.max(parsedQuery.min_confidence, STYLE_HISTORY_MIN_CONFIDENCE)) {
      lowConfidenceExcluded = true;
      continue;
    }
    candidates.push({
      example,
      score: scored.score,
      components: scored.components,
      confidence,
      perceptualScore,
    });
  }

  if (lowConfidenceExcluded) reviewOutcomes.push("low_confidence_history_excluded");
  if (irrelevantExcluded) reviewOutcomes.push("irrelevant_history_excluded");
  if (protectedAttributeExcluded) reviewOutcomes.push("protected_skin_tone_reference_excluded");

  const matches = candidates
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.confidence - left.confidence ||
        left.example.example_id.localeCompare(right.example.example_id),
    )
    .slice(0, parsedQuery.max_results)
    .map(({ example, score, components, confidence }) => ({
      example_id: example.example_id,
      shoot_id: example.shoot_id,
      rank: 0,
      score,
      match_components: components,
      reference_profile: example.perceptual_profile,
      protected_attributes: parsedQuery.protected_attributes,
      evidence: [
        ...example.evidence,
        `scene-conditioned match score ${score.toFixed(2)}`,
        `perceptual relationship score ${components.perceptual_profile.toFixed(2)}`,
      ].slice(0, 16),
      confidence,
      ...(parsedQuery.target_profile
        ? {
            reference_relationship: referenceRelationship(
              parsedQuery.target_profile,
              example.perceptual_profile,
            ),
          }
        : {}),
    }))
    .map((match, index) => ({ ...match, rank: index + 1 }));

  if (matches.length === 0) reviewOutcomes.push("no_scene_conditioned_match");
  const evidenceConfidence = matches.length
    ? matches.reduce((sum, match) => sum + match.confidence, 0) / matches.length
    : 0;
  return StyleHistoryRetrievalSchema.parse({
    schema_version: SCHEMA_VERSION,
    history_registry_version: STYLE_HISTORY_REGISTRY_VERSION,
    dataset_id: parsedSnapshot.dataset_id,
    dataset_revision: parsedSnapshot.dataset_revision,
    dataset_sha256: parsedSnapshot.dataset_sha256,
    query_id: parsedQuery.query_id,
    population: parsedSnapshot.examples.length,
    sample_size: matches.length,
    matches,
    evidence_confidence: evidenceConfidence,
    failures: unique(failures).slice(0, 16),
    review_outcomes: unique(reviewOutcomes).slice(0, 16),
  });
}

export type StyleHistoryGoldenVectorResult = {
  id: string;
  control_group: string;
  result: StyleHistoryRetrieval;
};

/** Execute one isolated, reproducible scene-conditioned history vector. */
export function runStyleHistoryGoldenVector(vector: unknown): StyleHistoryGoldenVectorResult {
  const parsed: StyleHistoryGoldenVector = StyleHistoryGoldenVectorSchema.parse(vector);
  const result = retrieveStyleHistory(parsed.snapshot, parsed.query);
  if (
    JSON.stringify(canonicalize(result)) !== JSON.stringify(canonicalize(parsed.expected_result))
  ) {
    throw new Error(`Style history golden vector failed: ${parsed.id}`);
  }
  return { id: parsed.id, control_group: parsed.control_group, result };
}

/** Run history vectors independently and reject duplicate IDs. */
export function runStyleHistoryGoldenVectors(
  vectors: readonly unknown[],
): StyleHistoryGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = StyleHistoryGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) throw new Error(`Duplicate style history golden vector: ${parsed.id}`);
    seen.add(parsed.id);
    return runStyleHistoryGoldenVector(parsed);
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

export const assertStyleHistoryGoldenVector = runStyleHistoryGoldenVector;

export const STYLE_HISTORY_MATCH_THRESHOLD = STYLE_HISTORY_MIN_MATCH_SCORE;
export const STYLE_HISTORY_CONFIDENCE_THRESHOLD = STYLE_HISTORY_MIN_CONFIDENCE;
