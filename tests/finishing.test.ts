import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  FINISHING_BACKEND_SETTINGS,
  assertBackendSupportsFinishingPlan,
  assertFinishingReadback,
  assessFinishingCapability,
  resolveFinishingReadback,
  resolveFinishingSettings,
  runFinishingGoldenVectors,
  translateFinishingIntent,
} from "../src/finishing.js";
import {
  BackendCapabilityManifestSchema,
  FINISHING_PROPAGATION_POLICY,
  FINISHING_REGISTRY_VERSION,
  FinishingIntentSchema,
  FinishingPlanSchema,
  SCHEMA_VERSION,
} from "../src/schemas.js";
import type { FinishingIntent, FinishingOperation } from "../src/types.js";

const vignette: Extract<FinishingOperation, { kind: "vignette" }> = {
  kind: "vignette",
  mode: "absolute",
  amount: -25,
  midpoint: 50,
  roundness: 0,
  feather: 70,
  confidence: 0.95,
  rationale: "fixture vignette",
};

const grain: Extract<FinishingOperation, { kind: "grain" }> = {
  kind: "grain",
  mode: "absolute",
  amount: 20,
  size: 25,
  roughness: 60,
  confidence: 0.9,
  rationale: "fixture grain",
};

const crop: Extract<FinishingOperation, { kind: "framing" }> = {
  kind: "framing",
  mode: "absolute",
  settings: { variant: "crop", left: 0.05, top: 0.1, right: 0.95, bottom: 0.9 },
  confidence: 0.9,
  rationale: "fixture crop",
};

const rotation: Extract<FinishingOperation, { kind: "framing" }> = {
  kind: "framing",
  mode: "absolute",
  settings: { variant: "rotation", angle: 2 },
  confidence: 0.9,
  rationale: "fixture rotation",
};

function intent(operations: FinishingOperation[]): FinishingIntent {
  return {
    schema_version: SCHEMA_VERSION,
    creative_goal: "finishing fixture",
    operations,
    overall_confidence: 0.95,
  };
}

function readback(operations: readonly unknown[]) {
  return {
    schema_version: SCHEMA_VERSION,
    finishing_registry_version: FINISHING_REGISTRY_VERSION,
    operations,
  };
}

