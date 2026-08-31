import {
  BackendCapabilityManifestSchema,
  FINISHING_PROPAGATION_POLICY,
  FINISHING_REGISTRY_VERSION,
  FinishingGoldenVectorSchema,
  FinishingIntentSchema,
  FinishingPlanSchema,
  FinishingReadbackSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type {
  BackendCapabilityManifest,
  FinishingGoldenVector,
  FinishingIntent,
  FinishingOperation,
  FinishingPayload,
  FinishingPlan,
  FinishingReadback,
} from "./types.js";

export const FINISHING_OPERATION_CAPABILITY = "apply_global_adjustment" as const;
export const FINISHING_REQUIRED_PREREQUISITES = [
  "read_current_edit",
  "create_checkpoint",
  "render_preview",
] as const;
export const MIN_EXECUTABLE_FINISHING_CONFIDENCE = 0.65;

export const FINISHING_BACKEND_SETTINGS = {
  vignette: [
    "PostCropVignetteAmount",
    "PostCropVignetteMidpoint",
    "PostCropVignetteRoundness",
    "PostCropVignetteFeather",
  ],
  grain: ["GrainAmount", "GrainSize", "GrainRoughness"],
  crop: ["CropLeft", "CropTop", "CropRight", "CropBottom"],
  rotation: ["StraightenAngle"],
} as const;

function payloadForOperation(operation: FinishingOperation): FinishingPayload {
  if (operation.kind === "vignette") {
    return {
      kind: "vignette",
      amount: operation.amount,
      midpoint: operation.midpoint,
      roundness: operation.roundness,
      feather: operation.feather,
    };
  }
  if (operation.kind === "grain") {
    return {
      kind: "grain",
      amount: operation.amount,
      size: operation.size,
      roughness: operation.roughness,
    };
  }
  return { kind: "framing", settings: operation.settings };
}

function operationIdentity(operation: FinishingOperation | FinishingPayload): string {
  return operation.kind === "framing" ? `framing:${operation.settings.variant}` : operation.kind;
}

function settingsForOperation(operation: FinishingOperation): Record<string, number> {
  if (operation.kind === "vignette") {
    return {
      PostCropVignetteAmount: operation.amount,
      PostCropVignetteMidpoint: operation.midpoint,
      PostCropVignetteRoundness: operation.roundness,
      PostCropVignetteFeather: operation.feather,
    };
  }
  if (operation.kind === "grain") {
    return {
      GrainAmount: operation.amount,
      GrainSize: operation.size,
      GrainRoughness: operation.roughness,
    };
  }
  if (operation.settings.variant === "crop") {
    return {
      CropLeft: operation.settings.left,
      CropTop: operation.settings.top,
      CropRight: operation.settings.right,
      CropBottom: operation.settings.bottom,
    };
  }
  return { StraightenAngle: operation.settings.angle };
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

export function validateFinishingPlan(plan: unknown): FinishingPlan {
  return FinishingPlanSchema.parse(plan);
}

/** Translate finishing intent without backend, catalog, or file effects. */
export function translateFinishingIntent(intent: FinishingIntent): FinishingPlan {
  const parsedIntent = FinishingIntentSchema.parse(intent);
  const warnings: string[] = [];
  const operations = parsedIntent.operations.filter((operation) => {
    if (operation.confidence < MIN_EXECUTABLE_FINISHING_CONFIDENCE) {
      warnings.push(
        `Skipped low-confidence ${operationIdentity(operation)} finishing operation (${operation.confidence.toFixed(2)})`,
      );
      return false;
    }
    return true;
  });
  if (operations.length === 0) {
    warnings.push(
      "No executable finishing operation met the confidence threshold; manual review required",
    );
  }
  return FinishingPlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    finishing_registry_version: FINISHING_REGISTRY_VERSION,
    operations,
    warnings,
    human_review_required: operations.some((operation) => operation.kind === "framing"),
    propagation_policy: FINISHING_PROPAGATION_POLICY,
  });
}

function requiredSettings(plan: FinishingPlan): string[] {
  return [
    ...new Set(
      plan.operations.flatMap((operation) => {
        if (operation.kind === "framing") {
          return FINISHING_BACKEND_SETTINGS[operation.settings.variant];
        }
        return FINISHING_BACKEND_SETTINGS[operation.kind];
      }),
    ),
  ];
}

/** Refuse automatic execution of crop/rotation and incomplete capability manifests. */
export function assertBackendSupportsFinishingPlan(
  manifest: BackendCapabilityManifest,
  plan: FinishingPlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = FinishingPlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error("Finishing propagation is not eligible under the current registry policy");
  }
  if (parsedPlan.operations.length === 0) return;
  if (parsedPlan.human_review_required) {
    throw new Error("Crop and rotation require explicit per-photo human review before execution");
  }

  const missingPrerequisites = FINISHING_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !parsedManifest.capabilities.includes(capability) ||
      !parsedManifest.operations[capability]?.supported,
  );
  if (missingPrerequisites.length > 0) {
    throw new Error(
      `Backend is missing finishing prerequisites: ${missingPrerequisites.join(", ")}`,
    );
  }
  const semantics = parsedManifest.operations[FINISHING_OPERATION_CAPABILITY];
  if (
    !parsedManifest.capabilities.includes(FINISHING_OPERATION_CAPABILITY) ||
    !semantics?.supported
  ) {
    throw new Error("Backend does not advertise apply_global_adjustment for finishing planning");
  }
  const supportedControls = semantics.supported_finishing_controls;
  if (!supportedControls) {
    throw new Error("Backend does not declare finishing-control support");
  }
  const missingControls = [
    ...new Set(
      parsedPlan.operations
        .map((operation) => operation.kind)
        .filter((kind) => !supportedControls.includes(kind)),
    ),
  ];
  if (missingControls.length > 0) {
    throw new Error(`Backend does not declare finishing controls: ${missingControls.join(", ")}`);
  }
  const supportedSettings = semantics.supported_settings;
  if (!supportedSettings) {
    throw new Error("Backend does not declare concrete finishing settings support");
  }
  const missingSettings = requiredSettings(parsedPlan).filter(
    (setting) => !supportedSettings.includes(setting),
  );
  if (missingSettings.length > 0) {
    throw new Error(`Backend does not declare finishing settings: ${missingSettings.join(", ")}`);
  }
}

