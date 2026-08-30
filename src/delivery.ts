import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { FinalExportSettingsSchema } from "./schemas.js";
import type { BackendAdapter, FinalExportSettings, RenderResult } from "./types.js";

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  const separator = process.platform === "win32" ? "\\" : "/";
  return (
    child !== "" && child !== ".." && !child.startsWith(`..${separator}`) && !isAbsolute(child)
  );
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  return resolve(root) === resolve(candidate) || isInside(root, candidate);
}

export type FinalExportOptions = {
  backend: BackendAdapter;
  photoId: string;
  destination: string;
  settings: FinalExportSettings;
  sessionDir?: string;
};

/**
 * Run the deliberately separate delivery-export seam. Preview artifacts never
 * satisfy this interface: callers must provide a destination and complete
 * delivery settings, and the negotiated backend must expose `export_final`.
 */
export async function exportFinal(options: FinalExportOptions): Promise<RenderResult> {
  if (!options.destination.trim()) {
    throw new Error("Final export requires an explicit destination");
  }
  const settings = FinalExportSettingsSchema.parse(options.settings);
  const destination = resolve(options.destination);
  if (options.sessionDir && isInsideOrEqual(resolve(options.sessionDir, "renders"), destination)) {
    throw new Error("Final export destination cannot be the session preview directory");
  }
  if (!options.backend.exportFinal) {
    throw new Error(
      "Backend does not advertise export_final; preview cannot be used as final export",
    );
  }
  if (!options.backend.capabilities.capabilities.includes("export_final")) {
    throw new Error("Backend handshake does not advertise export_final");
  }
  await mkdir(destination, { recursive: true });
  return options.backend.exportFinal(options.photoId, destination, settings);
}