describe("T38 finishing and framing planning", () => {
  it("translates bounded vignette/grain and preserves separate framing geometry", () => {
    const plan = translateFinishingIntent(intent([vignette, grain, crop, rotation]));

    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "vignette",
      "grain",
      "framing",
      "framing",
    ]);
    expect(plan.human_review_required).toBe(true);
    expect(plan.propagation_policy).toEqual(FINISHING_PROPAGATION_POLICY);
    expect(resolveFinishingSettings(translateFinishingIntent(intent([vignette, grain])))).toEqual({
      PostCropVignetteAmount: -25,
      PostCropVignetteMidpoint: 50,
      PostCropVignetteRoundness: 0,
      PostCropVignetteFeather: 70,
      GrainAmount: 20,
      GrainSize: 25,
      GrainRoughness: 60,
    });
  });

  it("rejects bounds, duplicate framing variants, and inconsistent human-review flags", () => {
    expect(() => FinishingIntentSchema.parse(intent([{ ...vignette, amount: 101 }]))).toThrow();
    expect(() =>
      FinishingIntentSchema.parse(
        intent([
          { ...crop, settings: { variant: "crop", left: 0.9, top: 0, right: 0.8, bottom: 1 } },
        ]),
      ),
    ).toThrow(/less than right/);
    expect(() => FinishingIntentSchema.parse(intent([crop, crop]))).toThrow(
      /may only appear once: framing:crop/,
    );
    const cropPlan = translateFinishingIntent(intent([crop]));
    expect(() => FinishingPlanSchema.parse({ ...cropPlan, human_review_required: false })).toThrow(
      /require explicit per-photo human review/,
    );
    expect(() =>
      FinishingIntentSchema.parse(
        intent([{ ...rotation, settings: { variant: "rotation", angle: 46 } }]),
      ),
    ).toThrow();
  });

  it("reconciles readback and verifies isolated golden vectors", () => {
    const plan = translateFinishingIntent(intent([vignette, grain]));
    const current = readback([
      { kind: "vignette", amount: 0, midpoint: 50, roundness: 0, feather: 50 },
    ]);
    const expected = resolveFinishingReadback(current, plan);
    expect(assertFinishingReadback(plan, expected)).toEqual(expected);
    expect(() =>
      assertFinishingReadback(plan, {
        ...expected,
        operations: expected.operations.map((operation) =>
          operation.kind === "grain" ? { ...operation, amount: 99 } : operation,
        ),
      }),
    ).toThrow(/readback mismatch: grain/);

    const vectors = runFinishingGoldenVectors([
      {
        id: "vignette-vector",
        control_group: "vignette",
        intent: intent([vignette]),
        expected_plan: {
          schema_version: SCHEMA_VERSION,
          finishing_registry_version: FINISHING_REGISTRY_VERSION,
          operations: [vignette],
          warnings: [],
          human_review_required: false,
          propagation_policy: FINISHING_PROPAGATION_POLICY,
        },
        current_readback: readback([
          { kind: "vignette", amount: 0, midpoint: 50, roundness: 0, feather: 50 },
        ]),
        expected_readback: readback([
          { kind: "vignette", amount: -25, midpoint: 50, roundness: 0, feather: 70 },
        ]),
      },
    ]);
    expect(vectors[0]?.settings).toEqual({
      PostCropVignetteAmount: -25,
      PostCropVignetteMidpoint: 50,
      PostCropVignetteRoundness: 0,
      PostCropVignetteFeather: 70,
    });
    const duplicate = {
      id: "duplicate",
      control_group: "one",
      intent: intent([vignette]),
      expected_plan: {
        schema_version: SCHEMA_VERSION,
        finishing_registry_version: FINISHING_REGISTRY_VERSION,
        operations: [vignette],
        warnings: [],
        human_review_required: false,
        propagation_policy: FINISHING_PROPAGATION_POLICY,
      },
    };
    expect(() => runFinishingGoldenVectors([duplicate, duplicate])).toThrow(
      /Duplicate finishing golden vector/,
    );
  });

  it("requires declared finishing capabilities and keeps crop/rotation in review", () => {
    const safePlan = translateFinishingIntent(intent([vignette, grain]));
    expect(() => assertBackendSupportsFinishingPlan(MOCK_CAPABILITIES, safePlan)).toThrow(
      /does not declare finishing-control support/,
    );
    const refused = assessFinishingCapability(MOCK_CAPABILITIES, safePlan);
    expect(refused.outcome).toBe("REVIEW_REQUIRED");
    expect(refused.missing_capabilities).toEqual(expect.arrayContaining(["vignette", "grain"]));
    expect(refused.missing_settings).toEqual(
      expect.arrayContaining([...FINISHING_BACKEND_SETTINGS.vignette]),
    );

    const capableManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_finishing_controls: ["vignette", "grain"],
          supported_settings: [
            ...FINISHING_BACKEND_SETTINGS.vignette,
            ...FINISHING_BACKEND_SETTINGS.grain,
          ],
        },
      },
    });
    expect(() => assertBackendSupportsFinishingPlan(capableManifest, safePlan)).not.toThrow();
    expect(assessFinishingCapability(capableManifest, safePlan)).toEqual({
      outcome: "READY",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
    });

    const framingPlan = translateFinishingIntent(intent([crop, rotation]));
    expect(() => assertBackendSupportsFinishingPlan(capableManifest, framingPlan)).toThrow(
      /explicit per-photo human review/,
    );
    expect(assessFinishingCapability(capableManifest, framingPlan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_capabilities: ["explicit_per_photo_human_review"],
    });
  });

  it("escalates low-confidence finishing intent and never enables propagation", () => {
    const plan = translateFinishingIntent(intent([{ ...vignette, confidence: 0.64 }]));
    expect(plan.operations).toEqual([]);
    expect(plan.propagation_policy.eligible).toBe(false);
    expect(assessFinishingCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: [],
    });
  });
});
