import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import { PreviewArtifactSchema, PreviewPolicySchema } from "./schemas.js";
import type { PreviewArtifact } from "./types.js";

export const PREVIEW_POLICY = PreviewPolicySchema.parse({
  schema_version: "0.1.0",
  artifact_kind: "session_preview_policy",
  preview: {
    storage_root: "renders",
    naming: "renders/iteration-{n}/preview.jpg",
    format: "jpeg",
    max_width: 2048,
    max_height: 2048,
    quality: 85,
    sanitized: true,
    retention: "session",
    cloud_transfer: "sanitized_only_with_explicit_opt_in",
  },
  final_export: {
    capability: "export_final",
    availability: "explicit_only",
    requires_explicit_destination: true,
    requires_delivery_settings: true,
    preview_is_not_final: true,
  },
});

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function sessionRelativePath(sessionDir: string, path: string): string {
  return relative(sessionDir, path).split("\\").join("/");
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function createSanitizedPreview(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const preview = await sharp(sourcePath)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  // Exclusive creation also protects an existing destination when writers race.
  await writeFile(destinationPath, preview, { flag: "wx" });
}

/**
 * Materialize the backend's render as the one deterministic, sanitized review
 * artifact for an iteration. The backend render itself must already be inside
 * the session's renders directory; a backend cannot redirect review output to
 * a delivery folder.
 */
export async function materializePreviewArtifact(
  sessionDirInput: string,
  iteration: number,
  backendRenderPath: string,
): Promise<PreviewArtifact> {
  if (!Number.isInteger(iteration) || iteration < 1) {
    throw new Error("Preview iteration must be a positive integer");
  }
  const sessionDir = resolve(sessionDirInput);
  const renderRoot = resolve(join(sessionDir, "renders"));
  const sourcePath = resolve(backendRenderPath);
  if (!isInside(renderRoot, sourcePath)) {
    throw new Error("Backend preview must remain inside the session renders directory");
  }
  const realSessionDir = await realpath(sessionDir);
  const realRenderRoot = await realpath(renderRoot);
  const realSourcePath = await realpath(sourcePath);
  if (!isInside(realSessionDir, realRenderRoot) || !isInside(realRenderRoot, realSourcePath)) {
    throw new Error("Resolved backend preview must remain inside the session renders directory");
  }
  const destinationPath = join(renderRoot, `iteration-${iteration}`, "preview.jpg");
  const outputDirectory = join(realRenderRoot, `iteration-${iteration}`);
  await mkdir(outputDirectory, { recursive: true });
  const realOutputDirectory = await realpath(outputDirectory);
  if (!isInside(realRenderRoot, realOutputDirectory)) {
    throw new Error("Resolved preview output must remain inside the session renders directory");
  }
  const outputPath = join(realOutputDirectory, "preview.jpg");
  try {
    await access(outputPath);
    throw new Error(`Deterministic preview already exists: ${destinationPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await createSanitizedPreview(realSourcePath, outputPath);
  const metadata = await sharp(outputPath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Sanitized preview has no dimensions: ${destinationPath}`);
  }
  return PreviewArtifactSchema.parse({
    schema_version: "0.1.0",
    artifact_id: `preview-iteration-${iteration}`,
    iteration,
    path: sessionRelativePath(sessionDir, destinationPath),
    source_path: sessionRelativePath(sessionDir, sourcePath),
    sha256: await sha256File(outputPath),
    mime_type: "image/jpeg",
    width: metadata.width,
    height: metadata.height,
    retention: "session",
    delivery_export: false,
  });
}

export async function writeFixtureJpeg(destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const fixture = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
    },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFile(destinationPath, fixture, { flag: "wx" });
}
