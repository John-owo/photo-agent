import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  OPTICS_BACKEND_SETTINGS,
  assertBackendSupportsOpticsPlan,
  assertOpticsReadback,
  assessOpticsCapability,
  resolveOpticsReadback,
  resolveOpticsSettings,
  runOpticsGoldenVectors,
  translateOpticsIntent,
} from "../src/optics-geometry.js";
import {
  BackendCapabilityManifestSchema,
  OPTICS_PROPAGATION_POLICY,
  OPTICS_REGISTRY_VERSION,
  OpticsIntentSchema,
  OpticsPlanSchema,
  SCHEMA_VERSION,
} from "../src/schemas.js";
import type { OpticsIntent, OpticsOperation } from "../src/types.js";

const lensCorrection: Extract<OpticsOperation, { kind: "lens_correction" }> = {
  kind: "lens_correction",
  mode: "absolute",
  profile_corrections: true,
  chromatic_aberration: true,
  confidence: 0.95,
  rationale: "fixture lens correction",
};

const profile: Extract<OpticsOperation, { kind: "profile" }> = {
  kind: "profile",
  mode: "absolute",
  profile_name: "Adobe Portrait",
  confidence: 0.9,
  rationale: "fixture camera profile",
};

const crop: Extract<OpticsOperation, { kind: "geometry" }> = {
  kind: "geometry",
  mode: "absolute",
  settings: { variant: "crop", left: 0.05, top: 0.1, right: 0.95, bottom: 0.9 },
  confidence: 0.9,
  rationale: "fixture crop",
};

const rotation: Extract<OpticsOperation, { kind: "geometry" }> = {
  kind: "geometry",
  mode: "absolute",
  settings: { variant: "rotation", angle: 2.5 },
  confidence: 0.9,
  rationale: "fixture rotation",
};

const perspective: Extract<OpticsOperation, { kind: "geometry" }> = {
  kind: "geometry",
  mode: "absolute",
  settings: { variant: "perspective", horizontal: -10, vertical: 15, scale: 1.05 },
  confidence: 0.9,
  rationale: "fixture perspective",
};

function intent(operations: OpticsOperation[]): OpticsIntent {
  return {
    schema_version: SCHEMA_VERSION,
    creative_goal: "context-safe optics fixture",
    operations,
    overall_confidence: 0.95,
  };
}

function readback(operations: readonly unknown[]) {
  return {
    schema_version: SCHEMA_VERSION,
    optics_registry_version: OPTICS_REGISTRY_VERSION,
    operations,
  };
}

