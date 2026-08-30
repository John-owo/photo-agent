import { NormalizedEditPlanSchema } from "./schemas.js";
import {
  getParameterDefinition,
  PARAMETER_REGISTRY,
  PARAMETER_REGISTRY_VERSION,
  validateNormalizedPlan,
} from "./parameter-registry.js";
import type { NormalizedEditPlan, SemanticIntentPlan } from "./types.js";

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

export const LIGHTROOM_CHECKPOINT_KEYS = Object.values(PARAMETER_REGISTRY)
  .map((definition) => definition.backend_key)
  .concat("WhiteBalance");
