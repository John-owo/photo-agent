import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend, nextCopyVersionName } from "../src/backends.js";
import { AcceptingMockEvaluator, HandoffEvaluator } from "../src/evaluation.js";
import { writeFixtureJpeg } from "../src/preview.js";
import {
  ensureRecipePreset,
  matchRecipeProfile,
  parseLookProfile,
  recipePresetXmp,
  scanRecipeProfiles,
} from "../src/recipes.js";
import { SemanticIntentPlanSchema } from "../src/schemas.js";
import type { AnalysisProvider } from "../src/types.js";
import { runUnattendedBatch } from "../src/unattended.js";
import { runSinglePhoto } from "../src/workflow.js";

const PRESET = "photo-agent recipe Z5II VitalityFilm Pmango";

const PROFILE_XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Look"
   crs:UUID="0AA92BA531E04995B7CC965DEAFBDC5B"
   crs:SupportsAmount="True"
   crs:SupportsMonochrome="False"
   crs:CameraModelRestriction="Nikon Z 5 2"
   crs:Version="17.5"
   crs:ProcessVersion="15.4"
   crs:ConvertToGrayscale="False"
   crs:CameraProfile="Camera Flexible Color"
   crs:RGBTable="ABC123"
   crs:Table_ABC123="lut-payload"
   crs:HasSettings="True">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Z5II VitalityFilm Pmango</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Nikon Recipes</rdf:li>
    </rdf:Alt>
   </crs:Group>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

function provider(withTemperature = false): AnalysisProvider {
  return {
    requiresCloudPreview: false,
    async analyze() {
      return {
        intent: SemanticIntentPlanSchema.parse({
          schema_version: "0.1.0",
          creative_goal: "lift shadows",
          adjustments: [
            {
              parameter: "shadows",
              direction: "increase",
              strength: "slight",
              rationale: "dark jackets",
              confidence: 0.9,
            },
            ...(withTemperature
              ? [
                  {
                    parameter: "temperature",
                    direction: "decrease",
                    strength: "slight",
                    rationale: "slightly orange",
                    confidence: 0.8,
                  },
                ]
              : []),
          ],
          overall_confidence: 0.9,
        }),
        metadata: {
          provider: "mock",
          model: "copy-setup",
          promptVersion: "test",
          promptHash: "0".repeat(64),
          cloudPreview: false,
        },
      };
    },
  };
}

async function fixture(): Promise<{ root: string; raw: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-setup-"));
  const raw = join(root, "DSC_0001.NEF");
  const preview = join(root, "DSC_0001.JPG");
  await writeFile(raw, "synthetic raw", "utf8");
  await writeFixtureJpeg(preview);
  return { root, raw, preview };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("Workflow Copy version names", () => {
  it("picks the next free vN", () => {
    expect(nextCopyVersionName([])).toBe("v1");
    expect(nextCopyVersionName(["v1", "v3", "my edit", "Lightroom MCP VC [x]"])).toBe("v4");
    expect(nextCopyVersionName(["v10", "v2"])).toBe("v11");
  });

  it("renames the verified Copy and applies the recipe preset before the first edit", async () => {
    const { root, raw, preview } = await fixture();
    const backend = new MockBackend(raw, {
      organizer: { existingCopyNames: ["v1", "v2"], presets: [PRESET] },
    });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: provider(),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
      copySetup: {
        recipePreset: { presetName: PRESET, profileName: "Z5II VitalityFilm Pmango" },
      },
    });
    expect(result.state).toBe("ACCEPTED");
    const setup = await readJson<{
      name: { result: string; copy_name: string };
      recipe: { result: string };
    }>(join(result.sessionDir, "workflow-copy-setup.json"));
    expect(setup.name).toMatchObject({ result: "renamed", copy_name: "v3" });
    expect(setup.recipe.result).toBe("applied");
    const presetAt = backend.calls.indexOf("apply_develop_preset");
    const editAt = backend.calls.indexOf("apply_global_adjustment");
    expect(presetAt).toBeGreaterThan(-1);
    expect(presetAt).toBeLessThan(editAt);
    expect(backend.appliedPresets[0]?.photoId).toMatch(/^mock-copy-/);
  });

  it("drops Temperature when the recipe makes the Copy stop reporting it", async () => {
    // Live run 2026-11-27: the Master reported Temperature after an earlier render,
    // the Copy did not after the recipe preset, and the checkpoint refused.
    const { root, raw, preview } = await fixture();
    const backend = new MockBackend(raw, {
      organizer: { presets: [PRESET], presetDropsKeys: ["Temperature", "Tint"] },
    });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: provider(true),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
      copySetup: { recipePreset: { presetName: PRESET, profileName: "Pmango" } },
    });
    expect(result.state).toBe("ACCEPTED");
    const report = await readJson<{ skipped_operations: string[] }>(
      join(result.sessionDir, "iteration-report.json"),
    );
    expect(report.skipped_operations.join(" ")).toContain("Temperature");
  });

  it("keeps editing when the preset is missing or the backend cannot rename", async () => {
    const { root, raw, preview } = await fixture();
    const missingPreset = new MockBackend(raw, { organizer: { presets: [] } });
    const first = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: provider(),
      backend: missingPreset,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
      copySetup: { recipePreset: { presetName: PRESET, profileName: "Pmango" } },
    });
    expect(first.state).toBe("ACCEPTED");
    const firstSetup = await readJson<{ recipe: { result: string; error: string } }>(
      join(first.sessionDir, "workflow-copy-setup.json"),
    );
    expect(firstSetup.recipe.result).toBe("failed");
    expect(firstSetup.recipe.error).toContain("Preset not found");

    const oldBackend = new MockBackend(raw);
    const second = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: provider(),
      backend: oldBackend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(second.state).toBe("ACCEPTED");
    const secondSetup = await readJson<{ name: { result: string } }>(
      join(second.sessionDir, "workflow-copy-setup.json"),
    );
    expect(secondSetup.name.result).toBe("unsupported");
  });
});

