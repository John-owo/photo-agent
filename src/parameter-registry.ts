import {
  NORMALIZED_PARAMETERS,
  NormalizedEditPlanSchema,
  ParameterRegistrySnapshotSchema,
  StoredNormalizedEditPlanSchema,
} from "./schemas.js";
import type {
  NormalizedOperation,
  NormalizedParameter,
  ParameterRegistrySnapshot,
  StoredNormalizedEditPlan,
} from "./types.js";

export const LEGACY_PARAMETER_REGISTRY_VERSION = "0.1.0" as const;
export const PARAMETER_REGISTRY_VERSION = "0.2.0" as const;
export const SUPPORTED_PARAMETER_REGISTRY_VERSIONS = [
  LEGACY_PARAMETER_REGISTRY_VERSION,
  PARAMETER_REGISTRY_VERSION,
] as const;
export const PARAMETER_REGISTRY_MIGRATION_STRATEGY = "baseline-0.1.0-to-0.2.0" as const;

export type ParameterUnit = "ev" | "kelvin" | "points";
export type ParameterMode = "delta" | "absolute";
export type PropagationCondition =
  | "accepted_representative"
  | "same_lighting_cluster"
  | "high_confidence_source"
  | "shortlisted_target";

export type ParameterDefinition = {
  readonly parameter: NormalizedParameter;
  readonly semantic_parameter: string;
  readonly backend_key: string;
  readonly unit: ParameterUnit;
  readonly base_step: number;
  readonly supported: boolean;
  readonly allowed_modes: readonly ParameterMode[];
  readonly absolute_range: readonly [number, number];
  readonly delta_range: readonly [number, number];
  readonly conflicts_with: readonly NormalizedParameter[];
  readonly depends_on: readonly NormalizedParameter[];
  readonly propagation: {
    readonly eligible: boolean;
    readonly required_conditions: readonly PropagationCondition[];
    readonly minimum_confidence: number;
    readonly blocked_reason?: string;
  };
};

const GLOBAL_PROPAGATION_CONDITIONS: readonly PropagationCondition[] = [
  "accepted_representative",
  "same_lighting_cluster",
  "high_confidence_source",
  "shortlisted_target",
];

const POINT_RANGE = [-100, 100] as const;
const POINT_DELTA_RANGE = [-100, 100] as const;

function globalParameter(
  parameter: NormalizedParameter,
  semanticParameter: string,
  backendKey: string,
): ParameterDefinition {
  return {
    parameter,
    semantic_parameter: semanticParameter,
    backend_key: backendKey,
    unit: "points",
    base_step: 8,
    supported: true,
    allowed_modes: ["delta", "absolute"],
    absolute_range: POINT_RANGE,
    delta_range: POINT_DELTA_RANGE,
    conflicts_with: [],
    depends_on: [],
    propagation: {
      eligible: true,
      required_conditions: GLOBAL_PROPAGATION_CONDITIONS,
      minimum_confidence: 0.65,
    },
  };
}

const definitions: Record<NormalizedParameter, ParameterDefinition> = {
  exposure_ev: {
    parameter: "exposure_ev",
    semantic_parameter: "exposure",
    backend_key: "Exposure2012",
    unit: "ev",
    base_step: 0.2,
    supported: true,
    allowed_modes: ["delta", "absolute"],
    absolute_range: [-5, 5],
    delta_range: [-5, 5],
    conflicts_with: [],
    depends_on: [],
    propagation: {
      eligible: true,
      required_conditions: GLOBAL_PROPAGATION_CONDITIONS,
      minimum_confidence: 0.65,
    },
  },
  temperature_k: {
    parameter: "temperature_k",
    semantic_parameter: "temperature",
    backend_key: "Temperature",
    unit: "kelvin",
    base_step: 250,
    supported: true,
    allowed_modes: ["delta", "absolute"],
    absolute_range: [2000, 50000],
    delta_range: [-48000, 48000],
    conflicts_with: [],
    depends_on: [],
    propagation: {
      eligible: false,
      required_conditions: [],
      minimum_confidence: 1,
      blocked_reason: "white_balance_is_context_sensitive",
    },
  },
  tint: {
    parameter: "tint",
    semantic_parameter: "tint",
    backend_key: "Tint",
    unit: "points",
    base_step: 5,
    supported: true,
    allowed_modes: ["delta", "absolute"],
    absolute_range: [-150, 150],
    delta_range: [-150, 150],
    conflicts_with: [],
    depends_on: [],
    propagation: {
      eligible: false,
      required_conditions: [],
      minimum_confidence: 1,
      blocked_reason: "white_balance_is_context_sensitive",
    },
  },
  contrast: globalParameter("contrast", "contrast", "Contrast2012"),
  highlights: globalParameter("highlights", "highlights", "Highlights2012"),
  shadows: globalParameter("shadows", "shadows", "Shadows2012"),
  whites: globalParameter("whites", "whites", "Whites2012"),
  blacks: globalParameter("blacks", "blacks", "Blacks2012"),
  texture: globalParameter("texture", "texture", "Texture"),
  clarity: globalParameter("clarity", "clarity", "Clarity2012"),
  dehaze: globalParameter("dehaze", "dehaze", "Dehaze"),
  vibrance: globalParameter("vibrance", "vibrance", "Vibrance"),
  saturation: globalParameter("saturation", "saturation", "Saturation"),
};

