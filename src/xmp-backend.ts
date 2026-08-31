import { resolve } from "node:path";

import { PluginManifestSchema, XmpSidecarExportRecordSchema } from "./schemas.js";
import { resolveLightroomSettings } from "./translator.js";
import type { NormalizedEditPlan } from "./types.js";
import type { DevelopSettings } from "./xmp.js";
import { writeXmpSidecar, XMP_SUPPORTED_SETTINGS } from "./xmp.js";
import type { PluginManifest, XmpSidecarExportRecord } from "./types.js";

export const XMP_SIDECAR_OPERATION = "create_xmp_sidecar" as const;

export const XMP_SIDECAR_TRUST_BOUNDARY = {
  transport: "in-process filesystem",
  authentication: "none",
  cloud: false,
} as const;

export const XMP_SIDECAR_PLUGIN_MANIFEST: PluginManifest = PluginManifestSchema.parse({
  plugin_type: "backend",
  plugin_id: "xmp-sidecar",
  plugin_version: "0.1.0",
  core_api_version: "0.1.0",
  capabilities: [XMP_SIDECAR_OPERATION],
  trust_boundary: XMP_SIDECAR_TRUST_BOUNDARY,
  operations: {
    [XMP_SIDECAR_OPERATION]: {
      supported: true,
      side_effect: "mutating",
      idempotent: false,
      reversible: "new_file",
      scope: "filesystem",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "parallel_safe",
      retry_policy: "manual_review_only",
      safe_to_resume: false,
      supported_settings: [...XMP_SUPPORTED_SETTINGS],
    },
  },
});

export type XmpSidecarExportOptions = {
  sourcePath: string;
  destinationPath: string;
  currentSettings: DevelopSettings;
  plan: NormalizedEditPlan;
};

/**
 * Non-Lightroom backend for the explicitly supported global XMP subset.
 * It intentionally has no render/readback methods: sidecar creation alone
 * cannot produce visual acceptance evidence.
 */
export class XmpSidecarBackend {
  readonly name = "xmp-sidecar";
  readonly manifest = XMP_SIDECAR_PLUGIN_MANIFEST;

  async exportXmpSidecar(options: XmpSidecarExportOptions): Promise<XmpSidecarExportRecord> {
    const source = resolve(options.sourcePath);
    const destination = resolve(options.destinationPath);
    if (source.toLowerCase() === destination.toLowerCase()) {
      throw new Error("XMP sidecar output cannot overwrite the source asset");
    }
    const settings = resolveLightroomSettings(options.currentSettings, options.plan);
    const sidecarPath = await writeXmpSidecar(destination, settings);
    return XmpSidecarExportRecordSchema.parse({
      backend: this.name,
      operation: XMP_SIDECAR_OPERATION,
      source_path: source,
      sidecar_path: sidecarPath,
      settings,
      render_verified: false,
      visual_acceptance: "REVIEW_REQUIRED",
      limitations: [
        "This backend creates a sidecar but cannot render or read back editor interpretation.",
        "Camera Raw or Lightroom sidecar import and visual review remain required.",
      ],
    });
  }
}

export const xmpSidecarPlugin = {
  manifest: XMP_SIDECAR_PLUGIN_MANIFEST,
  create: () => new XmpSidecarBackend(),
};
