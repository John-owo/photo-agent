import { describe, expect, it } from "vitest";

import {
  STYLE_HISTORY_REGISTRY_VERSION,
  SCHEMA_VERSION,
  StyleHistoryQuerySchema,
  StyleHistorySnapshotSchema,
} from "../src/schemas.js";
import {
  buildStyleHistorySnapshot,
  retrieveStyleHistory,
  runStyleHistoryGoldenVectors,
} from "../src/style-history.js";
import type {
  StyleHistoryExample,
  StyleHistoryQuery,
  StylePerceptualProfile,
} from "../src/types.js";

const datasetSha256 = "a".repeat(64);

function profile(overrides: Partial<StylePerceptualProfile> = {}): StylePerceptualProfile {
  return {
    luminance: 0.1,
    contrast: 0.2,
    colorfulness: 0.15,
    warmth: 0.1,
    natural_skin_tones: true,
    ...overrides,
  };
}

function example(
  exampleId: string,
  shootId: string,
  context: StyleHistoryExample["context"],
  options: Partial<
    Pick<StyleHistoryExample, "confidence" | "failures" | "perceptual_profile" | "evidence">
  > = {},
): StyleHistoryExample {
  return {
    example_id: exampleId,
    shoot_id: shootId,
    context,
    perceptual_profile: options.perceptual_profile ?? profile(),
    evidence: options.evidence ?? [`review:${exampleId}`],
    confidence: options.confidence ?? 0.92,
    failures: options.failures ?? [],
  };
}

function query(overrides: Partial<StyleHistoryQuery> = {}): StyleHistoryQuery {
  return {
    schema_version: SCHEMA_VERSION,
    query_id: "history-query-001",
    context: {
      lighting_type: "stage",
      subject_type: "portrait",
      camera: "Nikon Z8",
      lens: "85mm",
      iso: 800,
      delivery: "web",
    },
    protected_attributes: ["natural_skin_tones"],
    target_profile: profile(),
    exclude_shoot_ids: [],
    exclude_example_ids: [],
    max_results: 8,
    min_confidence: 0.65,
    ...overrides,
  };
}