describe("recipe profiles", () => {
  it("parses a Look profile and matches it by recipe and camera", () => {
    const profile = parseLookProfile(PROFILE_XMP, "C:/x/Nikon_Z5II_VitalityFilm_Pmango.xmp");
    expect(profile).toMatchObject({
      name: "Z5II VitalityFilm Pmango",
      uuid: "0AA92BA531E04995B7CC965DEAFBDC5B",
      cameraRestriction: "Nikon Z 5 2",
      group: "Nikon Recipes",
    });
    const profiles = [profile!];
    expect(
      matchRecipeProfile({ model: "NIKON Z5_2", recipe: "VitalityFilm_Pmango" }, profiles).status,
    ).toBe("matched");
    expect(
      matchRecipeProfile({ model: "NIKON Z 6_3", recipe: "VitalityFilm_Pmango" }, profiles).status,
    ).toBe("no_profile");
    expect(matchRecipeProfile({ model: "NIKON Z5_2", recipe: "Standard" }, profiles).status).toBe(
      "builtin",
    );
    expect(
      matchRecipeProfile({ model: "NIKON Z5_2", recipe: "Cinema_Teal" }, profiles).status,
    ).toBe("no_profile");
  });

  it("wraps the profile in a preset that only sets the Look, and writes it once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "photo-agent-crs-"));
    await writeFile(join(dir, "Nikon_Z5II_VitalityFilm_Pmango.xmp"), PROFILE_XMP, "utf8");
    const [profile] = await scanRecipeProfiles(dir);
    const xmp = recipePresetXmp(PROFILE_XMP, profile!);
    expect(xmp).toContain('crs:PresetType="Normal"');
    expect(xmp).toContain("<crs:Look>");
    expect(xmp).toContain('crs:UUID="0AA92BA531E04995B7CC965DEAFBDC5B"');
    expect(xmp).toContain('crs:Table_ABC123="lut-payload"');
    expect(xmp).not.toMatch(/crs:Exposure2012/);
    const first = await ensureRecipePreset(profile!, dir);
    expect(first).toMatchObject({ created: true, presetName: PRESET });
    const second = await ensureRecipePreset(profile!, dir);
    expect(second.created).toBe(false);
    expect((await scanRecipeProfiles(dir)).map((p) => p.name)).toEqual([
      "Z5II VitalityFilm Pmango",
    ]);
  });
});

describe("batch pick/rating filter", () => {
  async function shoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-filter-"));
    const dir = join(root, "shoot");
    await mkdir(dir);
    for (const name of ["C_001", "C_002"]) {
      await writeFile(join(dir, `${name}.NEF`), `raw ${name}`, "utf8");
      await writeFixtureJpeg(join(dir, `${name}.JPG`));
    }
    return dir;
  }

  function options(dir: string, organizer: Record<string, unknown>) {
    return {
      root: dir,
      batchRoot: join(dir, "..", "batches"),
      providerFactory: provider,
      evaluatorFactory: () => new HandoffEvaluator(),
      backendFactory: (rawPath: string) => new MockBackend(rawPath, { organizer }),
      allowCloudPreview: false,
      maxIterations: 1,
      maskPolicy: {},
      mode: "unattended" as const,
      labels: { provider: "mock", evaluator: "handoff", backend: "mock" },
      exiftool: null,
    };
  }

  it("skips photos below the rating or not picked, and reports it", async () => {
    const dir = await shoot();
    const low = await runUnattendedBatch({ ...options(dir, { rating: 2 }), minRating: 3 });
    expect(low.records).toHaveLength(0);
    expect(low.filter).toEqual({ kept: 0, excluded: 2, unresolved: 0 });
    expect(await readFile(low.reportPath, "utf8")).toContain("3 星以上；排除 2 張");

    const picked = await runUnattendedBatch({
      ...options(dir, { rating: 4, pick: 1 }),
      onlyPicked: true,
      minRating: 3,
    });
    expect(picked.records).toHaveLength(2);
    const rejected = await runUnattendedBatch({
      ...options(dir, { rating: 5, pick: -1 }),
      minRating: 0,
    });
    expect(rejected.records).toHaveLength(0);
  });
});
