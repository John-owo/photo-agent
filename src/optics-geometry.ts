import {
  BackendCapabilityManifestSchema,
  OPTICS_LENS_CONTROLS,
  OPTICS_PROPAGATION_POLICY,
  OPTICS_REGISTRY_VERSION,
  OpticsGoldenVectorSchema,
  OpticsIntentSchema,
  OpticsPlanSchema,
  OpticsReadbackSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type {
  BackendCapabilityManifest,
  OpticsGoldenVector,
  OpticsIntent,
  OpticsOperation,
  OpticsPayload,
  OpticsPlan,
  OpticsReadback,
} from "./types.js";

export const OPTICS_OPERATION_CAPABILITY = "apply_global_adjustment" as const;
export const OPTICS_REQUIRED_PREREQUISITES = [
  "read_current_edit",
  "create_checkpoint",
  "render_preview",
] as const;
export const MIN_EXECUTABLE_OPTICS_CONFIDENCE = 0.65;

export const OPTICS_BACKEND_SETTINGS = {
  lens_correction: ["EnableProfileCorrections", "RemoveChromaticAberration"],
  profile: ["CameraProfile"],
  crop: ["CropLeft", "CropTop", "CropRight", "CropBottom"],
  rotation: ["StraightenAngle"],
  perspective: ["PerspectiveHorizontal", "PerspectiveVertical", "PerspectiveScale"],
} as const;

function payloadForOperation(operation: OpticsOperation): OpticsPayload {
  if (operation.kind === "lens_correction") {
    return {
      kind: "lens_correction",
      profile_corrections: operation.profile_corrections,
      chromatic_aberration: operation.chromatic_aberration,
    };
  }
  if (operation.kind === "profile") {
    return { kind: "profile", profile_name: operation.profile_name };
  }
  return { kind: "geometry", settings: operation.settings };
}

function settingsForOperation(
  operation: OpticsOperation,
): Record<string, number | string | boolean> {
  if (operation.kind === "lens_correction") {
    return {
      EnableProfileCorrections: operation.profile_corrections,
      RemoveChromaticAberration: operation.chromatic_aberration,
    };
  }
  if (operation.kind === "profile") return { CameraProfile: operation.profile_name };
  if (operation.settings.variant === "crop") {
    return {
      CropLeft: operation.settings.left,
      CropTop: operation.settings.top,
      CropRight: operation.settings.right,
      CropBottom: operation.settings.bottom,
    };
  }
  if (operation.settings.variant === "rotation") {
    return { StraightenAngle: operation.settings.angle };
  }
  return {
    PerspectiveHorizontal: operation.settings.horizontal,
    PerspectiveVertical: operation.settings.vertical,
    PerspectiveScale: operation.settings.scale,
  };
}

function operationIdentity(operation: OpticsOperation | OpticsPayload): string {
  if (operation.kind !== "geometry") return operation.kind;
  return `geometry:${operation.settings.variant}`;
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

export function validateOpticsPlan(plan: unknown): OpticsPlan {
  return OpticsPlanSchema.parse(plan);
}

/** Translate optics/profile/geometry intent without backend or file effects. */
export function translateOpticsIntent(intent: OpticsIntent): OpticsPlan {
  const parsedIntent = OpticsIntentSchema.parse(intent);
  const warnings: string[] = [];
  const operations = parsedIntent.operations.filter((operation) => {
    if (operation.confidence < MIN_EXECUTABLE_OPTICS_CONFIDENCE) {
      warnings.push(
        `Skipped low-confidence ${operationIdentity(operation)} optics operation (${operation.confidence.toFixed(2)})`,
      );
      return false;
    }
    return true;
  });
  if (operations.length === 0) {
    warnings.push(
      "No executable optics operation met the confidence threshold; manual review required",
    );
  }
  return OpticsPlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    optics_registry_version: OPTICS_REGISTRY_VERSION,
    operations,
    warnings,
    propagation_policy: OPTICS_PROPAGATION_POLICY,
  });
}

function requiredSettings(plan: OpticsPlan): string[] {
  return [
    ...new Set(
      plan.operations.flatMap((operation) => {
        if (operation.kind === "geometry") {
          return OPTICS_BACKEND_SETTINGS[operation.settings.variant];
        }
        return OPTICS_BACKEND_SETTINGS[operation.kind];
      }),
    ),
  ];
}

/** Fail closed before write when a profile, geometry variant, or prerequisite is absent. */
export function assertBackendSupportsOpticsPlan(
  manifest: BackendCapabilityManifest,
  plan: OpticsPlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = OpticsPlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error("Optics propagation is not eligible under the current registry policy");
  }
  if (parsedPlan.operations.length === 0) return;

  const missingPrerequisites = OPTICS_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !parsedManifest.capabilities.includes(capability) ||
      !parsedManifest.operations[capability]?.supported,
  );
  if (missingPrerequisites.length > 0) {
    throw new Error(`Backend is missing optics prerequisites: ${missingPrerequisites.join(", ")}`);
  }

  const semantics = parsedManifest.operations[OPTICS_OPERATION_CAPABILITY];
  if (!parsedManifest.capabilities.includes(OPTICS_OPERATION_CAPABILITY) || !semantics?.supported) {
    throw new Error("Backend does not advertise apply_global_adjustment for optics planning");
  }
  for (const operation of parsedPlan.operations) {
    if (operation.kind === "lens_correction") {
      if (!semantics.supported_lens_controls) {
        throw new Error("Backend does not declare lens-correction control support");
      }
      const missingControls = OPTICS_LENS_CONTROLS.filter(
        (control) => !semantics.supported_lens_controls?.includes(control),
      );
      if (missingControls.length > 0) {
        throw new Error(`Backend does not declare lens controls: ${missingControls.join(", ")}`);
      }
    } else if (operation.kind === "profile") {
      if (!semantics.supported_profiles?.includes(operation.profile_name)) {
        throw new Error(`Backend does not declare profile support: ${operation.profile_name}`);
      }
    } else {
      const variant = operation.settings.variant;
      if (!semantics.supported_geometry_variants?.includes(variant)) {
        throw new Error(`Backend does not declare geometry variant support: ${variant}`);
      }
    }
  }
  if (!semantics.supported_settings) {
    throw new Error("Backend does not declare concrete optics settings support");
  }
  const missingSettings = requiredSettings(parsedPlan).filter(
    (setting) => !semantics.supported_settings?.includes(setting),
  );
  if (missingSettings.length > 0) {
    throw new Error(`Backend does not declare optics settings: ${missingSettings.join(", ")}`);
  }
}