export const PARAMETER_REGISTRY: Readonly<Record<NormalizedParameter, ParameterDefinition>> =
  Object.freeze(definitions);

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

function currentRegistrySnapshot(): ParameterRegistrySnapshot {
  return ParameterRegistrySnapshotSchema.parse({
    version: PARAMETER_REGISTRY_VERSION,
    definitions: PARAMETER_REGISTRY,
  });
}

export function getParameterRegistrySnapshot(): ParameterRegistrySnapshot {
  return currentRegistrySnapshot();
}

export function serializeParameterRegistry(): ParameterRegistrySnapshot {
  return currentRegistrySnapshot();
}

function isSupportedRegistryVersion(version: string): boolean {
  return (SUPPORTED_PARAMETER_REGISTRY_VERSIONS as readonly string[]).includes(version);
}

export function validateParameterRegistrySnapshot(snapshot: unknown): ParameterRegistrySnapshot {
  const parsed = ParameterRegistrySnapshotSchema.parse(snapshot);
  if (!isSupportedRegistryVersion(parsed.version)) {
    throw new Error(`Unsupported parameter registry version: ${parsed.version}`);
  }
  for (const [key, definition] of Object.entries(parsed.definitions)) {
    if (key !== definition.parameter) {
      throw new Error(
        `Parameter registry definition key does not match parameter: ${key} <> ${definition.parameter}`,
      );
    }
    for (const reference of [...definition.conflicts_with, ...definition.depends_on]) {
      if (!Object.prototype.hasOwnProperty.call(parsed.definitions, reference)) {
        throw new Error(`Parameter registry references unknown parameter: ${reference}`);
      }
    }
  }
  return parsed;
}

function migrationFor(
  sourceVersion: string,
): StoredNormalizedEditPlan["parameter_registry_migration"] {
  if (sourceVersion === PARAMETER_REGISTRY_VERSION) return undefined;
  if (sourceVersion !== LEGACY_PARAMETER_REGISTRY_VERSION) {
    throw new Error(`Unsupported parameter registry version: ${sourceVersion}`);
  }
  return {
    from_version: LEGACY_PARAMETER_REGISTRY_VERSION,
    to_version: PARAMETER_REGISTRY_VERSION,
    strategy: PARAMETER_REGISTRY_MIGRATION_STRATEGY,
  };
}

export function migrateNormalizedPlan(plan: unknown): StoredNormalizedEditPlan {
  const parsed = NormalizedEditPlanSchema.parse(plan);
  const declaredVersion = parsed.parameter_registry_version;
  const declaredMigration = parsed.parameter_registry_migration;
  const sourceVersion = declaredVersion ?? LEGACY_PARAMETER_REGISTRY_VERSION;

  if (!isSupportedRegistryVersion(sourceVersion)) {
    throw new Error(`Unsupported parameter registry version: ${sourceVersion}`);
  }
  if (declaredMigration) {
    if (
      declaredMigration.to_version !== PARAMETER_REGISTRY_VERSION ||
      declaredMigration.from_version === declaredMigration.to_version ||
      !isSupportedRegistryVersion(declaredMigration.from_version) ||
      declaredMigration.strategy !== PARAMETER_REGISTRY_MIGRATION_STRATEGY
    ) {
      throw new Error("Unsupported parameter registry migration contract");
    }
    if (
      declaredVersion &&
      declaredVersion !== PARAMETER_REGISTRY_VERSION &&
      declaredVersion !== declaredMigration.from_version
    ) {
      throw new Error("Parameter registry migration source does not match plan version");
    }
  }
  if (parsed.parameter_registry_snapshot) {
    const snapshot = validateParameterRegistrySnapshot(parsed.parameter_registry_snapshot);
    const expectedSnapshotVersion =
      declaredVersion === PARAMETER_REGISTRY_VERSION ? PARAMETER_REGISTRY_VERSION : sourceVersion;
    if (snapshot.version !== expectedSnapshotVersion) {
      throw new Error(
        `Parameter registry snapshot version ${snapshot.version} does not match plan version ${expectedSnapshotVersion}`,
      );
    }
    if (!sameValue(snapshot.definitions, currentRegistrySnapshot().definitions)) {
      throw new Error(
        `Parameter registry snapshot ${snapshot.version} does not match the verified registry definitions`,
      );
    }
  }

  const migration = declaredMigration ?? migrationFor(sourceVersion);
  return StoredNormalizedEditPlanSchema.parse({
    ...parsed,
    parameter_registry_version: PARAMETER_REGISTRY_VERSION,
    parameter_registry_snapshot: currentRegistrySnapshot(),
    ...(migration ? { parameter_registry_migration: migration } : {}),
  });
}

