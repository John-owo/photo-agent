import {
  BackendCapabilityManifestSchema,
  COLOR_GRADING_PROPAGATION_POLICY,
  COLOR_GRADING_REGISTRY_VERSION,
  ColorGradingGoldenVectorSchema,
  ColorGradingIntentSchema,
  ColorGradingPlanSchema,
  ColorGradingReadbackSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type { COLOR_GRADING_SHARED_CONTROLS, COLOR_GRADING_WHEEL_VARIANTS } from "./schemas.js";
import type {
  BackendCapabilityManifest,
  ColorGradingGoldenVector,
  ColorGradingIntent,
  ColorGradingOperation,
  ColorGradingPayload,
  ColorGradingPlan,
  ColorGradingReadback,
} from "./types.js";

export const COLOR_GRADING_OPERATION_CAPABILITY = "apply_global_adjustment" as const;
export const COLOR_GRADING_REQUIRED_PREREQUISITES = [
  "read_current_edit",
  "create_checkpoint",
  "render_preview",
] as const;
export const MIN_EXECUTABLE_COLOR_GRADING_CONFIDENCE = 0.65;

export const COLOR_GRADING_BACKEND_SETTINGS = {
  shadows: ["ColorGradeShadowHue", "ColorGradeShadowSat", "ColorGradeShadowLum"],
  midtones: ["ColorGradeMidtoneHue", "ColorGradeMidtoneSat", "ColorGradeMidtoneLum"],
  highlights: ["ColorGradeHighlightHue", "ColorGradeHighlightSat", "ColorGradeHighlightLum"],
  global: ["ColorGradeGlobalHue", "ColorGradeGlobalSat", "ColorGradeGlobalLum"],
  blending: ["ColorGradeBlending"],
  balance: ["ColorGradeBalance"],
} as const;

type ColorGradingWheelVariant = (typeof COLOR_GRADING_WHEEL_VARIANTS)[number];
type ColorGradingSharedControl = (typeof COLOR_GRADING_SHARED_CONTROLS)[number];

function payloadForOperation(operation: ColorGradingOperation): ColorGradingPayload {
  if (operation.kind === "wheel") {
    return {
      kind: "wheel",
      variant: operation.variant,
      hue: operation.hue,
      saturation: operation.saturation,
      luminance: operation.luminance,
    };
  }
  return {
    kind: "shared",
    control: operation.control,
    value: operation.value,
  };
}

function operationIdentity(operation: ColorGradingOperation | ColorGradingPayload): string {
  return operation.kind === "wheel" ? `wheel:${operation.variant}` : `shared:${operation.control}`;
}

function settingsForOperation(operation: ColorGradingOperation): Record<string, number> {
  if (operation.kind === "wheel") {
    const [hueKey, saturationKey, luminanceKey] = COLOR_GRADING_BACKEND_SETTINGS[operation.variant];
    return {
      [hueKey]: operation.hue,
      [saturationKey]: operation.saturation,
      [luminanceKey]: operation.luminance,
    };
  }
  const [settingKey] = COLOR_GRADING_BACKEND_SETTINGS[operation.control];
  return { [settingKey]: operation.value };
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

function operationOrder(identity: string): number {
  const ordered = [
    "wheel:shadows",
    "wheel:midtones",
    "wheel:highlights",
    "wheel:global",
    "shared:blending",
    "shared:balance",
  ];
  const index = ordered.indexOf(identity);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function requiredSettings(plan: ColorGradingPlan): string[] {
  return [
    ...new Set(
      plan.operations.flatMap((operation) => Object.keys(settingsForOperation(operation))),
    ),
  ];
}

function requestedWheels(plan: ColorGradingPlan): ColorGradingWheelVariant[] {
  return [
    ...new Set(
      plan.operations
        .filter(
          (operation): operation is Extract<ColorGradingOperation, { kind: "wheel" }> =>
            operation.kind === "wheel",
        )
        .map((operation) => operation.variant),
    ),
  ];
}

function requestedControls(plan: ColorGradingPlan): ColorGradingSharedControl[] {
  return [
    ...new Set(
      plan.operations
        .filter(
          (operation): operation is Extract<ColorGradingOperation, { kind: "shared" }> =>
            operation.kind === "shared",
        )
        .map((operation) => operation.control),
    ),
  ];
}

export function validateColorGradingPlan(plan: unknown): ColorGradingPlan {
  return ColorGradingPlanSchema.parse(plan);
}

/** Translate modern Color Grading intent without invoking a backend or changing files. */
export function translateColorGradingIntent(intent: ColorGradingIntent): ColorGradingPlan {
  const parsedIntent = ColorGradingIntentSchema.parse(intent);
  const warnings: string[] = [];
  const operations = parsedIntent.operations.filter((operation) => {
    if (operation.confidence < MIN_EXECUTABLE_COLOR_GRADING_CONFIDENCE) {
      warnings.push(
        `Skipped low-confidence ${operationIdentity(operation)} modern Color Grading operation (${operation.confidence.toFixed(2)})`,
      );
      return false;
    }
    return true;
  });

  if (operations.length === 0) {
    warnings.push(
      "No executable modern Color Grading operation met the confidence threshold; manual handoff required",
    );
  }

  return ColorGradingPlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    color_grading_registry_version: COLOR_GRADING_REGISTRY_VERSION,
    color_grading_mode: parsedIntent.color_grading_mode,
    process_version: parsedIntent.process_version,
    operations,
    warnings,
    propagation_policy: COLOR_GRADING_PROPAGATION_POLICY,
  });
}

/**
 * Refuse automatic execution unless the backend declares complete modern
 * Color Grading semantics for the requested process version and controls.
 * The current BackendAdapter has no structured Color Grading mutation method;
 * this is therefore a planning-time capability boundary only.
 */
export function assertBackendSupportsColorGradingPlan(
  manifest: BackendCapabilityManifest,
  plan: ColorGradingPlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = ColorGradingPlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error(
      "Modern Color Grading propagation is not eligible under the current registry policy",
    );
  }
  if (parsedPlan.operations.length === 0) return;

  const missingPrerequisites = COLOR_GRADING_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !parsedManifest.capabilities.includes(capability) ||
      !parsedManifest.operations[capability]?.supported,
  );
  if (missingPrerequisites.length > 0) {
    throw new Error(
      `Backend is missing modern Color Grading prerequisites: ${missingPrerequisites.join(", ")}`,
    );
  }

  const semantics = parsedManifest.operations[COLOR_GRADING_OPERATION_CAPABILITY];
  if (
    !parsedManifest.capabilities.includes(COLOR_GRADING_OPERATION_CAPABILITY) ||
    !semantics?.supported
  ) {
    throw new Error(
      "Backend does not advertise apply_global_adjustment for modern Color Grading planning",
    );
  }

  const supportedProcessVersions = semantics.supported_color_grading_process_versions;
  if (!supportedProcessVersions) {
    throw new Error("Backend does not declare modern Color Grading process-version support");
  }
  if (!supportedProcessVersions.includes(parsedPlan.process_version)) {
    throw new Error(
      `Backend does not declare modern Color Grading process version: ${parsedPlan.process_version}`,
    );
  }

  const wheels = requestedWheels(parsedPlan);
  const supportedWheels = semantics.supported_color_grading_wheels;
  if (wheels.length > 0 && !supportedWheels) {
    throw new Error("Backend does not declare modern Color Grading wheel support");
  }
  const missingWheels = wheels.filter((wheel) => !supportedWheels?.includes(wheel));
  if (missingWheels.length > 0) {
    throw new Error(
      `Backend does not declare modern Color Grading wheels: ${missingWheels.join(", ")}`,
    );
  }

  const controls = requestedControls(parsedPlan);
  const supportedControls = semantics.supported_color_grading_controls;
  if (controls.length > 0 && !supportedControls) {
    throw new Error("Backend does not declare modern Color Grading shared-control support");
  }
  const missingControls = controls.filter((control) => !supportedControls?.includes(control));
  if (missingControls.length > 0) {
    throw new Error(
      `Backend does not declare modern Color Grading shared controls: ${missingControls.join(", ")}`,
    );
  }

  const supportedSettings = semantics.supported_settings;
  if (!supportedSettings) {
    throw new Error("Backend does not declare concrete modern Color Grading settings support");
  }
  const missingSettings = requiredSettings(parsedPlan).filter(
    (setting) => !supportedSettings.includes(setting),
  );
  if (missingSettings.length > 0) {
    throw new Error(
      `Backend does not declare modern Color Grading settings: ${missingSettings.join(", ")}`,
    );
  }
}

