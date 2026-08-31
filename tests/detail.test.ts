import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  DETAIL_BACKEND_SETTINGS,
  assertBackendSupportsDetailPlan,
  assertDetailReadback,
  assessDetailCapability,
  resolveDetailReadback,
  resolveDetailSettings,
  runDetailGoldenVectors,
  translateDetailIntent,
} from "../src/detail.js";
import {
  DETAIL_PROPAGATION_POLICY,
  DETAIL_REGISTRY_VERSION,
  BackendCapabilityManifestSchema,
  DetailIntentSchema,
  DetailPlanSchema,
  SCHEMA_VERSION,
} from "../src/schemas.js";
import type { DetailIntent, DetailOperation } from "../src/types.js";

const sharpening = {
  kind: "sharpening" as const,
  mode: "absolute" as const,
  amount: 65,
  radius: 1.2,
  detail: 35,
  masking: 30,
  confidence: 0.95,
  rationale: "fixture sharpening",
};

const noiseReduction = {
  kind: "noise_reduction" as const,
  mode: "absolute" as const,
  luminance: 45,
  luminance_detail: 50,
  luminance_contrast: 10,
  color: 30,
  color_detail: 50,
  color_smoothness: 50,
  confidence: 0.9,
  rationale: "fixture noise reduction",
};

function intent(
  operations: DetailOperation[],
  context: DetailIntent["context"] = {
    scene_type: "landscape",
    iso: 3200,
    lighting_type: "ambient",
  },
): DetailIntent {
  return {
    schema_version: SCHEMA_VERSION,
    creative_goal: "scene-aware detail fixture",
    context,
    operations,
    overall_confidence: 0.95,
  };
}

function readback(operations: readonly unknown[]) {
  return {
    schema_version: SCHEMA_VERSION,
    detail_registry_version: DETAIL_REGISTRY_VERSION,
    operations,
  };
}

