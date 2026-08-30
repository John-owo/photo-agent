import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import sharp from "sharp";

import type { ShootIngestionError } from "./types.js";

export type ShootMetadata = {
  capture_time?: string;
  camera?: string;
  lens?: string;
  width?: number;
  height?: number;
};

export type ShootMetadataResult = {
  metadata: ShootMetadata;
  errors: ShootIngestionError[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issue(source: ShootIngestionError["source"], message: string): ShootIngestionError {
  return { source, stage: "metadata", message };
}

function mergeMetadata(base: ShootMetadata, next: ShootMetadata): ShootMetadata {
  return {
    ...base,
    ...(next.capture_time !== undefined ? { capture_time: next.capture_time } : {}),
    ...(next.camera !== undefined ? { camera: next.camera } : {}),
    ...(next.lens !== undefined ? { lens: next.lens } : {}),
    ...(next.width !== undefined ? { width: next.width } : {}),
    ...(next.height !== undefined ? { height: next.height } : {}),
  };
}

function cleanText(value: string | undefined): string | undefined {
  const cleaned = value?.replaceAll("\0", "").trim();
  return cleaned ? cleaned : undefined;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = cleanText(match?.[1]);
    if (value) return xmlUnescape(value);
  }
  return undefined;
}

function xmpField(text: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escapedKey = key.replaceAll(":", "\\:");
    const localName = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    const escapedLocalName = localName.replaceAll(":", "\\:");
    const value = firstMatch(text, [
      new RegExp(escapedKey + "\\s*=\\s*[\"']([^\"']+)[\"']", "i"),
      new RegExp("<[^>]*" + escapedKey + "[^>]*>\\s*([^<]+?)\\s*</[^>]+>", "i"),
      new RegExp("<[^>]*:" + escapedLocalName + "[^>]*>\\s*([^<]+?)\\s*</[^>]+>", "i"),
    ]);
    if (value) return value;
  }
  return undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseXmp(text: string): ShootMetadata {
  const captureTime = xmpField(text, [
    "exif:DateTimeOriginal",
    "exif:DateTimeDigitized",
    "xmp:CreateDate",
    "photoshop:DateCreated",
    "exif:DateTime",
  ]);
  const make = xmpField(text, ["tiff:Make"]);
  const model = xmpField(text, ["tiff:Model", "exif:Model"]);
  const lens = xmpField(text, ["aux:LensModel", "aux:Lens", "exifEX:LensModel", "exif:LensModel"]);
  const width = positiveInteger(xmpField(text, ["tiff:ImageWidth", "exif:PixelXDimension"]));
  const height = positiveInteger(xmpField(text, ["tiff:ImageLength", "exif:PixelYDimension"]));
  return {
    ...(captureTime ? { capture_time: captureTime } : {}),
    ...(make || model ? { camera: [make, model].filter(Boolean).join(" ") } : {}),
    ...(lens ? { lens } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

type TiffValue = string | number | number[];

function parseExif(exif: Buffer): ShootMetadata {
  const tiffStart = exif.subarray(0, 6).toString("ascii") === "Exif\0\0" ? 6 : 0;
  if (exif.length < tiffStart + 8) throw new Error("EXIF TIFF header is truncated");
  const byteOrder = exif.subarray(tiffStart, tiffStart + 2).toString("ascii");
  if (byteOrder !== "II" && byteOrder !== "MM") throw new Error("EXIF byte order is invalid");
  const littleEndian = byteOrder === "II";
  const readU16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > exif.length) throw new Error("EXIF value is truncated");
    return littleEndian ? exif.readUInt16LE(offset) : exif.readUInt16BE(offset);
  };
  const readU32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > exif.length) throw new Error("EXIF value is truncated");
    return littleEndian ? exif.readUInt32LE(offset) : exif.readUInt32BE(offset);
  };
  if (readU16(tiffStart + 2) !== 42) throw new Error("EXIF TIFF magic is invalid");
  const typeSizes: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    7: 1,
    9: 4,
    10: 8,
  };
  const readValue = (entry: number, type: number, count: number): TiffValue | undefined => {
    const unitSize = typeSizes[type];
    if (!unitSize || count === 0 || count > 1_000_000) return undefined;
    const byteLength = unitSize * count;
    if (!Number.isSafeInteger(byteLength)) throw new Error("EXIF value length is invalid");
    const valueOffset = byteLength <= 4 ? entry + 8 : tiffStart + readU32(entry + 8);
    if (valueOffset < 0 || valueOffset + byteLength > exif.length) {
      throw new Error("EXIF value points outside the file");
    }
    if (type === 2 || type === 7) {
      return cleanText(exif.subarray(valueOffset, valueOffset + byteLength).toString("latin1"));
    }
    const values: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = valueOffset + index * unitSize;
      if (type === 1) values.push(exif[offset]!);
      else if (type === 3) values.push(readU16(offset));
      else if (type === 4) values.push(readU32(offset));
      else return undefined;
    }
    return values.length === 1 ? values[0]! : values;
  };

  let make: string | undefined;
  let model: string | undefined;
  let lens: string | undefined;
  let captureTime: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  const visited = new Set<number>();
  const parseIfd = (offset: number, depth: number): void => {
    if (depth > 4 || visited.has(offset)) return;
    visited.add(offset);
    const entryCount = readU16(offset);
    for (let index = 0; index < entryCount; index += 1) {
      const entry = offset + 2 + index * 12;
      if (entry + 12 > exif.length) throw new Error("EXIF directory is truncated");
      const tag = readU16(entry);
      const type = readU16(entry + 2);
      const count = readU32(entry + 4);
      const value = readValue(entry, type, count);
      if (tag === 0x010f && typeof value === "string") make = value;
      else if (tag === 0x0110 && typeof value === "string") model = value;
      else if (tag === 0xa434 && typeof value === "string") lens = value;
      else if (
        (tag === 0x9003 || tag === 0x9004 || tag === 0x0132) &&
        typeof value === "string" &&
        captureTime === undefined
      ) {
        captureTime = value;
      } else if (tag === 0x0100 && typeof value === "number" && value > 0) width = value;
      else if (tag === 0x0101 && typeof value === "number" && value > 0) height = value;
      else if (tag === 0x8769 && typeof value === "number") {
        parseIfd(tiffStart + value, depth + 1);
      }
    }
  };
  const firstIfd = readU32(tiffStart + 4);
  parseIfd(tiffStart + firstIfd, 0);
  return {
    ...(captureTime ? { capture_time: captureTime } : {}),
    ...(make || model ? { camera: [make, model].filter(Boolean).join(" ") } : {}),
    ...(lens ? { lens } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function sidecarPaths(filePathInput: string): string[] {
  const filePath = resolve(filePathInput);
  return [...new Set([filePath + ".xmp", join(dirname(filePath), parse(filePath).name + ".xmp")])];
}

async function readSidecars(filePaths: string[]): Promise<ShootMetadataResult> {
  let metadata: ShootMetadata = {};
  const errors: ShootIngestionError[] = [];
  const seen = new Set<string>();
  for (const filePath of filePaths.flatMap(sidecarPaths)) {
    const normalized = filePath.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      metadata = mergeMetadata(metadata, parseXmp(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push(
        issue(
          "sidecar",
          "Failed to read metadata sidecar " + filePath + ": " + errorMessage(error),
        ),
      );
    }
  }
  return { metadata, errors };
}

export async function readShootMetadata(
  rawPathInput: string,
  previewPathInput?: string,
): Promise<ShootMetadataResult> {
  const rawPath = resolve(rawPathInput);
  const previewPath = previewPathInput ? resolve(previewPathInput) : undefined;
  const sidecars = await readSidecars([rawPath, ...(previewPath ? [previewPath] : [])]);
  let metadata = sidecars.metadata;
  const errors = [...sidecars.errors];
  if (!previewPath) return { metadata, errors };

  try {
    const previewMetadata = await sharp(previewPath).metadata();
    metadata = mergeMetadata(metadata, {
      ...(previewMetadata.width > 0 ? { width: previewMetadata.width } : {}),
      ...(previewMetadata.height > 0 ? { height: previewMetadata.height } : {}),
    });
    if (previewMetadata.exif) {
      try {
        metadata = mergeMetadata(metadata, parseExif(previewMetadata.exif));
      } catch (error) {
        errors.push(
          issue(
            "preview",
            "Failed to parse EXIF metadata " + previewPath + ": " + errorMessage(error),
          ),
        );
      }
    }
    if (previewMetadata.xmpAsString) {
      metadata = mergeMetadata(metadata, parseXmp(previewMetadata.xmpAsString));
    }
  } catch (error) {
    errors.push(
      issue(
        "preview",
        "Failed to read preview metadata " + previewPath + ": " + errorMessage(error),
      ),
    );
    return { metadata, errors };
  }
  return { metadata, errors };
}
