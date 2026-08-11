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

  if (operations.length === 0) {
    warnings.push("No executable adjustment met the confidence threshold; manual review required");
  }
  return NormalizedEditPlanSchema.parse({ schema_version: "0.1.0", operations, warnings });
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