describe("T34 scene-aware detail planning", () => {
  it("translates bounded sharpening/noise controls and retains scene/ISO context", () => {
    const plan = translateDetailIntent(intent([sharpening, noiseReduction]));

    expect(plan.context).toEqual({
      scene_type: "landscape",
      iso: 3200,
      lighting_type: "ambient",
    });
    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "sharpening",
      "noise_reduction",
    ]);
    expect(plan.propagation_policy).toEqual(DETAIL_PROPAGATION_POLICY);
    expect(resolveDetailSettings(plan)).toEqual({
      Sharpness: 65,
      SharpenRadius: 1.2,
      SharpenDetail: 35,
      SharpenEdgeMasking: 30,
      LuminanceSmoothing: 45,
      LuminanceNoiseReductionDetail: 50,
      LuminanceNoiseReductionContrast: 10,
      ColorNoiseReduction: 30,
      ColorNoiseReductionDetail: 50,
      ColorNoiseReductionSmoothness: 50,
    });
  });

  it("enforces bounds, dependencies, duplicate conflicts, and omits AI Denoise", () => {
    expect(() => DetailIntentSchema.parse(intent([{ ...sharpening, amount: 151 }]))).toThrow();
    expect(() => DetailIntentSchema.parse(intent([{ ...sharpening, radius: 0.4 }]))).toThrow();
    expect(() => DetailIntentSchema.parse(intent([sharpening, sharpening]))).toThrow(
      /may only appear once/,
    );
    expect(() =>
      DetailIntentSchema.parse(intent([{ ...noiseReduction, luminance: 101 }])),
    ).toThrow();
    expect(() =>
      DetailIntentSchema.parse(
        intent([
          {
            kind: "ai_denoise",
            mode: "absolute",
            amount: 50,
            confidence: 0.95,
            rationale: "must not be approximated",
          } as never,
        ]),
      ),
    ).toThrow();

    const lowIsoIntent = intent([noiseReduction], { scene_type: "night", iso: 400 });
    const lowIsoPlan = translateDetailIntent(lowIsoIntent);
    expect(lowIsoPlan.operations).toEqual([]);
    expect(lowIsoPlan.warnings[0]).toMatch(/ISO 400 is below/);
    expect(() =>
      DetailPlanSchema.parse({
        ...lowIsoPlan,
        operations: [noiseReduction],
      }),
    ).toThrow(/requires ISO/);

    const portraitPlan = translateDetailIntent(
      intent([{ ...sharpening, masking: 10 }], { scene_type: "portrait", iso: 400 }),
    );
    expect(portraitPlan.operations).toEqual([]);
    expect(portraitPlan.warnings[0]).toMatch(/portrait-like scenes/);
  });

  it("reconciles readback and runs independent detail golden vectors", () => {
    const plan = translateDetailIntent(intent([sharpening, noiseReduction]));
    const current = readback([
      {
        kind: "sharpening",
        amount: 40,
        radius: 1,
        detail: 20,
        masking: 20,
      },
    ]);
    const expected = resolveDetailReadback(current, plan);
    expect(expected.operations.map((operation) => operation.kind)).toEqual([
      "sharpening",
      "noise_reduction",
    ]);
    expect(assertDetailReadback(plan, expected)).toEqual(expected);
    expect(() =>
      assertDetailReadback(plan, {
        ...expected,
        operations: expected.operations.map((operation) =>
          operation.kind === "noise_reduction" ? { ...operation, luminance: 1 } : operation,
        ),
      }),
    ).toThrow(/readback mismatch: noise_reduction/);

    const vectors = runDetailGoldenVectors([
      {
        id: "detail-controls",
        control_group: "detail",
        intent: intent([sharpening, noiseReduction]),
        expected_plan: plan,
        current_readback: current,
        expected_readback: expected,
      },
    ]);
    expect(vectors[0]?.settings).toMatchObject({ Sharpness: 65, LuminanceSmoothing: 45 });
    expect(() =>
      runDetailGoldenVectors([
        {
          id: "duplicate",
          control_group: "one",
          intent: intent([]),
          expected_plan: translateDetailIntent(intent([])),
        },
        {
          id: "duplicate",
          control_group: "two",
          intent: intent([]),
          expected_plan: translateDetailIntent(intent([])),
        },
      ]),
    ).toThrow(/Duplicate detail golden vector/);
  });

  it("requires complete declared capabilities and returns review for gaps", () => {
    const plan = translateDetailIntent(intent([sharpening, noiseReduction]));
    expect(() => assertBackendSupportsDetailPlan(MOCK_CAPABILITIES, plan)).toThrow(
      /does not declare structured detail-operation support/,
    );
    const refused = assessDetailCapability(MOCK_CAPABILITIES, plan);
    expect(refused.outcome).toBe("REVIEW_REQUIRED");
    expect(refused.missing_operations).toEqual(["sharpening", "noise_reduction"]);
    expect(refused.missing_settings).toEqual(
      expect.arrayContaining([...DETAIL_BACKEND_SETTINGS.sharpening]),
    );

    const capableManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_detail_operations: ["sharpening", "noise_reduction"],
          supported_settings: [
            ...DETAIL_BACKEND_SETTINGS.sharpening,
            ...DETAIL_BACKEND_SETTINGS.noise_reduction,
          ],
        },
      },
    });
    expect(() => assertBackendSupportsDetailPlan(capableManifest, plan)).not.toThrow();
    expect(assessDetailCapability(capableManifest, plan)).toEqual({
      outcome: "READY",
      missing_operations: [],
      missing_settings: [],
    });
  });

  it("turns low-confidence or unsafe detail intent into explicit review", () => {
    const plan = translateDetailIntent(intent([{ ...sharpening, confidence: 0.64 }]));
    expect(plan.operations).toEqual([]);
    expect(plan.propagation_policy.eligible).toBe(false);
    expect(assessDetailCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_operations: [],
    });
  });
});
