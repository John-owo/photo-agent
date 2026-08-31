import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { XMP_SIDECAR_PLUGIN_MANIFEST, XmpSidecarBackend } from "../src/xmp-backend.js";
import { SemanticIntentPlanSchema } from "../src/schemas.js";
import { translateIntent } from "../src/translator.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-t59-xmp-"));
  const sourcePath = join(root, "sample.NEF");
  await writeFile(sourcePath, "source fixture", "utf8");
  const plan = translateIntent(
    SemanticIntentPlanSchema.parse({
      schema_version: "0.1.0",
      creative_goal: "small exposure correction",
      adjustments: [
        {
          parameter: "exposure",
          direction: "increase",
          strength: "slight",
          rationale: "fixture",
          confidence: 0.9,
        },
      ],
      overall_confidence: 0.9,
    }),
  );
  return { root, sourcePath, plan };
}

describe("T59 XMP sidecar backend", () => {
  it("declares only create-sidecar capability and records no visual acceptance", () => {
    expect(XMP_SIDECAR_PLUGIN_MANIFEST.plugin_type).toBe("backend");
    expect(XMP_SIDECAR_PLUGIN_MANIFEST.capabilities).toEqual(["create_xmp_sidecar"]);
    expect(XMP_SIDECAR_PLUGIN_MANIFEST.capabilities).not.toContain("render_preview");
    expect(XMP_SIDECAR_PLUGIN_MANIFEST.operations.create_xmp_sidecar).toMatchObject({
      supported: true,
      supported_settings: expect.arrayContaining(["Exposure2012", "Temperature"]),
    });
    expect("renderPreview" in new XmpSidecarBackend()).toBe(false);
  });

  it("creates a new sidecar and discloses the remaining editor/human gate", async () => {
    const { sourcePath, plan } = await fixture();
    const destinationPath = join(
      await mkdtemp(join(tmpdir(), "photo-agent-t59-out-")),
      "sample.xmp",
    );
    const sourceBefore = await readFile(sourcePath);
    const result = await new XmpSidecarBackend().exportXmpSidecar({
      sourcePath,
      destinationPath,
      currentSettings: { Exposure2012: 0 },
      plan,
    });

    expect(result).toMatchObject({
      backend: "xmp-sidecar",
      operation: "create_xmp_sidecar",
      render_verified: false,
      visual_acceptance: "REVIEW_REQUIRED",
    });
    expect(result.limitations.join(" ")).toMatch(/cannot render|round.?trip/i);
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
    expect(await readFile(destinationPath, "utf8")).toContain('crs:Exposure2012="0.2"');
  });

  it("refuses source overwrite and preserves a pre-existing sidecar", async () => {
    const { root, sourcePath, plan } = await fixture();
    const backend = new XmpSidecarBackend();
    await expect(
      backend.exportXmpSidecar({
        sourcePath,
        destinationPath: sourcePath,
        currentSettings: { Exposure2012: 0 },
        plan,
      }),
    ).rejects.toThrow(/source asset/i);

    const destinationPath = join(root, "existing.xmp");
    await writeFile(destinationPath, "do not replace", "utf8");
    await expect(
      backend.exportXmpSidecar({
        sourcePath,
        destinationPath,
        currentSettings: { Exposure2012: 0 },
        plan,
      }),
    ).rejects.toThrow(/overwrite|existing/i);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("do not replace");
  });

  it("fails before creating output for an unsupported normalized setting", async () => {
    const { sourcePath, plan } = await fixture();
    const destinationPath = join(
      await mkdtemp(join(tmpdir(), "photo-agent-t59-unsupported-")),
      "x.xmp",
    );
    const unsupportedPlan = {
      ...plan,
      operations: [
        {
          ...plan.operations[0]!,
          parameter: "hue_red" as const,
        },
      ],
    };
    await expect(
      new XmpSidecarBackend().exportXmpSidecar({
        sourcePath,
        destinationPath,
        currentSettings: { HueAdjustmentRed: 0 },
        plan: unsupportedPlan,
      }),
    ).rejects.toThrow(/XMP|supported|Lightroom read-back/i);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });
});
