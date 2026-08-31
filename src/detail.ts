import {
  BackendCapabilityManifestSchema,
  DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING,
  DETAIL_HIGH_ISO_THRESHOLD,
  DETAIL_NOISE_REDUCTION_MIN_ISO,
  DETAIL_PORTRAIT_MIN_SHARPEN_MASKING,
  DETAIL_OPERATION_VARIANTS,
  DETAIL_PROPAGATION_POLICY,
  DETAIL_REGISTRY_VERSION,
  DetailGoldenVectorSchema,
  DetailIntentSchema,
  DetailPlanSchema,
  DetailReadbackSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type {
  BackendCapabilityManifest,
  DetailGoldenVector,
  DetailIntent,
  DetailOperation,
  DetailPayload,
  DetailPlan,
  DetailReadback,
} from "./types.js";

export const DETAIL_OPERATION_CAPABILITY = "apply_global_adjustment" as const;
export const MIN_EXECUTABLE_DETAIL_CONFIDENCE = 0.65;

export const DETAIL_BACKEND_SETTINGS = {
  sharpening: ["Sharpness", "SharpenRadius", "SharpenDetail", "SharpenEdgeMasking"],
  noise_reduction: [
    "LuminanceSmoothing",
    "LuminanceNoiseReductionDetail",
    "LuminanceNoiseReductionContrast",
    "ColorNoiseReduction",
    "ColorNoiseReductionDetail",
    "ColorNoiseReductionSmoothness",
  ],
} as const satisfies Record<(typeof DETAIL_OPERATION_VARIANTS)[number], readonly string[]>;

type DetailCapabilityOperation = (typeof DETAIL_OPERATION_VARIANTS)[number];

function payloadForOperation(operation: DetailOperation): DetailPayload {
  if (operation.kind === "sharpening") {
    return {
      kind: "sharpening",
      amount: operation.amount,
      radius: operation.radius,
      detail: operation.detail,
      masking: operation.masking,
    };
  }
  return {
    kind: "noise_reduction",
    luminance: operation.luminance,
    luminance_detail: operation.luminance_detail,
    luminance_contrast: operation.luminance_contrast,
    color: operation.color,
    color_detail: operation.color_detail,
    color_smoothness: operation.color_smoothness,
  };
}

function settingsForOperation(operation: DetailOperation): Record<string, number> {
  if (operation.kind === "sharpening") {
    return {
      Sharpness: operation.amount,
      SharpenRadius: operation.radius,
      SharpenDetail: operation.detail,
      SharpenEdgeMasking: operation.masking,
    };
  }
  return {
    LuminanceSmoothing: operation.luminance,
    LuminanceNoiseReductionDetail: operation.luminance_detail,
    LuminanceNoiseReductionContrast: operation.luminance_contrast,
    ColorNoiseReduction: operation.color,
    ColorNoiseReductionDetail: operation.color_detail,
    ColorNoiseReductionSmoothness: operation.color_smoothness,
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

function detailOperationOrder(kind: string): number {
  const index = DETAIL_OPERATION_VARIANTS.indexOf(
    kind as (typeof DETAIL_OPERATION_VARIANTS)[number],
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function validateDetailPlan(plan: unknown): DetailPlan {
  return DetailPlanSchema.parse(plan);
}

/** Translate scene/ISO-conditioned detail intent without invoking a backend. */
export function translateDetailIntent(intent: DetailIntent): DetailPlan {
  const parsedIntent = DetailIntentSchema.parse(intent);
  const warnings: string[] = [];
  const operations = parsedIntent.operations.filter((operation) => {
    if (operation.confidence < MIN_EXECUTABLE_DETAIL_CONFIDENCE) {
      warnings.push(
        `Skipped low-confidence ${operation.kind} detail operation (${operation.confidence.toFixed(2)})`,
      );
      return false;
    }
    if (
      operation.kind === "noise_reduction" &&
      parsedIntent.context.iso < DETAIL_NOISE_REDUCTION_MIN_ISO
    ) {
      warnings.push(
        `Skipped noise_reduction: ISO ${parsedIntent.context.iso} is below ${DETAIL_NOISE_REDUCTION_MIN_ISO}; manual review required`,
      );
      return false;
    }
    if (
      operation.kind === "sharpening" &&
      /portrait|people|wedding|skin/i.test(parsedIntent.context.scene_type) &&
      operation.masking < DETAIL_PORTRAIT_MIN_SHARPEN_MASKING
    ) {
      warnings.push(
        `Skipped sharpening: portrait-like scenes require masking >= ${DETAIL_PORTRAIT_MIN_SHARPEN_MASKING}; manual review required`,
      );
      return false;
    }
    if (
      operation.kind === "sharpening" &&
      parsedIntent.context.iso >= DETAIL_HIGH_ISO_THRESHOLD &&
      operation.masking < DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING
    ) {
      warnings.push(
        `Skipped sharpening: high-ISO scenes require masking >= ${DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING}; manual review required`,
      );
      return false;
    }
    return true;
  });

  if (operations.length === 0) {
    warnings.push(
      "No executable detail operation met the confidence/dependency policy; manual review required",
    );
  }

  return DetailPlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    detail_registry_version: DETAIL_REGISTRY_VERSION,
    context: parsedIntent.context,
    operations,
    warnings,
    propagation_policy: DETAIL_PROPAGATION_POLICY,
  });
}

/** Resolve the eventual backend setting payload without performing a mutation. */
export function resolveDetailSettings(plan: unknown): Record<string, number> {
  const validatedPlan = DetailPlanSchema.parse(plan);
  return Object.assign({}, ...validatedPlan.operations.map(settingsForOperation));
}

/**
 * Require both operation-family and concrete-setting declarations. The
 * current BackendAdapter has no detail-specific mutation API, so this remains
 * a planning/refusal boundary until the external backend contract exists.
 */
export function assertBackendSupportsDetailPlan(
  manifest: BackendCapabilityManifest,
  plan: DetailPlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = DetailPlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error("Detail propagation is not eligible under the current registry policy");
  }
  if (parsedPlan.operations.length === 0) return;

  const semantics = parsedManifest.operations[DETAIL_OPERATION_CAPABILITY];
  if (!parsedManifest.capabilities.includes(DETAIL_OPERATION_CAPABILITY) || !semantics?.supported) {
    throw new Error("Backend does not advertise apply_global_adjustment for detail planning");
  }
  const supportedOperations = semantics.supported_detail_operations;
  if (!supportedOperations) {
    throw new Error("Backend does not declare structured detail-operation support");
  }
  const missingOperations = [
    ...new Set(
      parsedPlan.operations
        .map((operation) => operation.kind)
        .filter((kind) => !supportedOperations.includes(kind)),
    ),
  ];
  if (missingOperations.length > 0) {
    throw new Error(
      `Backend does not declare structured detail support for: ${missingOperations.join(", ")}`,
    );
  }
  const supportedSettings = semantics.supported_settings;
  if (!supportedSettings) {
    throw new Error("Backend does not declare concrete detail settings support");
  }
  const missingSettings = [
    ...new Set(
      parsedPlan.operations.flatMap((operation) =>
        DETAIL_BACKEND_SETTINGS[operation.kind].filter(
          (setting) => !supportedSettings.includes(setting),
        ),
      ),
    ),
  ];
  if (missingSettings.length > 0) {
    throw new Error(`Backend does not declare detail settings: ${missingSettings.join(", ")}`);
  }
}

export type DetailCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  missing_operations: readonly DetailCapabilityOperation[];
  missing_settings: readonly string[];
  reason?: string;
};

/** Convert capability absence or incomplete declarations into review. */
export function assessDetailCapability(
  manifest: unknown,
  plan: unknown,
): DetailCapabilityAssessment {
  const parsedPlan = DetailPlanSchema.parse(plan);
  if (parsedPlan.operations.length === 0) {
    return {
      outcome: "REVIEW_REQUIRED",
      missing_operations: [],
      missing_settings: [],
      reason: parsedPlan.warnings.join(" "),
    };
  }
  try {
    assertBackendSupportsDetailPlan(BackendCapabilityManifestSchema.parse(manifest), parsedPlan);
    return { outcome: "READY", missing_operations: [], missing_settings: [] };
  } catch (error) {
    const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
    const semantics = parsedManifest.success
      ? parsedManifest.data.operations[DETAIL_OPERATION_CAPABILITY]
      : undefined;
    const supportedOperations = semantics?.supported_detail_operations ?? [];
    const missingOperations = [
      ...new Set(
        parsedPlan.operations
          .map((operation) => operation.kind)
          .filter((kind): kind is DetailCapabilityOperation => !supportedOperations.includes(kind)),
      ),
    ];
    const supportedSettings = semantics?.supported_settings ?? [];
    const missingSettings = [
      ...new Set(
        parsedPlan.operations.flatMap((operation) =>
          DETAIL_BACKEND_SETTINGS[operation.kind].filter(
            (setting) => !supportedSettings.includes(setting),
          ),
        ),
      ),
    ];
    return {
      outcome: "REVIEW_REQUIRED",
      missing_operations: missingOperations,
      missing_settings: missingSettings,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Build the expected post-apply settings state from a readback snapshot. */
export function resolveDetailReadback(current: unknown, plan: unknown): DetailReadback {
  const currentReadback = DetailReadbackSchema.parse(current);
  const validatedPlan = DetailPlanSchema.parse(plan);
  const operations = new Map<string, DetailPayload>(
    currentReadback.operations.map((operation) => [operation.kind, operation]),
  );
  for (const operation of validatedPlan.operations) {
    operations.set(operation.kind, payloadForOperation(operation));
  }
  return DetailReadbackSchema.parse({
    schema_version: SCHEMA_VERSION,
    detail_registry_version: DETAIL_REGISTRY_VERSION,
    operations: [...operations.values()].sort(
      (left, right) => detailOperationOrder(left.kind) - detailOperationOrder(right.kind),
    ),
  });
}

/** Verify only operation families requested by the plan against readback. */
export function assertDetailReadback(plan: DetailPlan, readback: unknown): DetailReadback {
  const validatedPlan = DetailPlanSchema.parse(plan);
  const parsedReadback = DetailReadbackSchema.parse(readback);
  const operationsByKind = new Map(
    parsedReadback.operations.map((operation) => [operation.kind, operation]),
  );
  for (const operation of validatedPlan.operations) {
    const actual = operationsByKind.get(operation.kind);
    if (!actual || !sameValue(actual, payloadForOperation(operation))) {
      throw new Error(`Detail readback mismatch: ${operation.kind}`);
    }
  }
  return parsedReadback;
}

export type DetailGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: DetailPlan;
  settings: Record<string, number>;
  readback?: DetailReadback;
};

/** Execute one independently owned scene/ISO detail golden vector. */
export function runDetailGoldenVector(vector: unknown): DetailGoldenVectorResult {
  const parsed: DetailGoldenVector = DetailGoldenVectorSchema.parse(vector);
  const actualPlan = translateDetailIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Detail golden vector failed: ${parsed.id}`);
  }
  const result: DetailGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
    settings: resolveDetailSettings(actualPlan),
  };
  if (parsed.current_readback !== undefined && parsed.expected_readback !== undefined) {
    const actualReadback = resolveDetailReadback(parsed.current_readback, actualPlan);
    if (!sameValue(actualReadback, parsed.expected_readback)) {
      throw new Error(`Detail golden vector readback failed: ${parsed.id}`);
    }
    result.readback = assertDetailReadback(actualPlan, actualReadback);
  }
  return result;
}

/** Run vectors without sharing mutable state between detail control groups. */
export function runDetailGoldenVectors(vectors: readonly unknown[]): DetailGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = DetailGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate detail golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runDetailGoldenVector(parsed);
  });
}

export const assertDetailGoldenVector = runDetailGoldenVector;
