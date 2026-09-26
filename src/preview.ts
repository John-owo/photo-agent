import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import sharp from "sharp";

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
