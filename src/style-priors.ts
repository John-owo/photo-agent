import {
  LOW_DATA_STYLE_PRIOR_CONFIDENCE_CAP,
  MIN_HISTORICAL_PREFERENCE_CONFIDENCE,
  MIN_HISTORICAL_PREFERENCE_SAMPLES,
  NORMALIZED_PARAMETERS,
  PREFERENCE_REGISTRY_VERSION,
  StylePriorGoldenVectorSchema,
  StylePriorPlanSchema,
  StylePriorRequestSchema,
} from "./schemas.js";
import { getParameterDefinition } from "./parameter-registry.js";
import type {
  PreferenceContext,
  PreferenceRule,
  StylePrior,
  StylePriorGoldenVector,
  StylePriorPlan,
  StylePriorRequest,
} from "./types.js";

type Parameter = (typeof NORMALIZED_PARAMETERS)[number];

type Candidate = {
  rule: PreferenceRule;
  specificity: number;
};

type Selection = {
  selected: PreferenceRule;
  equivalent: PreferenceRule[];
};

function sameRuleValue(left: PreferenceRule, right: PreferenceRule): boolean {
  return left.mode === right.mode && left.value === right.value;
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

function contextSpecificity(context: PreferenceContext): number {
  return Object.entries(context).reduce((score, [, value]) => {
    if (Array.isArray(value)) return score + value.length;
    return value === undefined ? score : score + 1;
  }, 0);
}

function contextMatches(
  ruleContext: PreferenceContext,
  requestedContext: PreferenceContext,
): boolean {
  for (const key of ["scene_type", "lighting_type", "camera_model", "lens"] as const) {
    const ruleValue = ruleContext[key];
    if (ruleValue !== undefined && ruleValue !== requestedContext[key]) return false;
  }
  const requestedTags = requestedContext.tags ?? [];
  if ((ruleContext.tags ?? []).some((tag) => !requestedTags.includes(tag))) return false;
  return true;
}

function validateRuleValue(rule: PreferenceRule): void {
  const definition = getParameterDefinition(rule.parameter);
  if (!definition.allowed_modes.includes(rule.mode)) {
    throw new Error(`Preference rule ${rule.id} does not allow ${rule.mode} mode`);
  }
  const range = rule.mode === "absolute" ? definition.absolute_range : definition.delta_range;
  if (rule.value < range[0] || rule.value > range[1]) {
    throw new Error(
      `Preference rule ${rule.id} value must be between ${range[0]} and ${range[1]} for ${rule.mode} mode`,
    );
  }
}

function matchingCandidates(
  rules: readonly PreferenceRule[],
  parameter: Parameter,
  context: PreferenceContext,
): Candidate[] {
  return rules
    .filter((rule) => rule.parameter === parameter && contextMatches(rule.context, context))
    .map((rule) => ({ rule, specificity: contextSpecificity(rule.context) }));
}

function selectCandidates(candidates: readonly Candidate[]): Selection | undefined {
  if (candidates.length === 0) return undefined;
  const highestSpecificity = Math.max(...candidates.map(({ specificity }) => specificity));
  const mostSpecific = candidates
    .filter(({ specificity }) => specificity === highestSpecificity)
    .map(({ rule }) => rule)
    .sort(
      (left, right) =>
        right.sample_count - left.sample_count ||
        right.confidence - left.confidence ||
        left.id.localeCompare(right.id),
    );
  const selected = mostSpecific[0];
  if (!selected) return undefined;
  if (mostSpecific.some((rule) => !sameRuleValue(rule, selected))) return undefined;
  return { selected, equivalent: mostSpecific };
}

function mergeEvidence(rules: readonly PreferenceRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => rule.evidence))].slice(0, 32);
}

function mergeRuleIds(rules: readonly PreferenceRule[]): string[] {
  return [...new Set(rules.map((rule) => rule.id))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 16);
}

function makePrior(
  parameter: Parameter,
  basis: StylePrior["basis"],
  selection: Selection,
  rationale: string,
  confidence = selection.selected.confidence,
  sampleCount = selection.selected.sample_count,
  additionalRules: readonly PreferenceRule[] = [],
): StylePrior {
  const rules = [...selection.equivalent, ...additionalRules];
  return {
    parameter,
    mode: selection.selected.mode,
    value: selection.selected.value,
    basis,
    rule_ids: mergeRuleIds(rules),
    evidence: mergeEvidence(rules),
    sample_count: sampleCount,
    confidence,
    rationale,
  };
}

function conflictWarning(parameter: Parameter, source: string): string {
  return `Conflicting ${source} preference rules for ${parameter}; manual review required`;
}

export function validateStylePriorPlan(plan: unknown): StylePriorPlan {
  return StylePriorPlanSchema.parse(plan);
}

/**
 * Resolve protected explicit rules first, then high-data history, and finally
 * low-confidence general guidance. No backend or photo state is touched.
 */