describe("T36 context-safe optics and geometry planning", () => {
  it("keeps lens, profile, and geometry control groups distinct with bounded settings", () => {
    const plan = translateOpticsIntent(
      intent([lensCorrection, profile, crop, rotation, perspective]),
    );

    expect(plan.operations.map((operation) => operation.kind)).toEqual([
      "lens_correction",
      "profile",
      "geometry",
      "geometry",
      "geometry",
    ]);
    expect(plan.propagation_policy).toEqual(OPTICS_PROPAGATION_POLICY);
    expect(resolveOpticsSettings(plan)).toEqual({
      EnableProfileCorrections: true,
      RemoveChromaticAberration: true,
      CameraProfile: "Adobe Portrait",
      CropLeft: 0.05,
      CropTop: 0.1,
      CropRight: 0.95,
      CropBottom: 0.9,
      StraightenAngle: 2.5,
      PerspectiveHorizontal: -10,
      PerspectiveVertical: 15,
      PerspectiveScale: 1.05,
    });
  });

  it("rejects invalid geometry bounds and duplicate/conflicting requests", () => {
    expect(() =>
      OpticsIntentSchema.parse(
        intent([
          {
            ...crop,
            settings: { variant: "crop", left: 1, top: 0.1, right: 0.95, bottom: 0.9 },
          },
        ]),
      ),
    ).toThrow(/less than right/);
    expect(() =>
      OpticsIntentSchema.parse(
        intent([{ ...rotation, settings: { variant: "rotation", angle: 46 } }]),
      ),
    ).toThrow();
    expect(() =>
      OpticsIntentSchema.parse(
        intent([
          {
            ...perspective,
            settings: { variant: "perspective", horizontal: -10, vertical: 15, scale: 2.1 },
          },
        ]),
      ),
    ).toThrow();
    expect(() => OpticsIntentSchema.parse(intent([crop, crop]))).toThrow(
      /may only appear once: geometry:crop/,
    );
    expect(() =>
      OpticsPlanSchema.parse({
        schema_version: SCHEMA_VERSION,
        optics_registry_version: OPTICS_REGISTRY_VERSION,
        operations: [
          {
            ...profile,
            profile_name: "",
          },
        ],
        warnings: [],
        propagation_policy: OPTICS_PROPAGATION_POLICY,
      }),
    ).toThrow();
  });

  it("reconciles requested readback and reports only the affected identity", () => {
    const plan = translateOpticsIntent(intent([crop, profile]));
    const current = readback([
      {
        kind: "geometry",
        settings: { variant: "crop", left: 0, top: 0, right: 1, bottom: 1 },
      },
      { kind: "profile", profile_name: "Adobe Standard" },
    ]);
    const expected = resolveOpticsReadback(current, plan);

    expect(expected.operations.map((operation) => operation.kind)).toEqual(["geometry", "profile"]);
    expect(assertOpticsReadback(plan, expected)).toEqual(expected);
    expect(() =>
      assertOpticsReadback(plan, {
        ...expected,
        operations: expected.operations.map((operation) =>
          operation.kind === "profile"
            ? { ...operation, profile_name: "Wrong Profile" }
            : operation,
        ),
      }),
    ).toThrow(/readback mismatch: profile/);
  });

  it("runs isolated golden vectors for profile and geometry control groups", () => {
    const vectors = runOpticsGoldenVectors([
      {
        id: "profile-vector",
        control_group: "profile",
        intent: intent([profile]),
        expected_plan: {
          schema_version: SCHEMA_VERSION,
          optics_registry_version: OPTICS_REGISTRY_VERSION,
          operations: [profile],
          warnings: [],
          propagation_policy: OPTICS_PROPAGATION_POLICY,
        },
        current_readback: readback([{ kind: "profile", profile_name: "Adobe Standard" }]),
        expected_readback: readback([{ kind: "profile", profile_name: "Adobe Portrait" }]),
      },
      {
        id: "geometry-vector",
        control_group: "geometry",
        intent: intent([rotation]),
        expected_plan: {
          schema_version: SCHEMA_VERSION,
          optics_registry_version: OPTICS_REGISTRY_VERSION,
          operations: [rotation],
          warnings: [],
          propagation_policy: OPTICS_PROPAGATION_POLICY,
        },
      },
    ]);
    expect(vectors.map(({ id, control_group }) => [id, control_group])).toEqual([
      ["profile-vector", "profile"],
      ["geometry-vector", "geometry"],
    ]);
    const duplicateVector = {
      id: "duplicate",
      control_group: "profile",
      intent: intent([profile]),
      expected_plan: {
        schema_version: SCHEMA_VERSION,
        optics_registry_version: OPTICS_REGISTRY_VERSION,
        operations: [profile],
        warnings: [],
        propagation_policy: OPTICS_PROPAGATION_POLICY,
      },
    };
    expect(() => runOpticsGoldenVectors([duplicateVector, duplicateVector])).toThrow(
      /Duplicate optics golden vector/,
    );
  });

  it("refuses unavailable profiles and geometry before write prerequisites can be used", () => {
    const plan = translateOpticsIntent(intent([lensCorrection, profile, crop]));
    expect(() => assertBackendSupportsOpticsPlan(MOCK_CAPABILITIES, plan)).toThrow(
      /lens-correction control support/,
    );
    const refused = assessOpticsCapability(MOCK_CAPABILITIES, plan);
    expect(refused.outcome).toBe("REVIEW_REQUIRED");
    expect(refused.missing_capabilities).toEqual(
      expect.arrayContaining([
        "profile_corrections",
        "chromatic_aberration",
        "Adobe Portrait",
        "crop",
      ]),
    );
    expect(refused.missing_settings).toEqual(
      expect.arrayContaining([...OPTICS_BACKEND_SETTINGS.lens_correction]),
    );

    const capableManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_lens_controls: ["profile_corrections", "chromatic_aberration"],
          supported_profiles: ["Adobe Portrait"],
          supported_geometry_variants: ["crop"],
          supported_settings: [
            ...OPTICS_BACKEND_SETTINGS.lens_correction,
            ...OPTICS_BACKEND_SETTINGS.profile,
            ...OPTICS_BACKEND_SETTINGS.crop,
          ],
        },
      },
    });
    expect(() => assertBackendSupportsOpticsPlan(capableManifest, plan)).not.toThrow();
    expect(assessOpticsCapability(capableManifest, plan)).toEqual({
      outcome: "READY",
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_settings: [],
    });

    const missingRender = BackendCapabilityManifestSchema.parse({
      ...capableManifest,
      capabilities: capableManifest.capabilities.filter(
        (capability) => capability !== "render_preview",
      ),
      operations: Object.fromEntries(
        Object.entries(capableManifest.operations).filter(([name]) => name !== "render_preview"),
      ),
    });
    expect(() => assertBackendSupportsOpticsPlan(missingRender, plan)).toThrow(/render_preview/);
  });

  it("escalates low-confidence geometry to review and never enables propagation", () => {
    const plan = translateOpticsIntent(intent([{ ...rotation, confidence: 0.64 }]));
    expect(plan.operations).toEqual([]);
    expect(plan.propagation_policy.eligible).toBe(false);
    expect(assessOpticsCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_prerequisites: [],
    });
  });
});
