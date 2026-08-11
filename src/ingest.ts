import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, parse, resolve } from "node:path";

import { SourceAssetPairSchema } from "./schemas.js";
import type { SourceAssetPair } from "./types.js";

const RAW_EXTENSIONS = new Set([
  ".nef",
  ".nrw",
  ".cr2",
  ".cr3",
  ".arw",
  ".dng",
  ".rw2",
  ".raf",
  ".orf",
  ".pef",
  ".srw",
]);
const PREVIEW_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function assertReadableFile(filePath: string, label: string): Promise<void> {
  await access(filePath, constants.R_OK);
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`${label} must be a non-empty file: ${filePath}`);
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function ingestPair(
  rawPathInput: string,
  previewPathInput: string,
): Promise<SourceAssetPair> {
  const rawPath = resolve(rawPathInput);
  const previewPath = resolve(previewPathInput);
  await assertReadableFile(rawPath, "RAW source");
  await assertReadableFile(previewPath, "preview source");

  if (!RAW_EXTENSIONS.has(extname(rawPath).toLowerCase())) {
    throw new Error(`Unsupported RAW extension: ${rawPath}`);
  }
  if (!PREVIEW_EXTENSIONS.has(extname(previewPath).toLowerCase())) {
    throw new Error(`Unsupported preview extension: ${previewPath}`);
  }
  if (parse(rawPath).name.toLowerCase() !== parse(previewPath).name.toLowerCase()) {
    throw new Error(
      `RAW/preview basename mismatch; refusing ambiguous pairing: ${rawPath} <> ${previewPath}`,
    );
  }

  const [rawSha, previewSha] = await Promise.all([sha256File(rawPath), sha256File(previewPath)]);
  return SourceAssetPairSchema.parse({
    raw_path: rawPath,
    preview_path: previewPath,
    raw_sha256: rawSha,
    preview_sha256: previewSha,
    source_confidence: "high",
  });
}