export type ColorGradingCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  manual_handoff_required: boolean;
  missing_prerequisites: readonly string[];
  missing_capabilities: readonly string[];
  missing_process_versions: readonly string[];
  missing_wheels: readonly string[];
  missing_controls: readonly string[];
  missing_settings: readonly string[];
  reason?: string;
};

function missingCapabilityDetails(
  manifest: BackendCapabilityManifest | undefined,
  plan: ColorGradingPlan,
): Omit<ColorGradingCapabilityAssessment, "outcome" | "manual_handoff_required" | "reason"> {
  const semantics = manifest?.operations[COLOR_GRADING_OPERATION_CAPABILITY];
  const missingPrerequisites = COLOR_GRADING_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !manifest ||
      !manifest.capabilities.includes(capability) ||
      !manifest.operations[capability]?.supported,
  );
  const missingCapabilities = [
    ...(!manifest ||
    !manifest.capabilities.includes(COLOR_GRADING_OPERATION_CAPABILITY) ||
    !semantics?.supported
      ? [COLOR_GRADING_OPERATION_CAPABILITY]
      : []),
    ...(requestedWheels(plan).length > 0 && !semantics?.supported_color_grading_wheels
      ? ["modern_color_grading_wheels"]
      : []),
    ...(requestedControls(plan).length > 0 && !semantics?.supported_color_grading_controls
      ? ["modern_color_grading_shared_controls"]
      : []),
    ...(!semantics?.supported_color_grading_process_versions
      ? ["modern_color_grading_process_versions"]
      : []),
    ...(!semantics?.supported_settings ? ["modern_color_grading_settings"] : []),
  ];
  const supportedProcessVersions = semantics?.supported_color_grading_process_versions ?? [];
  const missingProcessVersions = supportedProcessVersions.includes(plan.process_version)
    ? []
    : [plan.process_version];
  const supportedWheels = semantics?.supported_color_grading_wheels ?? [];
  const missingWheels = requestedWheels(plan).filter((wheel) => !supportedWheels.includes(wheel));
  const supportedControls = semantics?.supported_color_grading_controls ?? [];
  const missingControls = requestedControls(plan).filter(
    (control) => !supportedControls.includes(control),
  );
  const supportedSettings = semantics?.supported_settings ?? [];
  const missingSettings = requiredSettings(plan).filter(
    (setting) => !supportedSettings.includes(setting),
  );
  return {
    missing_prerequisites: missingPrerequisites,
    missing_capabilities: [...new Set(missingCapabilities)],
    missing_process_versions: missingProcessVersions,
    missing_wheels: missingWheels,
    missing_controls: missingControls,
    missing_settings: missingSettings,
  };
}

