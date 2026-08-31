import {
  BackendCapabilityManifestSchema,
  SCHEMA_VERSION,
  TONE_CURVE_PROPAGATION_POLICY,
  TONE_CURVE_REGISTRY_VERSION,
  TONE_CURVE_VARIANTS,
  ToneCurveGoldenVectorSchema,
  ToneCurveIntentSchema,
  ToneCurvePlanSchema,
  ToneCurveReadbackSchema,
} from "./schemas.js";
import type {
  BackendCapabilityManifest,
  ToneCurveGoldenVector,
  ToneCurveIntent,
  ToneCurveOperation,
  ToneCurvePlan,
  ToneCurveReadback,
} from "./types.js";

export const TONE_CURVE_OPERATION_CAPABILITY = "apply_global_adjustment" as const;
export const MIN_EXECUTABLE_TONE_CURVE_CONFIDENCE = 0.65;

type ToneCurvePayload = ToneCurveReadback["curves"][number];

function payloadForOperation(operation: ToneCurveOperation): ToneCurvePayload {
  if (operation.kind === "points") {
    return {
      variant: operation.variant,
      kind: "points",
      points: operation.points,
    };
  }
  return {
    variant: "parametric",
    kind: "parametric",
    values: operation.values,
  };
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

function toneCurveVariantOrder(variant: string): number {
  const index = TONE_CURVE_VARIANTS.indexOf(variant as (typeof TONE_CURVE_VARIANTS)[number]);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function validateToneCurvePlan(plan: unknown): ToneCurvePlan {
  return ToneCurvePlanSchema.parse(plan);
}

/** Translate structured curve intent without invoking a backend or changing files. */
export function translateToneCurveIntent(intent: ToneCurveIntent): ToneCurvePlan {
  const parsedIntent = ToneCurveIntentSchema.parse(intent);
  const warnings: string[] = [];
  const operations = parsedIntent.operations.filter((operation) => {
    if (operation.confidence < MIN_EXECUTABLE_TONE_CURVE_CONFIDENCE) {
      warnings.push(
        `Skipped low-confidence ${operation.variant} tone-curve operation (${operation.confidence.toFixed(2)})`,
      );
      return false;
    }
    return true;
  });

  if (operations.length === 0) {
    warnings.push(
      "No executable tone-curve operation met the confidence threshold; manual review required",
    );
  }

  return ToneCurvePlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
    operations,
    warnings,
    propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
  });
}

/**
 * Fail closed unless the negotiated backend explicitly lists every structured
 * curve variant. The existing BackendAdapter has no curve mutation method;
 * this is therefore a planning-time capability boundary only.
 */
export function assertBackendSupportsToneCurvePlan(
  manifest: BackendCapabilityManifest,
  plan: ToneCurvePlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = ToneCurvePlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error("Tone-curve propagation is not eligible under the current registry policy");
  }
  if (parsedPlan.operations.length === 0) return;

  const semantics = parsedManifest.operations[TONE_CURVE_OPERATION_CAPABILITY];
  if (
    !parsedManifest.capabilities.includes(TONE_CURVE_OPERATION_CAPABILITY) ||
    !semantics?.supported
  ) {
    throw new Error(
      "Backend does not advertise apply_global_adjustment for structured tone-curve planning",
    );
  }

  const supportedVariants = semantics.supported_curve_variants;
  if (!supportedVariants) {
    throw new Error("Backend does not declare structured tone-curve variant support");
  }
  const missingVariants = [
    ...new Set(
      parsedPlan.operations
        .map((operation) => operation.variant)
        .filter((variant) => !supportedVariants.includes(variant)),
    ),
  ];
  if (missingVariants.length > 0) {
    throw new Error(
      `Backend does not declare structured tone-curve support for: ${missingVariants.join(", ")}`,
    );
  }
}

export type ToneCurveCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  missing_variants: readonly string[];
  reason?: string;
};

