import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  BackendCapabilityManifestSchema,
  SCHEMA_VERSION,
  TONE_CURVE_PROPAGATION_POLICY,
  TONE_CURVE_REGISTRY_VERSION,
  ToneCurveIntentSchema,
  ToneCurvePlanSchema,
} from "../src/schemas.js";
import {
  assertBackendSupportsToneCurvePlan,
  assertToneCurveReadback,
  assessToneCurveCapability,
  resolveToneCurveReadback,
  runToneCurveGoldenVectors,
  translateToneCurveIntent,
} from "../src/tone-curve.js";
import type { ToneCurveIntent, ToneCurveOperation } from "../src/types.js";

const redPoints = [
  { x: 0, y: 0 },
  { x: 0.5, y: 0.45 },
  { x: 1, y: 1 },
] as const;

const bluePoints = [
  { x: 0, y: 0.05 },
  { x: 1, y: 0.95 },
] as const;

function pointOperation(
  variant: "master" | "red" | "green" | "blue",
  points: readonly { x: number; y: number }[] = redPoints,
  confidence = 0.95,
): Extract<ToneCurveOperation, { kind: "points" }> {
  return {
    variant,
    kind: "points" as const,
    mode: "absolute" as const,
    points: [...points],
    confidence,
    rationale: `fixture ${variant} curve`,
  };
}

function parametricOperation(
  confidence = 0.95,
): Extract<ToneCurveOperation, { kind: "parametric" }> {
  return {
    variant: "parametric" as const,
    kind: "parametric" as const,
    mode: "absolute" as const,
    values: { highlights: 20, lights: 10, darks: -10, shadows: -20 },
    confidence,
    rationale: "fixture parametric curve",
  };
}

function intent(operations: ToneCurveOperation[]): ToneCurveIntent {
  return {
    schema_version: SCHEMA_VERSION,
    creative_goal: "structured tone curve fixture",
    operations,
    overall_confidence: 0.95,
  };
}

function readback(curves: readonly unknown[]) {
  return {
    schema_version: SCHEMA_VERSION,
    tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
    curves,
  };
}

