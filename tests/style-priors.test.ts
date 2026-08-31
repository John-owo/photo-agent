import { describe, expect, it } from "vitest";

import {
  LOW_DATA_STYLE_PRIOR_CONFIDENCE_CAP,
  MIN_HISTORICAL_PREFERENCE_SAMPLES,
  PREFERENCE_REGISTRY_VERSION,
  SCHEMA_VERSION,
  StylePriorPlanSchema,
  StylePriorRequestSchema,
} from "../src/schemas.js";
import {
  resolveStylePriorOperations,
  runStylePriorGoldenVectors,
  translateStylePriorRequest,
} from "../src/style-priors.js";
import type { PreferenceContext, PreferenceRule, StylePriorRequest } from "../src/types.js";

function rule(
  id: string,
  source: PreferenceRule["source"],
  parameter: PreferenceRule["parameter"],
  value: number,
  context: PreferenceContext = {},
  options: Partial<Pick<PreferenceRule, "sample_count" | "confidence" | "evidence" | "mode">> = {},
): PreferenceRule {
  return {
    id,
    source,
    protected: source === "explicit_protected",
    context,
    parameter,
    mode: options.mode ?? "delta",
    value,
    evidence: options.evidence ?? [`evidence:${id}`],
    sample_count: options.sample_count ?? (source === "historical" ? 8 : 0),
    confidence: options.confidence ?? (source === "explicit_protected" ? 0.8 : 0.9),
  };
}

function request(
  rules: PreferenceRule[] = [],
  generalGuidance: PreferenceRule[] = [],
  context: PreferenceContext = { scene_type: "portrait", lighting_type: "stage" },
): StylePriorRequest {
  return {
    schema_version: SCHEMA_VERSION,
    context,
    rules,
    general_guidance: generalGuidance,
  };
}

describe("T44 explicit preference rules and Style Priors", () => {
  it("lets protected explicit preferences override stronger historical tendencies", () => {
    const plan = translateStylePriorRequest(
      request(
        [
          rule(
            "user-portrait-exposure",
            "explicit_protected",
            "exposure_ev",
            -0.2,
            { scene_type: "portrait" },
            {
              sample_count: 1,
              confidence: 0.55,
              evidence: ["user explicitly prefers restrained exposure"],
            },
          ),
          rule(
            "history-portrait-stage-exposure",
            "historical",
            "exposure_ev",
            0.6,
            { scene_type: "portrait", lighting_type: "stage" },
            { sample_count: 24, confidence: 0.95 },
          ),
          rule("history-contrast", "historical", "contrast", 12, {}, { sample_count: 9 }),
        ],
        [rule("general-exposure", "general_guidance", "exposure_ev", 0.1)],
      ),
    );

    expect(plan.preference_registry_version).toBe(PREFERENCE_REGISTRY_VERSION);
    expect(plan.review_required).toBe(false);
    expect(plan.priors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parameter: "exposure_ev",
          value: -0.2,
          basis: "explicit_protected",
          rule_ids: ["user-portrait-exposure"],
          evidence: ["user explicitly prefers restrained exposure"],
          confidence: 0.55,
        }),
        expect.objectContaining({
          parameter: "contrast",
          value: 12,
          basis: "historical",
          sample_count: 9,
        }),
      ]),
    );
    expect(resolveStylePriorOperations(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parameter: "exposure_ev", mode: "delta", value: -0.2 }),
        expect.objectContaining({ parameter: "contrast", mode: "delta", value: 12 }),
      ]),
    );
  });

  it("falls back to general guidance with capped confidence for low-sample history", () => {
    const plan = translateStylePriorRequest(
      request(
        [
          rule(
            "history-stage-shadows-low-data",
            "historical",
            "shadows",
            -18,
            { lighting_type: "stage" },
            { sample_count: MIN_HISTORICAL_PREFERENCE_SAMPLES - 1, confidence: 0.95 },
          ),
        ],
        [
          rule(
            "general-shadows",
            "general_guidance",
            "shadows",
            -5,
            {},
            { confidence: 0.92, evidence: ["general guidance: protect highlight detail"] },
          ),
        ],
      ),
    );
    const prior = plan.priors.find((item) => item.parameter === "shadows");

    expect(prior).toMatchObject({
      value: -5,
      basis: "general_fallback",
      rule_ids: ["general-shadows", "history-stage-shadows-low-data"],
      sample_count: MIN_HISTORICAL_PREFERENCE_SAMPLES - 1,
      confidence: LOW_DATA_STYLE_PRIOR_CONFIDENCE_CAP,
    });
    expect(prior?.evidence).toEqual([
      "general guidance: protect highlight detail",
      "evidence:history-stage-shadows-low-data",
    ]);
    expect(plan.warnings).toContain(
      "Low-sample historical evidence for shadows fell back to general guidance",
    );
    expect(plan.review_required).toBe(false);
  });

  it("requires evidence, enforces protected-source boundaries, and reviews conflicts", () => {
    expect(() =>
      StylePriorRequestSchema.parse(
        request([rule("bad-explicit", "explicit_protected", "contrast", 5, {}, { evidence: [] })]),
      ),
    ).toThrow();
    expect(() =>
      StylePriorRequestSchema.parse({
        ...request(),
        rules: [rule("bad-protection", "historical", "contrast", 5)],
        general_guidance: [
          { ...rule("wrong-guidance-source", "historical", "contrast", 2), protected: false },
        ],
      }),
    ).toThrow(/general_guidance entries must use source/);
    expect(() =>
      translateStylePriorRequest(
        request([rule("out-of-range", "historical", "exposure_ev", 6, {}, { sample_count: 10 })]),
      ),
    ).toThrow(/value must be between/);
    const conflictPlan = translateStylePriorRequest(
      request([
        rule("conflict-a", "explicit_protected", "contrast", 5),
        rule("conflict-b", "explicit_protected", "contrast", -5),
      ]),
    );
    expect(conflictPlan).toMatchObject({ review_required: true });
    expect(conflictPlan.priors).toEqual([]);
    expect(conflictPlan.warnings).toContain(
      "Conflicting protected explicit preference rules for contrast; manual review required",
    );
    expect(() =>
      StylePriorRequestSchema.parse(
        request(
          [rule("duplicate", "historical", "contrast", 1)],
          [rule("duplicate", "general_guidance", "contrast", 1)],
        ),
      ),
    ).toThrow(/may only appear once/);
    expect(() =>
      StylePriorPlanSchema.parse({
        schema_version: SCHEMA_VERSION,
        preference_registry_version: PREFERENCE_REGISTRY_VERSION,
        context: {},
        priors: [],
        warnings: [],
        review_required: false,
        extra: true,
      }),
    ).toThrow();
  });

  it("keeps golden vectors deterministic and isolated", () => {
    const expectedPlan = translateStylePriorRequest(
      request([], [rule("general-contrast", "general_guidance", "contrast", 6)]),
    );
    const vector = {
      id: "style-prior-general-contrast",
      control_group: "global-contrast",
      request: request([], [rule("general-contrast", "general_guidance", "contrast", 6)]),
      expected_plan: expectedPlan,
    };
    expect(runStylePriorGoldenVectors([vector])[0]?.plan).toEqual(expectedPlan);
    expect(() => runStylePriorGoldenVectors([vector, vector])).toThrow(
      /Duplicate Style Prior golden vector/,
    );
  });
});