/** Return an explicit manual handoff instead of approximating unsupported intent. */
export function assessColorGradingCapability(
  manifest: unknown,
  plan: unknown,
): ColorGradingCapabilityAssessment {
  const parsedPlan = ColorGradingPlanSchema.parse(plan);
  if (parsedPlan.operations.length === 0) {
    return {
      outcome: "REVIEW_REQUIRED",
      manual_handoff_required: true,
      ...missingCapabilityDetails(undefined, parsedPlan),
      reason: parsedPlan.warnings.join(" "),
    };
  }
  const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
  if (parsedManifest.success) {
    try {
      assertBackendSupportsColorGradingPlan(parsedManifest.data, parsedPlan);
      return {
        outcome: "READY",
        manual_handoff_required: false,
        ...missingCapabilityDetails(parsedManifest.data, parsedPlan),
      };
    } catch (error) {
      return {
        outcome: "REVIEW_REQUIRED",
        manual_handoff_required: true,
        ...missingCapabilityDetails(parsedManifest.data, parsedPlan),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    outcome: "REVIEW_REQUIRED",
    manual_handoff_required: true,
    ...missingCapabilityDetails(undefined, parsedPlan),
    reason: "Backend capability manifest is invalid; modern Color Grading requires manual handoff",
  };
}

/** Resolve the eventual modern Color Grading settings without invoking a backend. */
export function resolveColorGradingSettings(plan: unknown): Record<string, number> {
  const validatedPlan = ColorGradingPlanSchema.parse(plan);
  return Object.assign({}, ...validatedPlan.operations.map(settingsForOperation));
}

/** Build deterministic expected state from a current Color Grading readback. */
export function resolveColorGradingReadback(current: unknown, plan: unknown): ColorGradingReadback {
  const currentReadback = ColorGradingReadbackSchema.parse(current);
  const validatedPlan = ColorGradingPlanSchema.parse(plan);
  if (
    currentReadback.color_grading_mode !== validatedPlan.color_grading_mode ||
    currentReadback.process_version !== validatedPlan.process_version
  ) {
    throw new Error("Modern Color Grading readback process or mode does not match the plan");
  }
  const operations = new Map<string, ColorGradingPayload>(
    currentReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    operations.set(operationIdentity(operation), payloadForOperation(operation));
  }
  return ColorGradingReadbackSchema.parse({
    schema_version: SCHEMA_VERSION,
    color_grading_registry_version: COLOR_GRADING_REGISTRY_VERSION,
    color_grading_mode: validatedPlan.color_grading_mode,
    process_version: validatedPlan.process_version,
    operations: [...operations.entries()]
      .sort(([left], [right]) => operationOrder(left) - operationOrder(right))
      .map(([, operation]) => operation),
  });
}

/** Verify requested modern Color Grading values against a readback. */
export function assertColorGradingReadback(
  plan: ColorGradingPlan,
  readback: unknown,
): ColorGradingReadback {
  const validatedPlan = ColorGradingPlanSchema.parse(plan);
  const parsedReadback = ColorGradingReadbackSchema.parse(readback);
  if (
    parsedReadback.color_grading_mode !== validatedPlan.color_grading_mode ||
    parsedReadback.process_version !== validatedPlan.process_version
  ) {
    throw new Error("Modern Color Grading readback process or mode does not match the plan");
  }
  const operations = new Map(
    parsedReadback.operations.map((operation) => [operationIdentity(operation), operation]),
  );
  for (const operation of validatedPlan.operations) {
    const actual = operations.get(operationIdentity(operation));
    if (!actual || !sameValue(actual, payloadForOperation(operation))) {
      throw new Error(`Modern Color Grading readback mismatch: ${operationIdentity(operation)}`);
    }
  }
  return parsedReadback;
}

export type ColorGradingGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: ColorGradingPlan;
  settings: Record<string, number>;
  readback?: ColorGradingReadback;
};

/** Execute one independently owned modern Color Grading golden vector. */
export function runColorGradingGoldenVector(vector: unknown): ColorGradingGoldenVectorResult {
  const parsed: ColorGradingGoldenVector = ColorGradingGoldenVectorSchema.parse(vector);
  const actualPlan = translateColorGradingIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Modern Color Grading golden vector failed: ${parsed.id}`);
  }
  const result: ColorGradingGoldenVectorResult = {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
    settings: resolveColorGradingSettings(actualPlan),
  };
  if (parsed.current_readback !== undefined && parsed.expected_readback !== undefined) {
    const actualReadback = resolveColorGradingReadback(parsed.current_readback, actualPlan);
    if (!sameValue(actualReadback, parsed.expected_readback)) {
      throw new Error(`Modern Color Grading golden vector readback failed: ${parsed.id}`);
    }
    result.readback = assertColorGradingReadback(actualPlan, actualReadback);
  }
  return result;
}

/** Run modern Color Grading vectors without sharing mutable state. */
export function runColorGradingGoldenVectors(
  vectors: readonly unknown[],
): ColorGradingGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = ColorGradingGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate modern Color Grading golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runColorGradingGoldenVector(parsed);
  });
}

export const assertColorGradingGoldenVector = runColorGradingGoldenVector;
