import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { resolveLightroomSettings } from "./translator.js";
import type { NormalizedEditPlan } from "./types.js";

const XMP_EXTENSION = ".xmp";
const SUPPORTED_XMP_KEYS = new Set([
  "WhiteBalance",
  "Temperature",
  "Tint",
  "Exposure2012",
  "Contrast2012",
  "Highlights2012",
  "Shadows2012",
  "Whites2012",
  "Blacks2012",
  "Texture",
  "Clarity2012",
  "Dehaze",
  "Vibrance",
  "Saturation",
]);

export type DevelopSettings = Record<string, number | string | boolean>;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatXmpValue(value: number | string | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

function assertSupportedSettings(settings: DevelopSettings): void {
  const unsupported = Object.keys(settings).filter((key) => !SUPPORTED_XMP_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new Error(`XMP fallback does not support settings: ${unsupported.join(", ")}`);
  }
}

/** Create a minimal Lightroom-compatible XMP sidecar for global develop settings. */
export function createXmpSidecar(settings: DevelopSettings): string {
  assertSupportedSettings(settings);
  const attributes = Object.entries(settings)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `        crs:${key}="${escapeXml(formatXmpValue(value))}"`)
    .join("\n");
  const descriptionAttributes = attributes ? `\n${attributes}` : "";
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photo-agent v0.1">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    `${descriptionAttributes} />`,
    "  </rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
    "",
  ].join("\n");
}

/**
 * Write a new XMP file without ever overwriting an existing sidecar.
 * The caller should choose a session or delivery path explicitly.
 */
export async function writeXmpSidecar(
  destinationPath: string,
  settings: DevelopSettings,
): Promise<string> {
  const destination = resolve(destinationPath);
  if (extname(destination).toLowerCase() !== XMP_EXTENSION) {
    throw new Error(`XMP output must use the .xmp extension: ${destination}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, createXmpSidecar(settings), { encoding: "utf8", flag: "wx" });
  return destination;
}

export async function exportXmpSidecar(
  destinationPath: string,
  currentSettings: DevelopSettings,
  plan: NormalizedEditPlan,
): Promise<{ path: string; settings: DevelopSettings }> {
  const settings = resolveLightroomSettings(currentSettings, plan);
  const path = await writeXmpSidecar(destinationPath, settings);
  return { path, settings };
}
