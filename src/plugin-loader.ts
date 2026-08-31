import { pathToFileURL } from "node:url";

import { PluginManifestSchema, SemverSchema } from "./schemas.js";
import type { PluginManifest } from "./types.js";

export const CORE_PLUGIN_API_VERSION = "0.1.0" as const;

export type PluginLoadRequirements = {
  pluginType: PluginManifest["plugin_type"];
  expectedTrustBoundary: PluginManifest["trust_boundary"];
  expectedCoreApiVersion?: string;
  requiredCapabilities?: readonly string[];
  requiredOperations?: readonly string[];
};

export type PluginFactory<T> = () => T | Promise<T>;

export type PhotoAgentPluginModule<T> = {
  manifest: unknown;
  create: PluginFactory<T>;
};

export type LoadedPlugin<T> = {
  manifest: PluginManifest;
  create(): Promise<T>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function pluginLabel(value: unknown): string {
  const record = asRecord(value);
  return typeof record.plugin_id === "string" && record.plugin_id.length > 0
    ? record.plugin_id
    : "unknown-plugin";
}

function majorVersion(version: string): string {
  const match = /^(\d+)\./.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return match[1]!;
}

function trustBoundaryMatches(
  actual: PluginManifest["trust_boundary"],
  expected: PluginManifest["trust_boundary"],
): boolean {
  return (
    actual.transport === expected.transport &&
    actual.authentication === expected.authentication &&
    actual.cloud === expected.cloud
  );
}

export function validatePluginManifest(
  value: unknown,
  requirements: PluginLoadRequirements,
): PluginManifest {
  const parsed = PluginManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Plugin "${pluginLabel(value)}" manifest rejected: ${parsed.error.message}. ` +
        "Install a compatible plugin or fix its public manifest before starting a workflow.",
    );
  }
  const manifest = parsed.data;
  if (manifest.plugin_type !== requirements.pluginType) {
    throw new Error(
      `Plugin "${manifest.plugin_id}" rejected wrong plugin type: expected ${requirements.pluginType}, received ${manifest.plugin_type}. ` +
        "Select a plugin for the requested backend/provider role.",
    );
  }
  const expectedCoreApiVersion = requirements.expectedCoreApiVersion ?? CORE_PLUGIN_API_VERSION;
  const expectedCoreVersion = SemverSchema.safeParse(expectedCoreApiVersion);
  if (!expectedCoreVersion.success) {
    throw new Error(`Invalid expected core plugin API version: ${expectedCoreApiVersion}`);
  }
  if (majorVersion(manifest.core_api_version) !== majorVersion(expectedCoreApiVersion)) {
    throw new Error(
      `Plugin "${manifest.plugin_id}" rejected incompatible core API major: expected ${expectedCoreApiVersion}, received ${manifest.core_api_version}. ` +
        "Install a plugin built for this PhotoAgent core or select another plugin.",
    );
  }
  if (!trustBoundaryMatches(manifest.trust_boundary, requirements.expectedTrustBoundary)) {
    throw new Error(
      `Plugin "${manifest.plugin_id}" rejected unexpected trust boundary. ` +
        "Review the plugin transport, authentication, and cloud disclosure before use.",
    );
  }
  if (requirements.requiredCapabilities) {
    assertPluginCapabilities(manifest, requirements.requiredCapabilities);
  }
  if (requirements.requiredOperations) {
    assertPluginOperations(manifest, requirements.requiredOperations);
  }
  return manifest;
}

export function assertPluginCapabilities(
  manifest: PluginManifest,
  requiredCapabilities: readonly string[],
): void {
  const missing = requiredCapabilities.filter(
    (capability) => !manifest.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new Error(
      `Plugin "${manifest.plugin_id}" does not declare required capability(s): ${missing.join(", ")}. ` +
        "Choose a plugin that explicitly supports the requested workflow.",
    );
  }
}

export function assertPluginOperations(
  manifest: PluginManifest,
  requiredOperations: readonly string[],
): void {
  const missing = requiredOperations.filter(
    (operation) =>
      !manifest.capabilities.includes(operation) || !manifest.operations[operation]?.supported,
  );
  if (missing.length > 0) {
    throw new Error(
      `Plugin "${manifest.plugin_id}" cannot satisfy required operation(s): ${missing.join(
        ", ",
      )}. ` +
        "The workflow was stopped before execution; choose a plugin declaring these operations.",
    );
  }
}

function moduleExports<T>(value: unknown): PhotoAgentPluginModule<T> {
  const record = asRecord(value);
  const candidate =
    typeof record.manifest !== "undefined" && typeof record.create !== "undefined"
      ? record
      : asRecord(record.default);
  if (candidate.manifest === undefined || typeof candidate.create !== "function") {
    throw new Error(
      "Plugin module must export a manifest and a create() factory. " +
        "See the public adapter contract before loading it.",
    );
  }
  return {
    manifest: candidate.manifest,
    create: candidate.create as PluginFactory<T>,
  };
}

/** Validate a module before invoking its factory. Unsupported operations stay absent. */
export function loadPluginModule<T>(
  value: unknown,
  requirements: PluginLoadRequirements,
): LoadedPlugin<T> {
  const module = moduleExports<T>(value);
  const manifest = validatePluginManifest(module.manifest, requirements);
  return {
    manifest,
    create: async () => module.create(),
  };
}

export async function loadPluginFromPath<T>(
  modulePath: string,
  requirements: PluginLoadRequirements,
): Promise<LoadedPlugin<T>> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin module could not be loaded from ${modulePath}: ${message}`);
  }
  return loadPluginModule<T>(loaded, requirements);
}
