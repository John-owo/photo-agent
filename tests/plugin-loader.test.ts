import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CORE_PLUGIN_API_VERSION,
  assertPluginCapabilities,
  assertPluginOperations,
  loadPluginFromPath,
  loadPluginModule,
  validatePluginManifest,
} from "../src/plugin-loader.js";
import type { PluginManifest } from "../src/types.js";

const TRUST_BOUNDARY = {
  transport: "in-process fixture",
  authentication: "none",
  cloud: false,
} as const;

const READ_OPERATION = {
  supported: true,
  side_effect: "read_only" as const,
  idempotent: true,
  reversible: "true_undo" as const,
  scope: "photo" as const,
  requires_active_selection: false,
  requires_editor_foreground: false,
  concurrency: "parallel_safe" as const,
  retry_policy: "automatic" as const,
  safe_to_resume: true,
};

function backendManifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return {
    plugin_type: "backend",
    plugin_id: "fixture-backend",
    plugin_version: "1.2.3",
    core_api_version: CORE_PLUGIN_API_VERSION,
    capabilities: ["read_current_edit"],
    trust_boundary: TRUST_BOUNDARY,
    operations: { read_current_edit: READ_OPERATION },
    ...overrides,
  } as PluginManifest;
}

describe("T58 capability-driven plugin loader", () => {
  it("accepts a sparse backend manifest and does not invoke the factory early", async () => {
    let created = false;
    const loaded = loadPluginModule<{ name: string }>(
      {
        manifest: backendManifest(),
        create: () => {
          created = true;
          return { name: "fixture" };
        },
      },
      {
        pluginType: "backend",
        expectedTrustBoundary: TRUST_BOUNDARY,
        requiredOperations: ["read_current_edit"],
      },
    );

    expect(created).toBe(false);
    expect(loaded.manifest.capabilities).toEqual(["read_current_edit"]);
    await expect(loaded.create()).resolves.toEqual({ name: "fixture" });
    expect(created).toBe(true);
  });

  it("loads a provider module from the public manifest/factory shape", async () => {
    const modulePath = fileURLToPath(new URL("./fixtures/provider-plugin.mjs", import.meta.url));
    const loaded = await loadPluginFromPath<{ kind: string }>(modulePath, {
      pluginType: "provider",
      expectedTrustBoundary: TRUST_BOUNDARY,
      requiredCapabilities: ["analysis"],
      requiredOperations: ["analysis"],
    });

    expect(loaded.manifest.plugin_type).toBe("provider");
    await expect(loaded.create()).resolves.toEqual({ kind: "fixture-provider" });
  });

  it.each([
    ["wrong type", backendManifest({ plugin_type: "provider" }), /wrong plugin type/i],
    ["wrong core major", backendManifest({ core_api_version: "1.0.0" }), /core API major/i],
    [
      "wrong trust boundary",
      backendManifest({
        trust_boundary: { ...TRUST_BOUNDARY, cloud: true },
      }),
      /trust boundary/i,
    ],
  ])("fails closed for %s", (_name, manifest, expected) => {
    expect(() =>
      validatePluginManifest(manifest, {
        pluginType: "backend",
        expectedTrustBoundary: TRUST_BOUNDARY,
      }),
    ).toThrow(expected);
  });

  it("refuses missing operations without inventing a capability", () => {
    const manifest = backendManifest();
    expect(() => assertPluginCapabilities(manifest, ["render_preview"])).toThrow(
      /required capability.*render_preview/i,
    );
    expect(() => assertPluginOperations(manifest, ["render_preview"])).toThrow(
      /required operation.*render_preview/i,
    );
    expect(() =>
      loadPluginModule(
        { manifest, create: () => ({}) },
        {
          pluginType: "backend",
          expectedTrustBoundary: TRUST_BOUNDARY,
          requiredOperations: ["render_preview"],
        },
      ),
    ).toThrow(/stopped before execution/i);
  });

  it("rejects an advertised capability whose semantics are absent", () => {
    expect(() =>
      validatePluginManifest(
        backendManifest({ capabilities: ["read_current_edit", "apply_global_adjustment"] }),
        { pluginType: "backend", expectedTrustBoundary: TRUST_BOUNDARY },
      ),
    ).toThrow(/Missing operation semantics/i);
  });
});
