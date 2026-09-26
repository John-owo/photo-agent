import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createSanitizedPreview, writeFixtureJpeg } from "../src/preview.js";
import { MockBackend } from "../src/backends.js";
import { MockProvider } from "../src/providers.js";
import { runSinglePhoto } from "../src/workflow.js";
import type { RenderResult } from "../src/types.js";

async function sourceFixture(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-preview-safety-"));
  const source = join(root, "source.jpg");
  await writeFixtureJpeg(source);
  return { root, source };
}

describe("create-only preview output", () => {
  it.each(["sanitized", "fixture"] as const)(
    "%s output preserves an existing destination byte-for-byte",
    async (kind) => {
      const { root, source } = await sourceFixture();
      const destination = join(root, "existing.jpg");
      await writeFile(destination, "preserved existing derivative", { flag: "wx" });
      const before = await stat(destination);
      const generate =
        kind === "sanitized"
          ? () => createSanitizedPreview(source, destination)
          : () => writeFixtureJpeg(destination);

      await expect(generate()).rejects.toMatchObject({ code: "EEXIST" });

      expect(await readFile(destination, "utf8")).toBe("preserved existing derivative");
      expect((await stat(destination)).mtimeMs).toBe(before.mtimeMs);
    },
  );

  it("refuses the source itself as a destination", async () => {
    const { source } = await sourceFixture();
    const before = await readFile(source);
    await expect(createSanitizedPreview(source, source)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(source)).toEqual(before);
  });

  it.each(["sanitized", "fixture"] as const)(
    "%s concurrent output has exactly one writer",
    async (kind) => {
      const { root, source } = await sourceFixture();
      const destination = join(root, "new", "preview.jpg");
      const generate =
        kind === "sanitized"
          ? () => createSanitizedPreview(source, destination)
          : () => writeFixtureJpeg(destination);
      const results = await Promise.allSettled([generate(), generate()]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "EEXIST" },
      });
      expect(await sharp(destination).metadata()).toMatchObject({
        format: "jpeg",
        width: 1,
        height: 1,
      });
    },
  );

  it("does not reserve or truncate a destination when decoding fails", async () => {
    const { root } = await sourceFixture();
    const invalid = join(root, "invalid-input.bin");
    const destination = join(root, "preview.jpg");
    await writeFile(invalid, "not an image", { flag: "wx" });

    await expect(createSanitizedPreview(invalid, destination)).rejects.toThrow();
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps preview dimensions bounded and strips source metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-preview-metadata-"));
    const source = join(root, "source.jpg");
    const destination = join(root, "preview.jpg");
    const pixels = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: "grey" },
    })
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: "synthetic private fixture" } })
      .jpeg()
      .toBuffer();
    await writeFile(source, pixels, { flag: "wx" });
    expect((await sharp(source).metadata()).exif).toBeDefined();

    await createSanitizedPreview(source, destination);

    const metadata = await sharp(destination).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 1024, height: 2048 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(await readFile(source)).toEqual(pixels);
  });

  it("stops a workflow on an evaluation-preview collision before invoking the evaluator", async () => {
    const { root, source } = await sourceFixture();
    const raw = join(root, "source.NEF");
    await writeFile(raw, "synthetic RAW fixture", { flag: "wx" });
    let protectedPreview = "";
    let evaluatorCalls = 0;
    class CollidingBackend extends MockBackend {
      override async renderPreview(photoId: string, destination: string): Promise<RenderResult> {
        const rendered = await super.renderPreview(photoId, destination);
        protectedPreview = join(destination, "..", "..", "evaluations", "iteration-1-analysis.jpg");
        await mkdir(join(destination, "..", "..", "evaluations"), { recursive: true });
        await writeFile(protectedPreview, "existing evaluation evidence", { flag: "wx" });
        return rendered;
      }
    }
    const backend = new CollidingBackend(raw);

    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: source,
      sessionRoot: join(root, "sessions"),
      provider: new MockProvider(),
      backend,
      apply: true,
      allowCloudPreview: true,
      evaluator: {
        name: "local-collision-fixture",
        requiresCloudPreview: true,
        evaluate: async () => {
          evaluatorCalls += 1;
          throw new Error("Evaluator must not receive a collided preview");
        },
      },
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(evaluatorCalls).toBe(0);
    expect(await readFile(protectedPreview, "utf8")).toBe("existing evaluation evidence");
    expect(backend.calls.filter((call) => call === "apply_global_adjustment")).toHaveLength(1);
    expect(await readFile(join(result.sessionDir, "error.json"), "utf8")).toContain("EEXIST");
  });
});
