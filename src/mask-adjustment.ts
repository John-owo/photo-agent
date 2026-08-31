import {
  BackendCapabilityManifestSchema,
  MASK_PROPAGATION_POLICY,
  MASK_REGISTRY_VERSION,
  MaskAdjustmentIntentSchema,
  MaskAdjustmentPlanSchema,
  MaskGoldenVectorSchema,
  MaskReadbackSchema,
  MaskSelectorSchema,
  SCHEMA_VERSION,
} from "./schemas.js";
import type { MASK_PARAMETER_NAMES } from "./schemas.js";
import type {
  BackendCapabilityManifest,
  ExistingMaskSnapshot,
  ExistingMaskSummary,
  MaskAdjustmentIntent,
  MaskAdjustmentPlan,
  MaskGoldenVector,
  MaskParameterSettings,
  MaskReadback,
  MaskSelector,
} from "./types.js";

export const MASK_ADJUSTMENT_OPERATION_CAPABILITY = "adjust_existing_mask" as const;
export const MASK_REQUIRED_PREREQUISITES = [
  "read_current_edit",
  "create_checkpoint",
  "render_preview",
] as const;

type MaskParameter = (typeof MASK_PARAMETER_NAMES)[number];

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
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

function requestedParameters(plan: MaskAdjustmentPlan): MaskParameter[] {
  return Object.keys(plan.settings) as MaskParameter[];
}

function targetMatches(readback: MaskReadback, plan: MaskAdjustmentPlan, label: string): void {
  if (!sameValue(readback.target, plan.target)) {
    throw new Error(
      `Existing-mask ${label} target identity does not match the verified Workflow Copy`,
    );
  }
}

/** Return stable summaries without exposing the opaque mask tree. */
export function summarizeExistingMasks(readback: unknown): ExistingMaskSummary[] {
  const parsedReadback = MaskReadbackSchema.parse(readback);
  return parsedReadback.masks.map((mask) => ({
    mask_id: mask.mask_id,
    name: mask.name,
    kind: mask.kind,
    enabled: mask.enabled,
    supported_parameters: [...mask.supported_parameters],
    parameters: { ...mask.parameters },
  }));
}