describe("T45 scene-conditioned Style Memory retrieval", () => {
  it("retrieves reproducible perceptual references and excludes unsafe history", () => {
    const snapshot = buildStyleHistorySnapshot(
      "style-memory",
      "revision-2026-08-31",
      datasetSha256,
      [
        example(
          "held-out-safe",
          "shoot-safe",
          {
            lighting_type: "stage",
            subject_type: "portrait",
            camera: "Nikon Z8",
            lens: "85mm",
            iso: 800,
            delivery: "web",
          },
          { perceptual_profile: profile({ warmth: 0.12 }) },
        ),
        example("wrong-scene", "shoot-wrong", {
          lighting_type: "daylight",
          subject_type: "landscape",
          camera: "Nikon Z6",
          lens: "24mm",
          iso: 100,
          delivery: "print",
        }),
        example(
          "low-confidence",
          "shoot-low",
          {
            lighting_type: "stage",
            subject_type: "portrait",
            camera: "Nikon Z8",
            lens: "85mm",
            iso: 800,
            delivery: "web",
          },
          { confidence: 0.4 },
        ),
        example(
          "failed-history",
          "shoot-failed",
          {
            lighting_type: "stage",
            subject_type: "portrait",
          },
          { failures: ["render evidence missing"] },
        ),
        example(
          "unsafe-skin",
          "shoot-unsafe",
          {
            lighting_type: "stage",
            subject_type: "portrait",
            camera: "Nikon Z8",
            lens: "85mm",
            iso: 800,
            delivery: "web",
          },
          { perceptual_profile: profile({ natural_skin_tones: false }) },
        ),
        example("construction-example", "shoot-construction", {
          lighting_type: "stage",
          subject_type: "portrait",
          camera: "Nikon Z8",
          lens: "85mm",
          iso: 800,
          delivery: "web",
        }),
      ],
    );
    const result = retrieveStyleHistory(
      snapshot,
      query({ exclude_shoot_ids: ["shoot-construction"] }),
    );

    expect(result).toMatchObject({
      history_registry_version: STYLE_HISTORY_REGISTRY_VERSION,
      dataset_id: "style-memory",
      dataset_revision: "revision-2026-08-31",
      dataset_sha256: datasetSha256,
      population: 6,
      sample_size: 1,
    });
    expect(result.matches[0]).toMatchObject({
      example_id: "held-out-safe",
      rank: 1,
      protected_attributes: ["natural_skin_tones"],
      reference_relationship: { natural_skin_tones_preserved: true },
    });
    expect(result.matches[0]).not.toHaveProperty("settings");
    expect(result.review_outcomes).toEqual(
      expect.arrayContaining([
        "low_confidence_history_excluded",
        "irrelevant_history_excluded",
        "history_example_failure_excluded",
        "protected_skin_tone_reference_excluded",
      ]),
    );
    expect(result.failures).toEqual(["failed-history: render evidence missing"]);
  });

  it("matches by perceptual relationship without copying raw edit settings", () => {
    const snapshot = buildStyleHistorySnapshot("style-memory", "r2", datasetSha256, [
      example(
        "perceptual-a",
        "shoot-a",
        { lighting_type: "stage" },
        {
          perceptual_profile: profile({
            luminance: 0.5,
            contrast: 0.5,
          }),
        },
      ),
      example(
        "perceptual-b",
        "shoot-b",
        { lighting_type: "stage" },
        {
          perceptual_profile: profile({
            luminance: -0.8,
            contrast: -0.8,
            colorfulness: -0.8,
            warmth: -0.8,
          }),
        },
      ),
    ]);
    const result = retrieveStyleHistory(
      snapshot,
      query({
        context: { lighting_type: "stage" },
        protected_attributes: [],
        target_profile: profile({ luminance: 0.45, contrast: 0.45 }),
      }),
    );

    expect(result.matches[0]?.example_id).toBe("perceptual-a");
    expect(result.matches[0]?.reference_relationship).toEqual({
      luminance_delta: 0.05,
      contrast_delta: 0.05,
      colorfulness_delta: 0,
      warmth_delta: 0,
      natural_skin_tones_preserved: true,
    });
    expect(result.matches[0]?.match_components.perceptual_profile).toBeGreaterThan(
      result.matches[1]?.match_components.perceptual_profile ?? 0,
    );
  });

  it("validates shoot/history identity and query boundaries", () => {
    expect(() => StyleHistoryQuerySchema.parse(query({ context: {} }))).toThrow(
      /requires at least one context field/,
    );
    expect(() =>
      StyleHistoryQuerySchema.parse(
        query({ protected_attributes: ["natural_skin_tones", "natural_skin_tones"] }),
      ),
    ).toThrow(/may not contain duplicates/);
    const validSnapshot = buildStyleHistorySnapshot("style-memory", "r1", datasetSha256, [
      example("duplicate", "shoot-a", { lighting_type: "stage" }),
    ]);
    expect(() =>
      StyleHistorySnapshotSchema.parse({
        ...validSnapshot,
        examples: [...validSnapshot.examples, validSnapshot.examples[0]],
      }),
    ).toThrow(/may only appear once/);
  });

  it("keeps golden vectors reproducible and rejects duplicate vector ids", () => {
    const snapshot = buildStyleHistorySnapshot("style-memory", "r3", datasetSha256, [
      example("vector-example", "shoot-vector", { lighting_type: "stage" }),
    ]);
    const requested = query({ context: { lighting_type: "stage" }, protected_attributes: [] });
    const expected = retrieveStyleHistory(snapshot, requested);
    const vector = {
      id: "history-vector",
      control_group: "stage-reference",
      snapshot,
      query: requested,
      expected_result: expected,
    };
    expect(runStyleHistoryGoldenVectors([vector])[0]?.result).toEqual(expected);
    expect(() => runStyleHistoryGoldenVectors([vector, vector])).toThrow(
      /Duplicate style history golden vector/,
    );
  });
});