export type FinishingCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  missing_prerequisites: readonly string[];
  missing_capabilities: readonly string[];
  missing_settings: readonly string[];
  reason?: string;
};

/** Return review for high-risk framing or undeclared finishing capabilities. */
export function assessFinishingCapability(
  manifest: unknown,
  plan: unknown,
): FinishingCapabilityAssessment {
  const parsedPlan = FinishingPlanSchema.parse(plan);
  if (parsedPlan.operations.length === 0) {
    return {
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
      reason: parsedPlan.warnings.join(" "),
    };
  }
  if (parsedPlan.human_review_required) {
    return {
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: [],
      missing_capabilities: ["explicit_per_photo_human_review"],
      missing_settings: [],
      reason: "Crop and rotation are high-risk framing decisions and are not auto-applied",
    };
  }
  try {
    assertBackendSupportsFinishingPlan(BackendCapabilityManifestSchema.parse(manifest), parsedPlan);
    return {
      outcome: "READY",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
    };
  } catch (error) {
    const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
    const semantics = parsedManifest.success
      ? parsedManifest.data.operations[FINISHING_OPERATION_CAPABILITY]
      : undefined;
    const missingPrerequisites = FINISHING_REQUIRED_PREREQUISITES.filter(
      (capability) =>
        !parsedManifest.success ||
        !parsedManifest.data.capabilities.includes(capability) ||
        !parsedManifest.data.operations[capability]?.supported,
    );
    const supportedControls = semantics?.supported_finishing_controls ?? [];
    const missingCapabilities = [
      ...new Set(
        parsedPlan.operations
          .map((operation) => operation.kind)
          .filter((kind) => !supportedControls.includes(kind)),
      ),
    ];
    const supportedSettings = semantics?.supported_settings ?? [];
    const missingSettings = requiredSettings(parsedPlan).filter(
      (setting) => !supportedSettings.includes(setting),
    );
    return {
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: missingPrerequisites,
      missing_capabilities: missingCapabilities,
      missing_settings: missingSettings,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolve the eventual finishing settings without invoking a backend. */
export function resolveFinishingSettings(plan: unknown): Record<string, number> {
  const validatedPlan = FinishingPlanSchema.parse(plan);
  return Object.assign({}, ...validatedPlan.operations.map(settingsForOperation));
}

/** Build deterministic expected state from a current finishing readback. */
export function resolveFinishingReadback(current: unknown, plan: unknown): FinishingReadback {
  const currentReadback = FinishingReadbackSchema.parse(current);
  const validatedPlan = FinishingPlanSchema.parse(plan);
  const operations = new Map<string, FinishingPayload>(
    currentReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    operations.set(operationIdentity(operation), payloadForOperation(operation));
  }
  return FinishingReadbackSchema.parse({
    schema_version: SCHEMA_VERSION,
    finishing_registry_version: FINISHING_REGISTRY_VERSION,
    operations: [...operations.values()].sort((left, right) =>
      operationIdentity(left).localeCompare(operationIdentity(right)),
    ),
  });
}

/** Verify requested finishing and framing values against readback. */
export function assertFinishingReadback(plan: FinishingPlan, readback: unknown): FinishingReadback {
  const validatedPlan = FinishingPlanSchema.parse(plan);
  const parsedReadback = FinishingReadbackSchema.parse(readback);
  const operations = new Map(
    parsedReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    const actual = operations.get(operationIdentity(operation));
    if (!actual || !sameValue(actual, payloadForOperation(operation))) {
      throw new Error(`Finishing readback mismatch: ${operationIdentity(operation)}`);
    }
  }
  return parsedReadback;
}

export type FinishingGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: FinishingPlan;
  settings: Record<string, number>;
  readback?: FinishingReadback;
};

/** Execute one independently owned finishing/framing golden vector. */
export function runFinishingGoldenVector(vector: unknown): FinishingGoldenVectorResult {
  const parsed: FinishingGoldenVector = FinishingGoldenVectorSchema.parse(vector);
  const actualPlan = translateFinishingIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Finishing golden vector failed: ${parsed.id}`);
  }
  const result: FinishingGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
    settings: resolveFinishingSettings(actualPlan),
  };
  if (parsed.current_readback !== undefined && parsed.expected_readback !== undefined) {
    const actualReadback = resolveFinishingReadback(parsed.current_readback, actualPlan);
    if (!sameValue(actualReadback, parsed.expected_readback)) {
      throw new Error(`Finishing golden vector readback failed: ${parsed.id}`);
    }
    result.readback = assertFinishingReadback(actualPlan, actualReadback);
  }
  return result;
}

/** Run vectors without sharing mutable state between finishing groups. */
export function runFinishingGoldenVectors(
  vectors: readonly unknown[],
): FinishingGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = FinishingGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate finishing golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runFinishingGoldenVector(parsed);
  });
}

export const assertFinishingGoldenVector = runFinishingGoldenVector;
