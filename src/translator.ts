import { translateMasks } from "./masks.js";
import { NormalizedEditPlanSchema } from "./schemas.js";
import type { NormalizedEditPlan, SemanticIntentPlan } from "./types.js";

const MIN_EXECUTABLE_CONFIDENCE = 0.65;
const STRENGTH_MULTIPLIER = { slight: 1, medium: 2, strong: 3 } as const;
const BASE_STEP: Record<string, number> = {
  exposure: 0.2,
  temperature: 250,
  tint: 5,
  contrast: 8,
  highlights: 8,
  shadows: 8,
  whites: 8,
  blacks: 8,
  texture: 8,
  clarity: 8,
  dehaze: 8,
  vibrance: 8,
  saturation: 8,
};

const NORMALIZED_NAME: Record<string, string> = {
  exposure: "exposure_ev",
  temperature: "temperature_k",
  tint: "tint",
  contrast: "contrast",
  highlights: "highlights",
  shadows: "shadows",
  whites: "whites",
  blacks: "blacks",
  texture: "texture",
  clarity: "clarity",
  dehaze: "dehaze",
  vibrance: "vibrance",
  saturation: "saturation",
};

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
      const multiplier = STRENGTH_MULTIPLIER[adjustment.strength];
      const sign = adjustment.direction === "increase" ? 1 : -1;
      return {
        parameter: NORMALIZED_NAME[adjustment.parameter]!,
        mode: "delta" as const,
        value: sign * BASE_STEP[adjustment.parameter]! * multiplier,
        confidence: adjustment.confidence,
        rationale: adjustment.rationale,
      };
    })
    .filter((operation): operation is NonNullable<typeof operation> => operation !== null);

  const maskTranslation = translateMasks(intent.masks);
  warnings.push(...maskTranslation.warnings);
  if (operations.length === 0 && maskTranslation.masks.length === 0) {
    warnings.push("No executable adjustment met the confidence threshold; manual review required");
  }
  return NormalizedEditPlanSchema.parse({
    schema_version: "0.1.0",
    operations,
    warnings,
    ...(maskTranslation.masks.length > 0 ? { masks: maskTranslation.masks } : {}),
  });
}

const LIGHTROOM_PARAMETER: Record<string, string> = {
  exposure_ev: "Exposure2012",
  temperature_k: "Temperature",
  tint: "Tint",
  contrast: "Contrast2012",
  highlights: "Highlights2012",
  shadows: "Shadows2012",
  whites: "Whites2012",
  blacks: "Blacks2012",
  texture: "Texture",
  clarity: "Clarity2012",
  dehaze: "Dehaze",
  vibrance: "Vibrance",
  saturation: "Saturation",
};

const RANGE: Record<string, readonly [number, number]> = {
  Exposure2012: [-5, 5],
  Temperature: [2000, 50000],
  Tint: [-150, 150],
  Contrast2012: [-100, 100],
  Highlights2012: [-100, 100],
  Shadows2012: [-100, 100],
  Whites2012: [-100, 100],
  Blacks2012: [-100, 100],
  Texture: [-100, 100],
  Clarity2012: [-100, 100],
  Dehaze: [-100, 100],
  Vibrance: [-100, 100],
  Saturation: [-100, 100],
};

/**
 * Remove operations whose current Lightroom value was not read back as a number
 * (for example Temperature while White Balance is "As Shot"). The rest of the
 * plan still applies; each skipped operation is returned and added to warnings.
 */
export function dropUnreadableOperations(
  current: Record<string, number | string | boolean>,
  plan: NormalizedEditPlan,
): { plan: NormalizedEditPlan; skipped: string[] } {
  const kept: NormalizedEditPlan["operations"] = [];
  const skipped: string[] = [];
  for (const operation of plan.operations) {
    const key = LIGHTROOM_PARAMETER[operation.parameter];
    if (key && typeof current[key] !== "number") {
      const whiteBalance =
        key === "Temperature" || key === "Tint"
          ? `；白平衡是 ${String(current.WhiteBalance ?? "未知")}`
          : "";
      skipped.push(
        `${operation.parameter}：Lightroom 沒有回報 ${key} 的數值${whiteBalance}，這項調整略過`,
      );
      continue;
    }
    kept.push(operation);
  }
  if (skipped.length === 0) return { plan, skipped };
  return {
    plan: { ...plan, operations: kept, warnings: [...plan.warnings, ...skipped] },
    skipped,
  };
}

export function resolveLightroomSettings(
  current: Record<string, number | string | boolean>,
  plan: NormalizedEditPlan,
): Record<string, number | string | boolean> {
  const settings: Record<string, number | string | boolean> = {};
  for (const operation of plan.operations) {
    const key = LIGHTROOM_PARAMETER[operation.parameter];
    if (!key) continue;
    const currentValue = current[key];
    if (typeof currentValue !== "number") {
      throw new Error(`Lightroom read-back did not provide numeric ${key}; refusing mutation`);
    }
    const range = RANGE[key];
    if (!range) throw new Error(`No safe range registered for ${key}`);
    const next = Math.min(range[1], Math.max(range[0], currentValue + operation.value));
    settings[key] = Number(next.toFixed(4));
  }
  if (settings.Temperature !== undefined || settings.Tint !== undefined) {
    settings.WhiteBalance = "Custom";
  }
  return settings;
}

export const LIGHTROOM_CHECKPOINT_KEYS = Object.values(LIGHTROOM_PARAMETER).concat("WhiteBalance");

/**
 * Checkpoint only the keys Lightroom reported: the plugin refuses a preset for a
 * key the photo does not have (Temperature/Tint under "As Shot"). Every key about
 * to be written must still be covered, otherwise the mutation is refused.
 */
export function checkpointKeysFor(
  current: Record<string, number | string | boolean>,
  settingsToWrite: Record<string, number | string | boolean>,
): string[] {
  const keys = LIGHTROOM_CHECKPOINT_KEYS.filter((key) => current[key] !== undefined);
  const uncovered = Object.keys(settingsToWrite).filter((key) => !keys.includes(key));
  if (uncovered.length > 0) {
    throw new Error(
      `Cannot checkpoint ${uncovered.join(", ")}: Lightroom did not report the current value; refusing mutation`,
    );
  }
  return keys;
}
