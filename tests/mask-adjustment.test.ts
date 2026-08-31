import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  applyMaskAdjustment,
  assertBackendSupportsMaskAdjustmentPlan,
  assertMaskAdjustmentReadback,
  assessMaskCapability,
  assessMaskReadback,
  resolveMaskSelector,
  runMaskGoldenVectors,
  summarizeExistingMasks,
  translateMaskAdjustmentIntent,
} from "../src/mask-adjustment.js";
import {
  BackendCapabilityManifestSchema,
  MASK_PROPAGATION_POLICY,
  MASK_REGISTRY_VERSION,
  MASK_PARAMETER_NAMES,
  MaskAdjustmentIntentSchema,
  MaskReadbackSchema,
  MaskSelectorSchema,
  SCHEMA_VERSION,
} from "../src/schemas.js";
import type { MaskAdjustmentIntent, MaskReadback, MaskSelector } from "../src/types.js";

const master = {
  catalog_id: "catalog-1",
  uuid: "master-uuid",
  master_id: "master-id",
  master_uuid: "master-uuid",
  is_virtual_copy: false,
} as const;

const copy = {
  catalog_id: "catalog-1",
  uuid: "copy-uuid",
  master_id: "master-id",
  master_uuid: "master-uuid",
  is_virtual_copy: true,
} as const;

const gradient = {
  mask_id: "mask-gradient",
  name: "Sky",
  kind: "linear_gradient",
  enabled: true,
  supported_parameters: ["exposure", "temperature", "sharpness"],
  parameters: { exposure: 0, temperature: 0 },
  geometry: {
    type: "linear",
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
  },
  opaque: { component_ids: ["component-1"], blend_mode: "normal", future_field: { keep: true } },
};

const brush = {
  mask_id: "mask-brush",
  name: "Subject",
  kind: "brush",
  enabled: false,
  supported_parameters: ["exposure", "saturation"],
  parameters: { exposure: -0.5, saturation: 4 },
  geometry: {
    strokes: [
      {
        id: "stroke-1",
        points: [
          [0.1, 0.2],
          [0.2, 0.3],
        ],
      },
    ],
  },
  opaque: { component_ids: ["component-2"], ai_payload: { preserve: "exactly" } },
};

function readback(
  masks: readonly unknown[] = [gradient, brush],
  globalSettings: Record<string, number | string | boolean> = { Exposure2012: 0.7 },
): MaskReadback {
  return {
    schema_version: SCHEMA_VERSION,
    mask_registry_version: MASK_REGISTRY_VERSION,
    mask_schema_version: "lightroom-classic-mask-v1",
    target: copy,
    masks,
    global_settings: globalSettings,
  } as MaskReadback;
}

function intent(
  selector: MaskSelector = { kind: "id", mask_id: "mask-gradient" },
  settings: Record<string, number> = { exposure: 1.25, temperature: 8 },
  operationId = "mask-operation-001",
): MaskAdjustmentIntent {
  return {
    schema_version: SCHEMA_VERSION,
    operation_id: operationId,
    mask_schema_version: "lightroom-classic-mask-v1",
    master,
    target: copy,
    expected_master_uuid: master.uuid,
    selector,
    settings,
  } as MaskAdjustmentIntent;
}

function capableManifest() {
  return BackendCapabilityManifestSchema.parse({
    ...MOCK_CAPABILITIES,
    capabilities: [...MOCK_CAPABILITIES.capabilities, "adjust_existing_mask"],
    operations: {
      ...MOCK_CAPABILITIES.operations,
      adjust_existing_mask: {
        supported: true,
        side_effect: "mutating",
        idempotent: false,
        reversible: "checkpoint_only",
        scope: "photo",
        requires_active_selection: false,
        requires_editor_foreground: false,
        concurrency: "exclusive_backend",
        retry_policy: "readback_before_retry",
        safe_to_resume: false,
        supported_mask_schema_versions: ["lightroom-classic-mask-v1"],
        supported_mask_parameters: [...MASK_PARAMETER_NAMES],
      },
    },
  });
}

