import { NormalizedEditPlanSchema, TranslatorGoldenVectorSchema } from "./schemas.js";
import {
  getParameterDefinition,
  migrateNormalizedPlan,
  PARAMETER_REGISTRY,
  PARAMETER_REGISTRY_VERSION,
  validateNormalizedPlan,
} from "./parameter-registry.js";
import type { NormalizedEditPlan, SemanticIntentPlan, TranslatorGoldenVector } from "./types.js";

const MIN_EXECUTABLE_CONFIDENCE = 0.65;
const STRENGTH_MULTIPLIER = { slight: 1, medium: 2, strong: 3 } as const;

export function translateIntent(intent: SemanticIntentPlan): NormalizedEditPlan {
  const warnings: string[] = [];
  const operations = intent.adjustments
    .filter((adjustment) => adjustment.direction !== "unchanged")
    .map((adjustment) => {
      if (adjustment.confidence < MIN_EXECUTABLE_CONFIDENCE) {
        warnings.push(
          `Skipped low-confidence ${adjustment.parameter} adjustment (${adjustment.confidence.toFixed(2)})`,
        );
        return null;
      }
      const definition = getParameterDefinition(adjustment.parameter);
      const multiplier = STRENGTH_MULTIPLIER[adjustment.strength];
      const sign = adjustment.direction === "increase" ? 1 : -1;
      return {
        parameter: definition.parameter,
        mode: "delta" as const,
        value: sign * definition.base_step * multiplier,
        confidence: adjustment.confidence,
        rationale: adjustment.rationale,
      };
    })
    .filter((operation): operation is NonNullable<typeof operation> => operation !== null);

  if (operations.length === 0) {
    warnings.push("No executable adjustment met the confidence threshold; manual review required");
  }
  return validateNormalizedPlan(
    NormalizedEditPlanSchema.parse({
      schema_version: "0.1.0",
      operations,
      warnings,
      parameter_registry_version: PARAMETER_REGISTRY_VERSION,
    }),
  );
}

export function resolveLightroomSettings(
  current: Record<string, number | string | boolean>,
  plan: NormalizedEditPlan,
): Record<string, number | string | boolean> {
  const validatedPlan = validateNormalizedPlan(plan);
  const settings: Record<string, number | string | boolean> = {};
  for (const operation of validatedPlan.operations) {
    const definition = getParameterDefinition(operation.parameter);
    const key = definition.backend_key;
    const currentValue = current[key];
    if (typeof currentValue !== "number") {
      throw new Error(`Lightroom read-back did not provide numeric ${key}; refusing mutation`);
    }
    const next =
      operation.mode === "absolute"
        ? operation.value
        : Math.min(
            definition.absolute_range[1],
            Math.max(definition.absolute_range[0], currentValue + operation.value),
          );
    settings[key] = Number(next.toFixed(4));
  }
  if (settings.Temperature !== undefined || settings.Tint !== undefined) {
    settings.WhiteBalance = "Custom";
  }
  return settings;
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

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function comparablePlan(
  plan: NormalizedEditPlan,
): Pick<NormalizedEditPlan, "operations" | "warnings"> {
  return { operations: plan.operations, warnings: plan.warnings };
}

export type TranslatorGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: NormalizedEditPlan;
  settings?: Record<string, number | string | boolean>;
};

/**
 * Execute one independently owned translator control-group vector. The
 * expected plan may be a legacy stored plan; it is migrated before comparison.
 */
export function runTranslatorGoldenVector(vector: unknown): TranslatorGoldenVectorResult {
  const parsed: TranslatorGoldenVector = TranslatorGoldenVectorSchema.parse(vector);
  const actualPlan = translateIntent(parsed.intent);
  const expectedPlan = migrateNormalizedPlan(parsed.expected_plan);
  if (!sameValue(comparablePlan(actualPlan), comparablePlan(expectedPlan))) {
    throw new Error(`Translator golden vector failed: ${parsed.id}`);
  }

  const result: TranslatorGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
  };
  if (parsed.current_settings !== undefined && parsed.expected_settings !== undefined) {
    const actualSettings = resolveLightroomSettings(parsed.current_settings, actualPlan);
    if (!sameValue(actualSettings, parsed.expected_settings)) {
      throw new Error(`Translator golden vector settings failed: ${parsed.id}`);
    }
    result.settings = actualSettings;
  }
  return result;
}

/** Run vectors without sharing mutable state between control groups. */
export function runTranslatorGoldenVectors(
  vectors: readonly unknown[],
): TranslatorGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = TranslatorGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) throw new Error(`Duplicate translator golden vector: ${parsed.id}`);
    seen.add(parsed.id);
    return runTranslatorGoldenVector(parsed);
  });
}

export const assertTranslatorGoldenVector = runTranslatorGoldenVector;

export const LIGHTROOM_CHECKPOINT_KEYS = Object.values(PARAMETER_REGISTRY)
  .map((definition) => definition.backend_key)
  .concat("WhiteBalance");