/** Resolve a stable mask id or a unique display name; never use array position. */
export function resolveMaskSelector(
  readback: unknown,
  selector: MaskSelector,
): ExistingMaskSnapshot {
  const parsedReadback = MaskReadbackSchema.parse(readback);
  const parsedSelector = MaskSelectorSchema.parse(selector);
  if (parsedSelector.kind === "id") {
    const match = parsedReadback.masks.find((mask) => mask.mask_id === parsedSelector.mask_id);
    if (!match) {
      throw new Error(`Existing-mask selector id not found: ${parsedSelector.mask_id}`);
    }
    return match;
  }
  const candidates = parsedReadback.masks.filter((mask) => mask.name === parsedSelector.name);
  if (candidates.length === 0) {
    throw new Error(`Existing-mask selector name not found: ${parsedSelector.name}`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Existing-mask selector name is ambiguous: ${parsedSelector.name}; candidates: ${candidates
        .map((mask) => mask.mask_id)
        .join(", ")}`,
    );
  }
  return candidates[0]!;
}

export function validateMaskAdjustmentPlan(plan: unknown): MaskAdjustmentPlan {
  return MaskAdjustmentPlanSchema.parse(plan);
}

/** Build a one-operation mask plan without invoking Lightroom or changing files. */
export function translateMaskAdjustmentIntent(intent: MaskAdjustmentIntent): MaskAdjustmentPlan {
  const parsedIntent = MaskAdjustmentIntentSchema.parse(intent);
  return MaskAdjustmentPlanSchema.parse({
    schema_version: SCHEMA_VERSION,
    mask_registry_version: MASK_REGISTRY_VERSION,
    operation_id: parsedIntent.operation_id,
    mask_schema_version: parsedIntent.mask_schema_version,
    master: parsedIntent.master,
    target: parsedIntent.target,
    expected_master_uuid: parsedIntent.expected_master_uuid,
    selector: parsedIntent.selector,
    settings: parsedIntent.settings,
    warnings: [],
    propagation_policy: MASK_PROPAGATION_POLICY,
  });
}

/**
 * Fail closed unless the backend declares the mask schema, every requested
 * parameter, and the read/checkpoint/render boundary. The current adapter has
 * no structured mask operation, so this remains a planning-time gate.
 */
export function assertBackendSupportsMaskAdjustmentPlan(
  manifest: BackendCapabilityManifest,
  plan: MaskAdjustmentPlan,
): void {
  const parsedManifest = BackendCapabilityManifestSchema.parse(manifest);
  const parsedPlan = MaskAdjustmentPlanSchema.parse(plan);
  if (parsedPlan.propagation_policy.eligible) {
    throw new Error("Existing-mask propagation is not eligible under the current registry policy");
  }

  const missingPrerequisites = MASK_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !parsedManifest.capabilities.includes(capability) ||
      !parsedManifest.operations[capability]?.supported,
  );
  if (missingPrerequisites.length > 0) {
    throw new Error(
      `Backend is missing existing-mask prerequisites: ${missingPrerequisites.join(", ")}`,
    );
  }

  const semantics = parsedManifest.operations[MASK_ADJUSTMENT_OPERATION_CAPABILITY];
  if (
    !parsedManifest.capabilities.includes(MASK_ADJUSTMENT_OPERATION_CAPABILITY) ||
    !semantics?.supported
  ) {
    throw new Error("Backend does not advertise adjust_existing_mask");
  }

  if (!semantics.supported_mask_schema_versions) {
    throw new Error("Backend does not declare existing-mask schema-version support");
  }
  if (!semantics.supported_mask_schema_versions.includes(parsedPlan.mask_schema_version)) {
    throw new Error(
      `Backend does not declare existing-mask schema version: ${parsedPlan.mask_schema_version}`,
    );
  }

  if (!semantics.supported_mask_parameters) {
    throw new Error("Backend does not declare existing-mask parameter support");
  }
  const missingParameters = requestedParameters(parsedPlan).filter(
    (parameter) => !semantics.supported_mask_parameters?.includes(parameter),
  );
  if (missingParameters.length > 0) {
    throw new Error(
      `Backend does not declare existing-mask parameters: ${missingParameters.join(", ")}`,
    );
  }
}

export type MaskCapabilityAssessment = {
  outcome: "READY" | "REVIEW_REQUIRED";
  manual_handoff_required: boolean;
  missing_prerequisites: readonly string[];
  missing_capabilities: readonly string[];
  missing_schema_versions: readonly string[];
  missing_parameters: readonly string[];
  reason?: string;
};

function missingMaskCapabilityDetails(
  manifest: BackendCapabilityManifest | undefined,
  plan: MaskAdjustmentPlan,
): Omit<MaskCapabilityAssessment, "outcome" | "manual_handoff_required" | "reason"> {
  const semantics = manifest?.operations[MASK_ADJUSTMENT_OPERATION_CAPABILITY];
  const missingPrerequisites = MASK_REQUIRED_PREREQUISITES.filter(
    (capability) =>
      !manifest ||
      !manifest.capabilities.includes(capability) ||
      !manifest.operations[capability]?.supported,
  );
  const missingCapabilities = [
    ...(!manifest ||
    !manifest.capabilities.includes(MASK_ADJUSTMENT_OPERATION_CAPABILITY) ||
    !semantics?.supported
      ? [MASK_ADJUSTMENT_OPERATION_CAPABILITY]
      : []),
    ...(!semantics?.supported_mask_schema_versions ? ["existing_mask_schema_versions"] : []),
    ...(!semantics?.supported_mask_parameters ? ["existing_mask_parameters"] : []),
  ];
  const supportedSchemaVersions = semantics?.supported_mask_schema_versions ?? [];
  const missingSchemaVersions = supportedSchemaVersions.includes(plan.mask_schema_version)
    ? []
    : [plan.mask_schema_version];
  const supportedParameters = semantics?.supported_mask_parameters ?? [];
  const missingParameters = requestedParameters(plan).filter(
    (parameter) => !supportedParameters.includes(parameter),
  );
  return {
    missing_prerequisites: missingPrerequisites,
    missing_capabilities: [...new Set(missingCapabilities)],
    missing_schema_versions: missingSchemaVersions,
    missing_parameters: missingParameters,
  };
}

/** Return a manual handoff for unsupported masks instead of approximating them. */
export function assessMaskCapability(manifest: unknown, plan: unknown): MaskCapabilityAssessment {
  const parsedPlan = MaskAdjustmentPlanSchema.parse(plan);
  const parsedManifest = BackendCapabilityManifestSchema.safeParse(manifest);
  if (parsedManifest.success) {
    try {
      assertBackendSupportsMaskAdjustmentPlan(parsedManifest.data, parsedPlan);
      return {
        outcome: "READY",
        manual_handoff_required: false,
        ...missingMaskCapabilityDetails(parsedManifest.data, parsedPlan),
      };
    } catch (error) {
      return {
        outcome: "REVIEW_REQUIRED",
        manual_handoff_required: true,
        ...missingMaskCapabilityDetails(parsedManifest.data, parsedPlan),
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return {
    outcome: "REVIEW_REQUIRED",
    manual_handoff_required: true,
    ...missingMaskCapabilityDetails(undefined, parsedPlan),
    reason:
      "Backend capability manifest is invalid; existing-mask adjustment requires manual handoff",
  };
}

function withoutRequestedParameters(
  mask: ExistingMaskSnapshot,
  settings: MaskParameterSettings,
): ExistingMaskSnapshot {
  const requested = new Set(Object.keys(settings));
  return {
    ...mask,
    parameters: Object.fromEntries(
      Object.entries(mask.parameters).filter(([parameter]) => !requested.has(parameter)),
    ),
  };
}

/**
 * Verify Workflow Copy identity, selected-mask readback, and preservation of
 * geometry, opaque fields, other masks, and global settings.
 */
export function assertMaskAdjustmentReadback(
  plan: MaskAdjustmentPlan,
  before: unknown,
  after: unknown,
): MaskReadback {
  const parsedPlan = MaskAdjustmentPlanSchema.parse(plan);
  const parsedBefore = MaskReadbackSchema.parse(before);
  const parsedAfter = MaskReadbackSchema.parse(after);
  targetMatches(parsedBefore, parsedPlan, "pre-mutation");
  targetMatches(parsedAfter, parsedPlan, "post-mutation");
  if (
    parsedBefore.mask_schema_version !== parsedAfter.mask_schema_version ||
    !sameValue(parsedBefore.global_settings, parsedAfter.global_settings)
  ) {
    throw new Error("Existing-mask readback changed schema version or global Develop settings");
  }
  if (parsedBefore.masks.length !== parsedAfter.masks.length) {
    throw new Error("Existing-mask readback changed the mask count");
  }

  const selectedBefore = resolveMaskSelector(parsedBefore, parsedPlan.selector);
  const selectedAfter = resolveMaskSelector(parsedAfter, parsedPlan.selector);
  if (selectedBefore.mask_id !== selectedAfter.mask_id) {
    throw new Error("Existing-mask readback resolved a different mask on the Workflow Copy");
  }

  for (const [index, beforeMask] of parsedBefore.masks.entries()) {
    const afterMask = parsedAfter.masks[index];
    if (!afterMask || beforeMask.mask_id !== afterMask.mask_id) {
      throw new Error("Existing-mask readback changed mask identity or ordering");
    }
    if (
      !sameValue(
        withoutRequestedParameters(beforeMask, parsedPlan.settings),
        withoutRequestedParameters(afterMask, parsedPlan.settings),
      )
    ) {
      throw new Error(`Existing-mask preservation mismatch: ${beforeMask.mask_id}`);
    }
    if (beforeMask.mask_id === selectedBefore.mask_id) {
      for (const [parameter, requestedValue] of Object.entries(parsedPlan.settings)) {
        if (afterMask.parameters[parameter] !== requestedValue) {
          throw new Error(`Existing-mask readback mismatch: ${parameter}`);
        }
      }
    }
  }
  return parsedAfter;
}

/** Apply only requested local parameters to a copied snapshot in memory. */
export function applyMaskAdjustment(current: unknown, plan: unknown): MaskReadback {
  const parsedCurrent = MaskReadbackSchema.parse(current);
  const parsedPlan = MaskAdjustmentPlanSchema.parse(plan);
  targetMatches(parsedCurrent, parsedPlan, "pre-mutation");
  const selected = resolveMaskSelector(parsedCurrent, parsedPlan.selector);
  const unsupported = requestedParameters(parsedPlan).filter(
    (parameter) => !selected.supported_parameters.includes(parameter),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Selected existing mask does not support parameters: ${unsupported.join(", ")}`,
    );
  }
  const next = MaskReadbackSchema.parse({
    ...parsedCurrent,
    masks: parsedCurrent.masks.map((mask) =>
      mask.mask_id === selected.mask_id
        ? { ...mask, parameters: { ...mask.parameters, ...parsedPlan.settings } }
        : mask,
    ),
  });
  return assertMaskAdjustmentReadback(parsedPlan, parsedCurrent, next);
}