/** Return a review-safe outcome instead of turning an undeclared capability into an apply. */
export function assessToneCurveCapability(
  manifest: unknown,
  plan: unknown,
): ToneCurveCapabilityAssessment {
  const parsedPlan = ToneCurvePlanSchema.parse(plan);
  if (parsedPlan.operations.length === 0) {
    return { outcome: "READY", missing_variants: [] };
  }
  try {
    assertBackendSupportsToneCurvePlan(BackendCapabilityManifestSchema.parse(manifest), parsedPlan);
    return { outcome: "READY", missing_variants: [] };
  } catch (error) {
    const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
    const supported = parsedManifest.success
      ? (parsedManifest.data.operations[TONE_CURVE_OPERATION_CAPABILITY]
          ?.supported_curve_variants ?? [])
      : [];
    const missingVariants = [
      ...new Set(
        parsedPlan.operations
          .map((operation) => operation.variant)
          .filter((variant) => !supported.includes(variant)),
      ),
    ];
    return {
      outcome: "REVIEW_REQUIRED",
      missing_variants: missingVariants,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build the expected post-apply state from a readback snapshot. This is a
 * deterministic contract helper, not evidence of a real backend mutation.
 */
export function resolveToneCurveReadback(current: unknown, plan: unknown): ToneCurveReadback {
  const currentReadback = ToneCurveReadbackSchema.parse(current);
  const validatedPlan = ToneCurvePlanSchema.parse(plan);
  const curves = new Map<string, ToneCurvePayload>(
    currentReadback.curves.map((curve) => [curve.variant, curve]),
  );
  for (const operation of validatedPlan.operations) {
    curves.set(operation.variant, payloadForOperation(operation));
  }
  return ToneCurveReadbackSchema.parse({
    schema_version: SCHEMA_VERSION,
    tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
    curves: [...curves.values()].sort(
      (left, right) => toneCurveVariantOrder(left.variant) - toneCurveVariantOrder(right.variant),
    ),
  });
}

/** Verify only the variants requested by the plan against an actual readback. */
export function assertToneCurveReadback(plan: ToneCurvePlan, readback: unknown): ToneCurveReadback {
  const validatedPlan = ToneCurvePlanSchema.parse(plan);
  const parsedReadback = ToneCurveReadbackSchema.parse(readback);
  const curvesByVariant = new Map(parsedReadback.curves.map((curve) => [curve.variant, curve]));
  for (const operation of validatedPlan.operations) {
    const actual = curvesByVariant.get(operation.variant);
    if (!actual || !sameValue(actual, payloadForOperation(operation))) {
      throw new Error(`Tone-curve readback mismatch: ${operation.variant}`);
    }
  }
  return parsedReadback;
}

export type ToneCurveGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: ToneCurvePlan;
  readback?: ToneCurveReadback;
};

/** Execute one independently owned structured tone-curve golden vector. */
export function runToneCurveGoldenVector(vector: unknown): ToneCurveGoldenVectorResult {
  const parsed: ToneCurveGoldenVector = ToneCurveGoldenVectorSchema.parse(vector);
  const actualPlan = translateToneCurveIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Tone-curve golden vector failed: ${parsed.id}`);
  }

  const result: ToneCurveGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
  };
  if (parsed.current_readback !== undefined && parsed.expected_readback !== undefined) {
    const actualReadback = resolveToneCurveReadback(parsed.current_readback, actualPlan);
    if (!sameValue(actualReadback, parsed.expected_readback)) {
      throw new Error(`Tone-curve golden vector readback failed: ${parsed.id}`);
    }
    result.readback = assertToneCurveReadback(actualPlan, actualReadback);
  }
  return result;
}

/** Run curve vectors without sharing mutable state between control groups. */
export function runToneCurveGoldenVectors(
  vectors: readonly unknown[],
): ToneCurveGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = ToneCurveGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate tone-curve golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runToneCurveGoldenVector(parsed);
  });
}

export const assertToneCurveGoldenVector = runToneCurveGoldenVector;