export function translateStylePriorRequest(request: StylePriorRequest): StylePriorPlan {
  const parsedRequest = StylePriorRequestSchema.parse(request);
  const allRules = [...parsedRequest.rules, ...parsedRequest.general_guidance];
  for (const rule of allRules) validateRuleValue(rule);

  const parameters = NORMALIZED_PARAMETERS.filter((parameter) =>
    allRules.some((rule) => rule.parameter === parameter),
  );
  const warnings: string[] = [];
  const priors: StylePrior[] = [];
  let reviewRequired = false;

  for (const parameter of parameters) {
    const explicit = selectCandidates(
      matchingCandidates(
        parsedRequest.rules.filter((rule) => rule.source === "explicit_protected"),
        parameter,
        parsedRequest.context,
      ),
    );
    if (explicit) {
      priors.push(
        makePrior(
          parameter,
          "explicit_protected",
          explicit,
          `Protected explicit preference ${explicit.selected.id} overrides learned tendencies`,
        ),
      );
      continue;
    }
    const explicitCandidates = matchingCandidates(
      parsedRequest.rules.filter((rule) => rule.source === "explicit_protected"),
      parameter,
      parsedRequest.context,
    );
    if (explicitCandidates.length > 0) {
      warnings.push(conflictWarning(parameter, "protected explicit"));
      reviewRequired = true;
      continue;
    }

    const historicalCandidates = matchingCandidates(
      parsedRequest.rules.filter((rule) => rule.source === "historical"),
      parameter,
      parsedRequest.context,
    );
    const strongHistorical = historicalCandidates.filter(
      ({ rule }) =>
        rule.sample_count >= MIN_HISTORICAL_PREFERENCE_SAMPLES &&
        rule.confidence >= MIN_HISTORICAL_PREFERENCE_CONFIDENCE,
    );
    const historical = selectCandidates(strongHistorical);
    if (historical) {
      priors.push(
        makePrior(
          parameter,
          "historical",
          historical,
          `Historical preference ${historical.selected.id} meets the sample and confidence thresholds`,
        ),
      );
      continue;
    }
    if (strongHistorical.length > 0) {
      warnings.push(conflictWarning(parameter, "high-sample historical"));
      reviewRequired = true;
      continue;
    }

    const generalCandidates = matchingCandidates(
      parsedRequest.general_guidance,
      parameter,
      parsedRequest.context,
    );
    const general = selectCandidates(generalCandidates);
    const lowDataRules = historicalCandidates.map(({ rule }) => rule);
    if (!general && generalCandidates.length > 0) {
      warnings.push(conflictWarning(parameter, "general guidance"));
      reviewRequired = true;
      continue;
    }
    if (general) {
      const lowDataSampleCount = lowDataRules.length
        ? Math.max(...lowDataRules.map((rule) => rule.sample_count))
        : 0;
      const lowDataWarning = lowDataRules.length
        ? `Low-sample historical evidence for ${parameter} fell back to general guidance`
        : `No qualifying historical evidence for ${parameter}; general guidance used`;
      warnings.push(lowDataWarning);
      priors.push(
        makePrior(
          parameter,
          "general_fallback",
          general,
          `${lowDataWarning}; confidence is capped to avoid invented certainty`,
          Math.min(general.selected.confidence, LOW_DATA_STYLE_PRIOR_CONFIDENCE_CAP),
          lowDataSampleCount,
          lowDataRules,
        ),
      );
      continue;
    }

    warnings.push(`No general guidance is available for ${parameter}; manual review required`);
    reviewRequired = true;
  }

  return StylePriorPlanSchema.parse({
    schema_version: parsedRequest.schema_version,
    preference_registry_version: PREFERENCE_REGISTRY_VERSION,
    context: parsedRequest.context,
    priors,
    warnings,
    review_required: reviewRequired,
  });
}

/** Resolve Style Priors into normalized operations without applying them. */
export function resolveStylePriorOperations(plan: unknown) {
  const parsedPlan = StylePriorPlanSchema.parse(plan);
  return parsedPlan.priors.map((prior) => {
    const definition = getParameterDefinition(prior.parameter);
    if (!definition.allowed_modes.includes(prior.mode)) {
      throw new Error(`Style Prior does not allow ${prior.mode} mode: ${prior.parameter}`);
    }
    const range = prior.mode === "absolute" ? definition.absolute_range : definition.delta_range;
    if (prior.value < range[0] || prior.value > range[1]) {
      throw new Error(`Style Prior value is out of range: ${prior.parameter}`);
    }
    return {
      parameter: prior.parameter,
      mode: prior.mode,
      value: prior.value,
      confidence: prior.confidence,
      rationale: prior.rationale.slice(0, 500),
    };
  });
}

export type StylePriorGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: StylePriorPlan;
};

/** Execute one independently owned Style Prior golden vector. */
export function runStylePriorGoldenVector(vector: unknown): StylePriorGoldenVectorResult {
  const parsed: StylePriorGoldenVector = StylePriorGoldenVectorSchema.parse(vector);
  const actualPlan = translateStylePriorRequest(parsed.request);
  if (
    JSON.stringify(canonicalize(actualPlan)) !== JSON.stringify(canonicalize(parsed.expected_plan))
  ) {
    throw new Error(`Style Prior golden vector failed: ${parsed.id}`);
  }
  return { id: parsed.id, control_group: parsed.control_group, plan: actualPlan };
}

/** Run preference vectors independently and reject duplicate IDs. */
export function runStylePriorGoldenVectors(
  vectors: readonly unknown[],
): StylePriorGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = StylePriorGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) throw new Error(`Duplicate Style Prior golden vector: ${parsed.id}`);
    seen.add(parsed.id);
    return runStylePriorGoldenVector(parsed);
  });
}

export const assertStylePriorGoldenVector = runStylePriorGoldenVector;