export type MaskReadbackAssessment = {
  operation_id: string;
  outcome: "APPLIED" | "REVIEW_REQUIRED";
  retry_allowed: false;
  reason?: string;
};

/** Reconcile by operation ID and make uncertainty explicit without retrying. */
export function assessMaskReadback(
  plan: MaskAdjustmentPlan,
  before: unknown,
  after: unknown,
): MaskReadbackAssessment {
  const parsedPlan = MaskAdjustmentPlanSchema.parse(plan);
  try {
    assertMaskAdjustmentReadback(parsedPlan, before, after);
    return {
      operation_id: parsedPlan.operation_id,
      outcome: "APPLIED",
      retry_allowed: false,
    };
  } catch (error) {
    return {
      operation_id: parsedPlan.operation_id,
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type MaskGoldenVectorResult = {
  id: string;
  control_group: string;
  plan: MaskAdjustmentPlan;
  readback: MaskReadback;
};

/** Execute one mask planning/preservation vector without backend effects. */
export function runMaskGoldenVector(vector: unknown): MaskGoldenVectorResult {
  const parsed: MaskGoldenVector = MaskGoldenVectorSchema.parse(vector);
  const actualPlan = translateMaskAdjustmentIntent(parsed.intent);
  if (!sameValue(actualPlan, parsed.expected_plan)) {
    throw new Error(`Existing-mask golden vector failed: ${parsed.id}`);
  }
  const actualReadback = applyMaskAdjustment(parsed.current_readback, actualPlan);
  if (!sameValue(actualReadback, parsed.expected_readback)) {
    throw new Error(`Existing-mask golden vector readback failed: ${parsed.id}`);
  }
  return {
    id: parsed.id,
    control_group: parsed.control_group,
    plan: actualPlan,
    readback: actualReadback,
  };
}

/** Run vectors independently and reject duplicate IDs. */
export function runMaskGoldenVectors(vectors: readonly unknown[]): MaskGoldenVectorResult[] {
  const seen = new Set<string>();
  return vectors.map((vector) => {
    const parsed = MaskGoldenVectorSchema.parse(vector);
    if (seen.has(parsed.id)) {
      throw new Error(`Duplicate existing-mask golden vector: ${parsed.id}`);
    }
    seen.add(parsed.id);
    return runMaskGoldenVector(parsed);
  });
}

export const assertMaskGoldenVector = runMaskGoldenVector;
