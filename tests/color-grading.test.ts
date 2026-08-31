import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  COLOR_GRADING_BACKEND_SETTINGS,
  assertBackendSupportsColorGradingPlan,
  assertColorGradingReadback,
  assessColorGradingCapability,
  resolveColorGradingReadback,
  resolveColorGradingSettings,
  runColorGradingGoldenVectors,
  translateColorGradingIntent,
} from "../src/color-grading.js";
import {
  BackendCapabilityManifestSchema,
  COLOR_GRADING_PROPAGATION_POLICY,
  COLOR_GRADING_REGISTRY_VERSION,
  ColorGradingIntentSchema,
  ColorGradingPlanSchema,
  SCHEMA_VERSION,
} from "../src/schemas.js";
import type { ColorGradingIntent, ColorGradingOperation } from "../src/types.js";

const shadows: Extract<ColorGradingOperation, { kind: "wheel" }> = {
  kind: "wheel",
  variant: "shadows",
  mode: "absolute",
  hue: 218,
  saturation: 24,
  luminance: -8,
  confidence: 0.95,
  rationale: "cool the shadow range without legacy split toning",
};

const highlights: Extract<ColorGradingOperation, { kind: "wheel" }> = {
  kind: "wheel",
  variant: "highlights",
  mode: "absolute",
  hue: 42,
  saturation: 12,
  luminance: 6,
  confidence: 0.9,
  rationale: "warm the highlight range",
};

const blending: Extract<ColorGradingOperation, { kind: "shared"; control: "blending" }> = {
  kind: "shared",
  control: "blending",
  mode: "absolute",
  value: 55,
  confidence: 0.88,
  rationale: "keep the wheel transition controlled",
};

const balance: Extract<ColorGradingOperation, { kind: "shared"; control: "balance" }> = {
  kind: "shared",
  control: "balance",
  mode: "absolute",
  value: -12,
  confidence: 0.88,
  rationale: "favor the shadow color grade slightly",
};

function intent(operations: ColorGradingOperation[], processVersion = "13.0"): ColorGradingIntent {
  return {
    schema_version: SCHEMA_VERSION,
    color_grading_mode: "modern",
    process_version: processVersion,
    creative_goal: "modern Color Grading fixture",
    operations,
    overall_confidence: 0.95,
  };
}

function readback(operations: readonly unknown[], processVersion = "13.0") {
  return {
    schema_version: SCHEMA_VERSION,
    color_grading_registry_version: COLOR_GRADING_REGISTRY_VERSION,
    color_grading_mode: "modern" as const,
    process_version: processVersion,
    operations,
  };
}

function capableManifest(processVersion = "13.0") {
  return BackendCapabilityManifestSchema.parse({
    ...MOCK_CAPABILITIES,
    operations: {
      ...MOCK_CAPABILITIES.operations,
      apply_global_adjustment: {
        ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
        supported_color_grading_wheels: ["shadows", "midtones", "highlights", "global"],
        supported_color_grading_controls: ["blending", "balance"],
        supported_color_grading_process_versions: [processVersion],
        supported_settings: Object.values(COLOR_GRADING_BACKEND_SETTINGS).flat(),
      },
    },
  });
}