describe("T42 existing-mask adjustment planning", () => {
  it("summarizes masks and resolves stable ids or unique names only", () => {
    const current = readback();
    expect(summarizeExistingMasks(current)).toEqual([
      {
        mask_id: "mask-gradient",
        name: "Sky",
        kind: "linear_gradient",
        enabled: true,
        supported_parameters: ["exposure", "temperature", "sharpness"],
        parameters: { exposure: 0, temperature: 0 },
      },
      {
        mask_id: "mask-brush",
        name: "Subject",
        kind: "brush",
        enabled: false,
        supported_parameters: ["exposure", "saturation"],
        parameters: { exposure: -0.5, saturation: 4 },
      },
    ]);
    expect(resolveMaskSelector(current, { kind: "id", mask_id: "mask-gradient" })).toMatchObject({
      mask_id: "mask-gradient",
      geometry: expect.any(Object),
    });
    expect(resolveMaskSelector(current, { kind: "name", name: "Subject" }).mask_id).toBe(
      "mask-brush",
    );

    const duplicateName = readback([gradient, { ...brush, mask_id: "mask-brush-2", name: "Sky" }]);
    expect(() => resolveMaskSelector(duplicateName, { kind: "name", name: "Sky" })).toThrow(
      /ambiguous: Sky; candidates: mask-gradient, mask-brush-2/,
    );
    expect(() => MaskSelectorSchema.parse({ kind: "index", index: 0 })).toThrow();
  });

  it("validates bounds, allowlists, identity, duplicate ids, and Workflow Copy boundary", () => {
    expect(() =>
      MaskAdjustmentIntentSchema.parse(intent({ kind: "id", mask_id: "mask-gradient" }, {})),
    ).toThrow(/at least one parameter/);
    expect(() =>
      MaskAdjustmentIntentSchema.parse(
        intent({ kind: "id", mask_id: "mask-gradient" }, { exposure: 5.1 }),
      ),
    ).toThrow(/between -5 and 5/);
    expect(() =>
      MaskAdjustmentIntentSchema.parse(
        intent({ kind: "id", mask_id: "mask-gradient" }, { unknown_local_key: 1 }),
      ),
    ).toThrow(/Unsupported existing-mask parameter/);
    expect(() =>
      MaskAdjustmentIntentSchema.parse({
        ...intent(),
        target: { ...copy, is_virtual_copy: false },
      }),
    ).toThrow(/Workflow Copy/);
    expect(() =>
      MaskAdjustmentIntentSchema.parse({ ...intent(), expected_master_uuid: "wrong-master" }),
    ).toThrow(/match the Master identity/);
    expect(() =>
      MaskReadbackSchema.parse(readback([{ ...gradient, mask_id: "mask-brush" }, brush])),
    ).toThrow(/duplicate mask_id/);
    expect(() =>
      MaskReadbackSchema.parse(
        readback([
          {
            ...gradient,
            supported_parameters: ["exposure", "temperature"],
            parameters: { ...gradient.parameters, sharpness: 2 },
          },
          brush,
        ]),
      ),
    ).toThrow(/not declared as supported/);
  });

  it("translates and applies one allowlisted local operation while preserving everything else", () => {
    const plan = translateMaskAdjustmentIntent(intent());
    const current = readback();
    const after = applyMaskAdjustment(current, plan);

    expect(plan.mask_registry_version).toBe(MASK_REGISTRY_VERSION);
    expect(plan.propagation_policy).toEqual(MASK_PROPAGATION_POLICY);
    expect(after.target).toEqual(copy);
    expect(after.global_settings).toEqual(current.global_settings);
    expect(after.masks[0]?.parameters).toEqual({ exposure: 1.25, temperature: 8 });
    expect(after.masks[0]?.geometry).toEqual(current.masks[0]?.geometry);
    expect(after.masks[0]?.opaque).toEqual(current.masks[0]?.opaque);
    expect(after.masks[1]).toEqual(current.masks[1]);
    expect(current.masks[0]?.parameters).toEqual({ exposure: 0, temperature: 0 });
    expect(assertMaskAdjustmentReadback(plan, current, after)).toEqual(after);
  });

  it("rejects unsupported selected parameters and detects preservation or readback drift", () => {
    const plan = translateMaskAdjustmentIntent(
      intent({ kind: "id", mask_id: "mask-brush" }, { temperature: 8 }),
    );
    expect(() => applyMaskAdjustment(readback(), plan)).toThrow(/does not support parameters/);

    const safePlan = translateMaskAdjustmentIntent(intent());
    const current = readback();
    const after = applyMaskAdjustment(current, safePlan);
    const geometryDrift = {
      ...after,
      masks: after.masks.map((mask) =>
        mask.mask_id === "mask-gradient"
          ? { ...mask, geometry: { ...(mask.geometry as object), changed: true } }
          : mask,
      ),
    };
    expect(() => assertMaskAdjustmentReadback(safePlan, current, geometryDrift)).toThrow(
      /preservation mismatch: mask-gradient/,
    );

    const globalDrift = { ...after, global_settings: { Exposure2012: 0.8 } };
    const assessed = assessMaskReadback(safePlan, current, globalDrift);
    expect(assessed).toMatchObject({
      operation_id: "mask-operation-001",
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
    });
  });

  it("requires complete declared mask capability and returns explicit manual handoff", () => {
    const plan = translateMaskAdjustmentIntent(intent());
    expect(() => assertBackendSupportsMaskAdjustmentPlan(MOCK_CAPABILITIES, plan)).toThrow(
      /adjust_existing_mask/,
    );
    expect(assessMaskCapability(MOCK_CAPABILITIES, plan)).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      manual_handoff_required: true,
      missing_capabilities: [
        "adjust_existing_mask",
        "existing_mask_schema_versions",
        "existing_mask_parameters",
      ],
      missing_schema_versions: ["lightroom-classic-mask-v1"],
      missing_parameters: ["exposure", "temperature"],
    });

    expect(() => assertBackendSupportsMaskAdjustmentPlan(capableManifest(), plan)).not.toThrow();
    expect(assessMaskCapability(capableManifest(), plan)).toMatchObject({
      outcome: "READY",
      manual_handoff_required: false,
      missing_prerequisites: [],
      missing_capabilities: [],
      missing_schema_versions: [],
      missing_parameters: [],
    });
  });

  it("keeps preservation golden vectors isolated and rejects duplicate ids", () => {
    const plan = translateMaskAdjustmentIntent(intent());
    const current = readback();
    const expected = applyMaskAdjustment(current, plan);
    const vector = {
      id: "mask-parameter-preservation",
      control_group: "existing-mask-local-tone",
      intent: intent(),
      expected_plan: plan,
      current_readback: current,
      expected_readback: expected,
    };
    const results = runMaskGoldenVectors([vector]);
    expect(results[0]?.readback).toEqual(expected);
    expect(() => runMaskGoldenVectors([vector, vector])).toThrow(
      /Duplicate existing-mask golden vector/,
    );
  });
});