describe("T32 structured tone-curve planning", () => {
  it("translates point and parametric variants with an explicit non-propagation policy", () => {
    const planned = translateToneCurveIntent(
      intent([
        pointOperation("red"),
        pointOperation("green", bluePoints),
        pointOperation("blue", redPoints),
      ]),
    );

    expect(planned.tone_curve_registry_version).toBe(TONE_CURVE_REGISTRY_VERSION);
    expect(planned.operations.map((operation) => operation.variant)).toEqual([
      "red",
      "green",
      "blue",
    ]);
    expect(planned.propagation_policy).toEqual(TONE_CURVE_PROPAGATION_POLICY);
    expect(translateToneCurveIntent(intent([parametricOperation()])).operations[0]?.kind).toBe(
      "parametric",
    );
  });

  it("rejects invalid point bounds, ordering, endpoints, and mutually exclusive modes", () => {
    expect(() =>
      ToneCurveIntentSchema.parse(
        intent([
          pointOperation("red", [
            { x: 0, y: 1.1 },
            { x: 1, y: 1 },
          ]),
        ]),
      ),
    ).toThrow();
    expect(() =>
      ToneCurveIntentSchema.parse(
        intent([
          pointOperation("red", [
            { x: 0.5, y: 0 },
            { x: 0.25, y: 1 },
          ]),
        ]),
      ),
    ).toThrow(/start at x=0|strictly increasing/);
    expect(() =>
      ToneCurveIntentSchema.parse(
        intent([
          pointOperation("red", [
            { x: 0, y: 0 },
            { x: 0.5, y: 1 },
          ]),
        ]),
      ),
    ).toThrow(/end at x=1/);
    expect(() =>
      ToneCurveIntentSchema.parse(intent([pointOperation("master"), pointOperation("red")])),
    ).toThrow(/master conflicts/);
    expect(() =>
      ToneCurvePlanSchema.parse({
        schema_version: SCHEMA_VERSION,
        tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
        operations: [pointOperation("red"), parametricOperation()],
        warnings: [],
        propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
      }),
    ).toThrow(/parametric mode conflicts/);
  });

  it("derives deterministic expected state and detects readback mismatch", () => {
    const plan = translateToneCurveIntent(intent([pointOperation("blue", bluePoints)]));
    const current = readback([
      { variant: "red", kind: "points", points: redPoints },
      { variant: "blue", kind: "points", points: redPoints },
    ]);
    const expected = resolveToneCurveReadback(current, plan);

    expect(expected.curves.map((curve) => curve.variant)).toEqual(["red", "blue"]);
    expect(assertToneCurveReadback(plan, expected)).toEqual(expected);
    expect(() =>
      assertToneCurveReadback(plan, {
        ...expected,
        curves: expected.curves.map((curve) =>
          curve.variant === "blue" && curve.kind === "points"
            ? {
                ...curve,
                points: [
                  { x: 0, y: 0 },
                  { x: 1, y: 0.1 },
                ],
              }
            : curve,
        ),
      }),
    ).toThrow(/readback mismatch: blue/);
  });

  it("keeps golden vectors isolated and verifies optional readback expectations", () => {
    const vectors = runToneCurveGoldenVectors([
      {
        id: "rgb-point-group",
        control_group: "rgb-point",
        intent: intent([pointOperation("red", bluePoints)]),
        expected_plan: {
          schema_version: SCHEMA_VERSION,
          tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
          operations: [pointOperation("red", bluePoints)],
          warnings: [],
          propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
        },
        current_readback: readback([{ variant: "red", kind: "points", points: redPoints }]),
        expected_readback: readback([{ variant: "red", kind: "points", points: bluePoints }]),
      },
      {
        id: "parametric-group",
        control_group: "parametric",
        intent: intent([parametricOperation()]),
        expected_plan: {
          schema_version: SCHEMA_VERSION,
          tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
          operations: [parametricOperation()],
          warnings: [],
          propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
        },
      },
    ]);

    expect(vectors.map(({ id, control_group }) => [id, control_group])).toEqual([
      ["rgb-point-group", "rgb-point"],
      ["parametric-group", "parametric"],
    ]);
    expect(() =>
      runToneCurveGoldenVectors([
        {
          id: "duplicate",
          control_group: "one",
          intent: intent([]),
          expected_plan: {
            schema_version: SCHEMA_VERSION,
            tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
            operations: [],
            warnings: [
              "No executable tone-curve operation met the confidence threshold; manual review required",
            ],
            propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
          },
        },
        {
          id: "duplicate",
          control_group: "two",
          intent: intent([]),
          expected_plan: {
            schema_version: SCHEMA_VERSION,
            tone_curve_registry_version: TONE_CURVE_REGISTRY_VERSION,
            operations: [],
            warnings: [
              "No executable tone-curve operation met the confidence threshold; manual review required",
            ],
            propagation_policy: TONE_CURVE_PROPAGATION_POLICY,
          },
        },
      ]),
    ).toThrow(/Duplicate tone-curve golden vector/);
  });

  it("returns review instead of applying when curve variants are undeclared", () => {
    const plan = translateToneCurveIntent(intent([pointOperation("red")]));
    expect(() => assertBackendSupportsToneCurvePlan(MOCK_CAPABILITIES, plan)).toThrow(
      /does not declare structured tone-curve variant support/,
    );
    expect(assessToneCurveCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_variants: ["red"],
    });

    const capableManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_curve_variants: ["red"],
        },
      },
    });
    expect(() => assertBackendSupportsToneCurvePlan(capableManifest, plan)).not.toThrow();
    expect(assessToneCurveCapability(capableManifest, plan)).toEqual({
      outcome: "READY",
      missing_variants: [],
    });
  });

  it("turns low-confidence curve intent into a reviewable no-op", () => {
    const plan = translateToneCurveIntent(intent([pointOperation("red", redPoints, 0.64)]));
    expect(plan.operations).toEqual([]);
    expect(plan.warnings).toEqual([
      "Skipped low-confidence red tone-curve operation (0.64)",
      "No executable tone-curve operation met the confidence threshold; manual review required",
    ]);
    expect(assessToneCurveCapability(MOCK_CAPABILITIES, plan)).toEqual({
      outcome: "READY",
      missing_variants: [],
    });
  });
});