describe("T40 modern Color Grading planning", () => {
  it("translates wheels and shared controls with isolated modern settings", () => {
    const plan = translateColorGradingIntent(intent([shadows, highlights, blending, balance]));

    expect(plan.color_grading_mode).toBe("modern");
    expect(plan.process_version).toBe("13.0");
    expect(
      plan.operations.map((operation) =>
        operation.kind === "wheel" ? `wheel:${operation.variant}` : `shared:${operation.control}`,
      ),
    ).toEqual(["wheel:shadows", "wheel:highlights", "shared:blending", "shared:balance"]);
    expect(plan.propagation_policy).toEqual(COLOR_GRADING_PROPAGATION_POLICY);
    expect(resolveColorGradingSettings(plan)).toEqual({
      ColorGradeShadowHue: 218,
      ColorGradeShadowSat: 24,
      ColorGradeShadowLum: -8,
      ColorGradeHighlightHue: 42,
      ColorGradeHighlightSat: 12,
      ColorGradeHighlightLum: 6,
      ColorGradeBlending: 55,
      ColorGradeBalance: -12,
    });
  });

  it("rejects boundedness violations, duplicate identities, and legacy control mixing", () => {
    expect(() => ColorGradingIntentSchema.parse(intent([{ ...shadows, hue: 361 }]))).toThrow();
    expect(() => ColorGradingIntentSchema.parse(intent([shadows, shadows]))).toThrow(
      /may only appear once: wheel:shadows/,
    );
    expect(() =>
      ColorGradingIntentSchema.parse({
        ...intent([shadows]),
        color_grading_mode: "legacy_split_toning",
      }),
    ).toThrow();
    expect(() =>
      ColorGradingIntentSchema.parse(intent([{ ...blending, hue: 10 } as ColorGradingOperation])),
    ).toThrow();
  });

  it("derives deterministic readback and refuses process-version drift", () => {
    const plan = translateColorGradingIntent(intent([shadows, blending]));
    const current = readback([
      { kind: "wheel", variant: "global", hue: 0, saturation: 0, luminance: 0 },
      { kind: "shared", control: "balance", value: 0 },
    ]);
    const expected = resolveColorGradingReadback(current, plan);

    expect(
      expected.operations.map((operation) =>
        operation.kind === "wheel" ? `wheel:${operation.variant}` : `shared:${operation.control}`,
      ),
    ).toEqual(["wheel:shadows", "wheel:global", "shared:blending", "shared:balance"]);
    expect(assertColorGradingReadback(plan, expected)).toEqual(expected);
    expect(() => assertColorGradingReadback(plan, readback(expected.operations, "12.0"))).toThrow(
      /process or mode does not match/,
    );
    expect(() =>
      assertColorGradingReadback(plan, {
        ...expected,
        operations: expected.operations.map((operation) =>
          operation.kind === "wheel" && operation.variant === "shadows"
            ? { ...operation, hue: 10 }
            : operation,
        ),
      }),
    ).toThrow(/readback mismatch: wheel:shadows/);
  });

  it("keeps modern golden vectors isolated and detects duplicate vector ids", () => {
    const plan = translateColorGradingIntent(intent([shadows]));
    const firstVector = {
      id: "modern-shadow-wheel",
      control_group: "modern-wheel",
      intent: intent([shadows]),
      expected_plan: plan,
      current_readback: readback([]),
      expected_readback: readback([
        { kind: "wheel", variant: "shadows", hue: 218, saturation: 24, luminance: -8 },
      ]),
    };
    const vectors = runColorGradingGoldenVectors([
      firstVector,
      {
        id: "modern-shared-control",
        control_group: "modern-shared",
        intent: intent([blending]),
        expected_plan: translateColorGradingIntent(intent([blending])),
      },
    ]);

    expect(vectors.map(({ id, control_group }) => [id, control_group])).toEqual([
      ["modern-shadow-wheel", "modern-wheel"],
      ["modern-shared-control", "modern-shared"],
    ]);
    expect(() => runColorGradingGoldenVectors([firstVector, firstVector])).toThrow(
      /Duplicate modern Color Grading golden vector/,
    );
  });

  it("returns manual handoff for undeclared process, wheel, shared, and settings", () => {
    const plan = translateColorGradingIntent(intent([shadows, blending]));
    expect(() => assertBackendSupportsColorGradingPlan(MOCK_CAPABILITIES, plan)).toThrow(
      /process-version support/,
    );
    expect(assessColorGradingCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      manual_handoff_required: true,
      missing_process_versions: ["13.0"],
      missing_wheels: ["shadows"],
      missing_controls: ["blending"],
    });

    const onlyShadow = capableManifest();
    const incomplete = BackendCapabilityManifestSchema.parse({
      ...onlyShadow,
      operations: {
        ...onlyShadow.operations,
        apply_global_adjustment: {
          ...onlyShadow.operations.apply_global_adjustment,
          supported_color_grading_wheels: ["shadows"],
          supported_color_grading_controls: [],
          supported_settings: ["ColorGradeShadowHue", "ColorGradeShadowSat", "ColorGradeShadowLum"],
        },
      },
    });
    const mixedPlan = translateColorGradingIntent(intent([shadows, blending]));
    expect(() => assertBackendSupportsColorGradingPlan(incomplete, mixedPlan)).toThrow(
      /shared controls: blending/,
    );
    expect(assessColorGradingCapability(incomplete, mixedPlan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_controls: ["blending"],
      missing_settings: ["ColorGradeBlending"],
    });
    expect(() => assertBackendSupportsColorGradingPlan(onlyShadow, plan)).not.toThrow();
  });

  it("turns low-confidence modern intent into an explicit manual handoff", () => {
    const lowConfidence = { ...shadows, confidence: 0.64 };
    const plan = translateColorGradingIntent(intent([lowConfidence]));

    expect(plan.operations).toEqual([]);
    expect(plan.warnings).toEqual([
      "Skipped low-confidence wheel:shadows modern Color Grading operation (0.64)",
      "No executable modern Color Grading operation met the confidence threshold; manual handoff required",
    ]);
    expect(assessColorGradingCapability(capableManifest(), plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      manual_handoff_required: true,
    });
    expect(() =>
      ColorGradingPlanSchema.parse({ ...plan, color_grading_mode: "legacy_split_toning" }),
    ).toThrow();
  });
});