export function getParameterDefinition(parameter: string): ParameterDefinition {
  const normalized = Object.prototype.hasOwnProperty.call(PARAMETER_REGISTRY, parameter)
    ? (parameter as NormalizedParameter)
    : Object.values(PARAMETER_REGISTRY).find(
        (definition) => definition.semantic_parameter === parameter,
      )?.parameter;
  if (!normalized) {
    throw new Error(`Unsupported normalized parameter: ${parameter}`);
  }
  const definition = PARAMETER_REGISTRY[normalized];
  if (!definition.supported) {
    throw new Error(`Unsupported normalized parameter: ${parameter}`);
  }
  return definition;
}

function inRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

export function validateNormalizedPlan(plan: unknown): StoredNormalizedEditPlan {
  const parsed = migrateNormalizedPlan(plan);
  const seen = new Set<string>();
  for (const operation of parsed.operations) {
    const definition = getParameterDefinition(operation.parameter);
    if (!definition.allowed_modes.includes(operation.mode)) {
      throw new Error(
        `Parameter ${operation.parameter} does not support ${operation.mode} semantics`,
      );
    }
    const range =
      operation.mode === "absolute" ? definition.absolute_range : definition.delta_range;
    if (!inRange(operation.value, range)) {
      throw new Error(
        `Parameter ${operation.parameter} ${operation.mode} value ${operation.value} is outside [${range[0]}, ${range[1]}] ${definition.unit}`,
      );
    }
    if (seen.has(operation.parameter)) {
      throw new Error(`Conflicting operations for parameter: ${operation.parameter}`);
    }
    for (const conflict of definition.conflicts_with) {
      if (seen.has(conflict)) {
        throw new Error(
          `Conflicting parameters: ${operation.parameter} conflicts with ${conflict}`,
        );
      }
    }
    for (const dependency of definition.depends_on) {
      if (!parsed.operations.some((candidate) => candidate.parameter === dependency)) {
        throw new Error(`Parameter ${operation.parameter} requires ${dependency}`);
      }
    }
    seen.add(operation.parameter);
  }
  return parsed;
}

export function validatePropagationAllowlist(
  allowedParameters: readonly string[],
): NormalizedParameter[] {
  const seen = new Set<string>();
  const result: NormalizedParameter[] = [];
  for (const parameter of allowedParameters) {
    const definition = getParameterDefinition(parameter);
    if (seen.has(definition.parameter)) {
      throw new Error(`Duplicate propagation allowlist parameter: ${definition.parameter}`);
    }
    seen.add(definition.parameter);
    result.push(definition.parameter);
  }
  return result;
}

export function selectPropagatableOperations(
  plan: unknown,
  allowedParameters: readonly string[],
): NormalizedOperation[] {
  const validatedPlan = validateNormalizedPlan(plan);
  const allowlist = new Set(validatePropagationAllowlist(allowedParameters));
  return validatedPlan.operations.filter((operation) => {
    const definition = getParameterDefinition(operation.parameter);
    return (
      allowlist.has(operation.parameter) &&
      definition.propagation.eligible &&
      operation.confidence >= definition.propagation.minimum_confidence
    );
  });
}

export function propagationPolicy(parameter: string): ParameterDefinition["propagation"] {
  return getParameterDefinition(parameter).propagation;
}

export function registeredParameters(): readonly NormalizedParameter[] {
  return NORMALIZED_PARAMETERS;
}