export type OpticsCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  missing_prerequisites: readonly string[];
  missing_capabilities: readonly string[];
  missing_settings: readonly string[];
  reason?: string;
};

/** Return a review outcome for incomplete optics capability declarations. */
export function assessOpticsCapability(
  manifest: unknown,
  plan: unknown,
): OpticsCapabilityAssessment {
  const parsedPlan = OpticsPlanSchema.parse(plan);
  if (parsedPlan.operations.length === 0) {
    return {
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
      reason: parsedPlan.warnings.join(" "),
    };
  }
  try {
    assertBackendSupportsOpticsPlan(BackendCapabilityManifestSchema.parse(manifest), parsedPlan);
    return {
      outcome: "READY",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
    };
  } catch (error) {
    const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
    const semantics = parsedManifest.success
      ? parsedManifest.data.operations[OPTICS_OPERATION_CAPABILITY]
      : undefined;
    const missingPrerequisites = OPTICS_REQUIRED_PREREQUISITES.filter(
      (capability) =>
        !parsedManifest.success ||
        !parsedManifest.data.capabilities.includes(capability) ||
        !parsedManifest.data.operations[capability]?.supported,
    );
    const missingCapabilities = [
      ...new Set(
        parsedPlan.operations.flatMap((operation) => {
          if (operation.kind === "lens_correction") {
            return OPTICS_LENS_CONTROLS.filter(
              (control) => !semantics?.supported_lens_controls?.includes(control),
            );
          }
          if (operation.kind === "profile") {
            return semantics?.supported_profiles?.includes(operation.profile_name)
              ? []
              : [operation.profile_name];
          }
          return semantics?.supported_geometry_variants?.includes(operation.settings.variant)
            ? []
            : [operation.settings.variant];
        }),
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

/** Resolve the eventual backend settings without performing a mutation. */
export function resolveOpticsSettings(plan: unknown): Record<string, number | string | boolean> {
  const validatedPlan = OpticsPlanSchema.parse(plan);
  return Object.assign({}, ...validatedPlan.operations.map(settingsForOperation));
}

/** Build deterministic expected state from a current readback snapshot. */
export function resolveOpticsReadback(current: unknown, plan: unknown): OpticsReadback {
  const currentReadback = OpticsReadbackSchema.parse(current);
  const validatedPlan = OpticsPlanSchema.parse(plan);
  const operations = new Map<string, OpticsPayload>(
    currentReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    operations.set(operationIdentity(operation), payloadForOperation(operation));
  }
  return OpticsReadbackSchema.parse({
    schema_version: SCHEMA_VERSION,
    optics_registry_version: OPTICS_REGISTRY_VERSION,
    operations: [...operations.values()].sort((left, right) =>
      operationIdentity(left).localeCompare(operationIdentity(right)),
    ),
  });
}

/** Verify requested lens/profile/geometry values against readback. */
export function assertOpticsReadback(plan: OpticsPlan, readback: unknown): OpticsReadback {
  const validatedPlan = OpticsPlanSchema.parse(plan);
  const parsedReadback = OpticsReadbackSchema.parse(readback);
  const operations = new Map(
    parsedReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    const actual = operations.get(operationIdentity(operation));
    if (!actual || !sameValue(actual, payloadForOperation(operation))) {
      throw new Error(`Optics readback mismatch: ${operationIdentity(operation)}`);
    }
  }
  return parsedReadback;
}

export type OpticsGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: OpticsPlan;
  settings: Record<string, number | string | boolean>;
  readback?: OpticsReadback;
};

/** Execute one independently owned optics/profile/geometry golden vector. */
export function runOpticsGoldenVector(vector: unknown): OpticsGoldenVectorResult {
  const parsed: OpticsGoldenVector = OpticsGoldenVectorSchema.parse(vector);
  const actualPlan = translateOpticsIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Optics golden vector failed: ${parsed.id}`);
  }
  const result: OpticsGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
    settings: resolveOpticsSettings(actualPlan),
  };
  if (parsed.current_readback !== undefined && parsed.expected_readback !== undefined) {
    const actualReadback = resolveOpticsReadback(parsed.current_readback, actualPlan);
    if (!sameValue(actualReadback, parsed.expected_readback)) {
      throw new Error(`Optics golden vector readback failed: ${parsed.id}`);
    }
    result.readback = assertOpticsReadback(actualPlan, actualReadback);
  }
  return result;
}

/** Run vectors without sharing mutable state between optics control groups. */
export function runOpticsGoldenVectors(vectors: readonly unknown[]): OpticsGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = OpticsGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate optics golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runOpticsGoldenVector(parsed);
  });
}

export const assertOpticsGoldenVector = runOpticsGoldenVector;
