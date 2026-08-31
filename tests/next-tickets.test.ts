import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES, MockBackend } from "../src/backends.js";
import { exportFinal } from "../src/delivery.js";
import { AcceptingMockEvaluator, ScriptedEvaluator } from "../src/evaluation.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { MockProvider } from "../src/providers.js";
import {
  assertBackendSupportsPlan,
  BASELINE_PARAMETER_REGISTRY_VERSION,
  COLOR_MIXER_CHANNELS,
  COLOR_MIXER_COMPONENTS,
  COLOR_MIXER_PARAMETERS,
  LEGACY_PARAMETER_REGISTRY_VERSION,
  PARAMETER_REGISTRY,
  migrateNormalizedPlan,
  PARAMETER_REGISTRY_VERSION,
  registeredParameters,
  serializeParameterRegistry,
  selectPropagatableOperations,
  validateNormalizedPlan,
} from "../src/parameter-registry.js";
import {
  BackendCapabilityManifestSchema,
  ParameterRegistrySnapshotSchema,
  StoredNormalizedEditPlanSchema,
} from "../src/schemas.js";
import { resolveLightroomSettings, runTranslatorGoldenVectors } from "../src/translator.js";
import type { EvaluationResult } from "../src/types.js";
import { runSinglePhoto } from "../src/workflow.js";

async function fixturePair(): Promise<{ root: string; raw: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-next-tickets-"));
  const raw = join(root, "sample.NEF");
  const preview = join(root, "sample.JPG");
  await writeFile(raw, "synthetic raw fixture", "utf8");
  await writeFixtureJpeg(preview);
  return { root, raw, preview };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const refinement: EvaluationResult = {
  schema_version: "0.2.0",
  verdict: "refine",
  confidence: 0.9,
  rationale: "One deterministic refinement is justified",
  issues: ["Exposure needs a small correction"],
  refinement_plan: {
    schema_version: "0.1.0",
    operations: [
      {
        parameter: "exposure_ev",
        mode: "delta",
        value: -0.2,
        confidence: 0.9,
        rationale: "Fixture refinement",
      },
    ],
    warnings: [],
  },
};

describe("T11 evaluated iteration evidence", () => {
  it("links an accepted evaluation to exact plan, readback, and render artifacts", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new AcceptingMockEvaluator(),
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("ACCEPTED");
    const evaluationPath = join(result.sessionDir, "evaluations", "iteration-1.json");
    const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
      operation_id: string;
      evidence: {
        render: { path: string; sha256: string };
        preview: { path: string; sha256: string };
        backend_render: { path: string; sha256: string };
        plan: { path: string; sha256: string };
        readback: { path: string; sha256: string };
      };
    };
    expect(evaluation.operation_id).toMatch(/^photoagent-iteration-/);
    for (const link of Object.values(evaluation.evidence)) {
      expect(link.sha256).toBe(await sha256(join(result.sessionDir, link.path)));
    }
    expect(evaluation.evidence.render.path).toBe("renders/iteration-1/preview.jpg");
    expect(evaluation.evidence.plan.path).toBe("plans/iteration-1.json");
    expect(evaluation.evidence.readback.path).toBe("backend-readback-iteration-1.json");

    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      terminal_state: string;
      iteration_records: Array<{
        state: string;
        evaluation?: { verdict: string; rationale: string };
      }>;
    };
    expect(report.terminal_state).toBe("ACCEPTED");
    expect(report.iteration_records).toHaveLength(1);
    expect(report.iteration_records[0]).toMatchObject({
      state: "ACCEPTED",
      evaluation: { verdict: "accept", rationale: expect.any(String) },
    });
  });

  it("records both sides of a refine-then-accept loop", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([
        refinement,
        {
          schema_version: "0.2.0",
          verdict: "accept",
          confidence: 0.9,
          rationale: "Refinement accepted",
          issues: [],
        },
      ]),
      maxIterations: 3,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("ACCEPTED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { iteration_records: Array<{ state: string; plan: { sha256: string } }> };
    expect(report.iteration_records.map((record) => record.state)).toEqual([
      "REFINING",
      "ACCEPTED",
    ]);
    expect(report.iteration_records[0]?.plan.sha256).not.toBe(
      report.iteration_records[1]?.plan.sha256,
    );
    await expect(
      access(join(result.sessionDir, "evaluations", "iteration-2.json")),
    ).resolves.toBeUndefined();
  });

  it("fails closed and records an evaluator failure", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: {
        name: "failing-fixture",
        requiresCloudPreview: false,
        evaluate: async () => {
          throw new Error("evaluator unavailable");
        },
      },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { reason: string; iteration_records: Array<{ state: string; error?: string }> };
    expect(report.reason).toBe("controller_error");
    expect(report.iteration_records[0]).toMatchObject({
      state: "REVIEW_REQUIRED",
      error: "evaluator unavailable",
    });
    expect(await readFile(join(result.sessionDir, "state.json"), "utf8")).toContain(
      "REVIEW_REQUIRED",
    );
  });
});

describe("T13 preview and final-export seam", () => {
  it("writes a session-only preview policy and deterministic sanitized artifact", async () => {
    const { root, raw, preview } = await fixturePair();
    const evaluator = {
      name: "path-fixture",
      requiresCloudPreview: false,
      evaluate: async (input: { renderPath: string }) => {
        expect(input.renderPath).toMatch(/renders[\\/]iteration-1[\\/]preview\.jpg$/);
        return {
          schema_version: "0.2.0" as const,
          verdict: "accept" as const,
          confidence: 0.9,
          rationale: "preview path is session scoped",
          issues: [],
        };
      },
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    const policy = JSON.parse(
      await readFile(join(result.sessionDir, "preview-policy.json"), "utf8"),
    ) as { preview: Record<string, unknown>; final_export: Record<string, unknown> };
    expect(policy.preview).toMatchObject({
      naming: "renders/iteration-{n}/preview.jpg",
      retention: "session",
      sanitized: true,
    });
    expect(policy.final_export).toMatchObject({
      availability: "explicit_only",
      requires_explicit_destination: true,
      requires_delivery_settings: true,
      preview_is_not_final: true,
    });
    const render = JSON.parse(
      await readFile(join(result.sessionDir, "render-iteration-1.json"), "utf8"),
    ) as { preview: { path: string; delivery_export: boolean } };
    expect(render.preview).toMatchObject({
      path: "renders/iteration-1/preview.jpg",
      delivery_export: false,
    });
  });

  it("requires an explicit destination and delivery settings for final export", async () => {
    const { root, raw } = await fixturePair();
    const backend = new MockBackend(raw);
    await backend.connect();
    await backend.handshake();
    const settings = {
      format: "jpeg" as const,
      quality: 90,
      width: 4000,
      height: 3000,
      filename: "sample-final.jpg",
    };
    await expect(exportFinal({ backend, photoId: raw, destination: "", settings })).rejects.toThrow(
      "explicit destination",
    );
    await expect(
      exportFinal({
        backend,
        photoId: raw,
        destination: join(root, "session", "renders"),
        sessionDir: join(root, "session"),
        settings,
      }),
    ).rejects.toThrow("session preview directory");
    await expect(
      exportFinal({
        backend,
        photoId: raw,
        destination: join(root, "delivery"),
        settings: { ...settings, filename: "../escape.jpg" },
      }),
    ).rejects.toThrow("single file name");
    const exported = await exportFinal({
      backend,
      photoId: raw,
      destination: join(root, "delivery"),
      settings,
    });
    expect(exported.path).toMatch(/sample-final\.jpg$/);
    await backend.close();
  });
});

describe("T16 baseline Parameter Registry", () => {
  it("covers every normalized baseline parameter with units and policy", () => {
    expect(Object.keys(PARAMETER_REGISTRY).sort()).toEqual([...registeredParameters()].sort());
    expect(PARAMETER_REGISTRY_VERSION).toBe("0.3.0");
    for (const definition of Object.values(PARAMETER_REGISTRY)) {
      expect(definition.unit).toBeTruthy();
      expect(definition.absolute_range[0]).toBeLessThan(definition.absolute_range[1]);
      expect(definition.delta_range[0]).toBeLessThan(definition.delta_range[1]);
      expect(definition.propagation.required_conditions).toBeDefined();
    }
    expect(PARAMETER_REGISTRY.temperature_k.propagation.eligible).toBe(false);
    expect(PARAMETER_REGISTRY.exposure_ev.propagation.eligible).toBe(true);
  });

  it("rejects out-of-range and conflicting operations before resolution", () => {
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        operations: [
          {
            parameter: "exposure_ev",
            mode: "delta",
            value: 6,
            confidence: 0.9,
            rationale: "too large",
          },
        ],
        warnings: [],
      }),
    ).toThrow(/outside/);
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        operations: [
          {
            parameter: "contrast",
            mode: "delta",
            value: 4,
            confidence: 0.9,
            rationale: "first",
          },
          {
            parameter: "contrast",
            mode: "absolute",
            value: 4,
            confidence: 0.9,
            rationale: "conflict",
          },
        ],
        warnings: [],
      }),
    ).toThrow(/Conflicting operations/);
  });

  it("preserves absolute and delta translator semantics while filtering propagation", () => {
    expect(
      resolveLightroomSettings(
        { Exposure2012: 0, Temperature: 5200, Tint: 0 },
        {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "exposure_ev",
              mode: "absolute",
              value: 1.25,
              confidence: 0.9,
              rationale: "absolute fixture",
            },
            {
              parameter: "temperature_k",
              mode: "delta",
              value: 250,
              confidence: 0.9,
              rationale: "white balance fixture",
            },
          ],
          warnings: [],
        },
      ),
    ).toEqual({ Exposure2012: 1.25, Temperature: 5450, Tint: 0, WhiteBalance: "Custom" });
    expect(
      selectPropagatableOperations(
        {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "exposure_ev",
              mode: "delta",
              value: 0.2,
              confidence: 0.9,
              rationale: "propagate",
            },
            {
              parameter: "temperature_k",
              mode: "delta",
              value: 250,
              confidence: 0.9,
              rationale: "context sensitive",
            },
            {
              parameter: "contrast",
              mode: "delta",
              value: 8,
              confidence: 0.4,
              rationale: "low confidence",
            },
          ],
          warnings: [],
        },
        ["exposure_ev", "temperature_k", "contrast"],
      ).map((operation) => operation.parameter),
    ).toEqual(["exposure_ev"]);
    expect(() =>
      validateNormalizedPlan({
        schema_version: "0.1.0",
        parameter_registry_version: "9.9.9",
        operations: [],
        warnings: [],
      }),
    ).toThrow(/Unsupported parameter registry version/);
  });

  it("requires the complete custom-white-balance capability before mutation", () => {
    const temperatureOnlyPlan = {
      schema_version: "0.1.0" as const,
      operations: [
        {
          parameter: "temperature_k" as const,
          mode: "delta" as const,
          value: -250,
          confidence: 0.9,
          rationale: "white balance fixture",
        },
      ],
      warnings: [],
    };
    const tintOnlyPlan = {
      schema_version: "0.1.0" as const,
      operations: [
        {
          parameter: "tint" as const,
          mode: "delta" as const,
          value: 5,
          confidence: 0.9,
          rationale: "white balance fixture",
        },
      ],
      warnings: [],
    };
    const partialManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_settings: ["Temperature"],
        },
      },
    });
    const completeManifest = BackendCapabilityManifestSchema.parse({
      ...partialManifest,
      operations: {
        ...partialManifest.operations,
        apply_global_adjustment: {
          ...partialManifest.operations.apply_global_adjustment,
          supported_settings: ["Temperature", "Tint", "WhiteBalance"],
        },
      },
    });
    const tintOnlyManifest = BackendCapabilityManifestSchema.parse({
      ...partialManifest,
      operations: {
        ...partialManifest.operations,
        apply_global_adjustment: {
          ...partialManifest.operations.apply_global_adjustment,
          supported_settings: ["Tint"],
        },
      },
    });

    expect(() => assertBackendSupportsPlan(partialManifest, temperatureOnlyPlan)).toThrow(
      /Tint, WhiteBalance/,
    );
    expect(() => assertBackendSupportsPlan(tintOnlyManifest, tintOnlyPlan)).toThrow(
      /Temperature, WhiteBalance/,
    );
    expect(() => assertBackendSupportsPlan(completeManifest, temperatureOnlyPlan)).not.toThrow();
    expect(() => assertBackendSupportsPlan(completeManifest, tintOnlyPlan)).not.toThrow();
  });
});

describe("T28 versioned Parameter Registry", () => {
  it("round-trips the complete registry snapshot without dropping policy fields", () => {
    const snapshot = serializeParameterRegistry();
    const roundTripped = ParameterRegistrySnapshotSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );
    expect(roundTripped).toEqual(snapshot);
    expect(Object.keys(roundTripped.definitions).sort()).toEqual(
      [...registeredParameters()].sort(),
    );
    for (const parameter of registeredParameters()) {
      expect(roundTripped.definitions[parameter]).toEqual(PARAMETER_REGISTRY[parameter]);
    }
  });

  it("migrates unversioned and 0.1.0 plans to a self-describing current plan", () => {
    const legacy = {
      schema_version: "0.1.0" as const,
      parameter_registry_version: LEGACY_PARAMETER_REGISTRY_VERSION,
      operations: [
        {
          parameter: "exposure_ev" as const,
          mode: "delta" as const,
          value: 0.2,
          confidence: 0.9,
          rationale: "legacy fixture",
        },
      ],
      warnings: [],
    };
    const migrated = migrateNormalizedPlan(legacy);
    expect(migrated.parameter_registry_version).toBe(PARAMETER_REGISTRY_VERSION);
    expect(migrated.parameter_registry_migration).toEqual({
      from_version: LEGACY_PARAMETER_REGISTRY_VERSION,
      to_version: PARAMETER_REGISTRY_VERSION,
      strategy: "baseline-0.1.0-via-0.2.0-to-0.3.0",
    });
    expect(migrated.parameter_registry_snapshot).toEqual(serializeParameterRegistry());
    expect(StoredNormalizedEditPlanSchema.parse(JSON.parse(JSON.stringify(migrated)))).toEqual(
      migrated,
    );

    const unversioned = migrateNormalizedPlan({
      ...legacy,
      parameter_registry_version: undefined,
    });
    expect(unversioned.parameter_registry_version).toBe(PARAMETER_REGISTRY_VERSION);
    expect(unversioned.parameter_registry_migration?.from_version).toBe(
      LEGACY_PARAMETER_REGISTRY_VERSION,
    );

    const currentSnapshot = serializeParameterRegistry();
    const t28Snapshot = {
      version: BASELINE_PARAMETER_REGISTRY_VERSION,
      definitions: Object.fromEntries(
        Object.entries(currentSnapshot.definitions)
          .filter(
            ([parameter]) =>
              !parameter.startsWith("hue_") &&
              !parameter.startsWith("saturation_") &&
              !parameter.startsWith("luminance_"),
          )
          .map(([parameter, definition]) => {
            const baselineDefinition = Object.fromEntries(
              Object.entries(definition).filter(([key]) => key !== "control_group"),
            );
            return [parameter, baselineDefinition];
          }),
      ),
    };
    const migratedFromT28 = migrateNormalizedPlan({
      ...legacy,
      parameter_registry_version: BASELINE_PARAMETER_REGISTRY_VERSION,
      parameter_registry_snapshot: t28Snapshot,
    });
    expect(migratedFromT28.parameter_registry_migration).toEqual({
      from_version: BASELINE_PARAMETER_REGISTRY_VERSION,
      to_version: PARAMETER_REGISTRY_VERSION,
      strategy: "baseline-0.2.0-to-0.3.0",
    });
  });

  it("rejects a tampered snapshot and keeps golden vectors independent by control group", () => {
    const snapshot = serializeParameterRegistry();
    const tampered = {
      ...snapshot,
      definitions: {
        ...snapshot.definitions,
        exposure_ev: {
          ...snapshot.definitions.exposure_ev,
          absolute_range: [-4, 4] as [number, number],
        },
      },
    };
    expect(() =>
      migrateNormalizedPlan({
        schema_version: "0.1.0",
        parameter_registry_version: PARAMETER_REGISTRY_VERSION,
        parameter_registry_snapshot: tampered,
        operations: [],
        warnings: [],
      }),
    ).toThrow(/does not match the verified definitions/);

    const vectors = runTranslatorGoldenVectors([
      {
        id: "global-exposure",
        control_group: "global-tonal",
        intent: {
          schema_version: "0.1.0",
          creative_goal: "brighten",
          adjustments: [
            {
              parameter: "exposure",
              direction: "increase",
              strength: "slight",
              rationale: "lift the subject",
              confidence: 0.9,
            },
          ],
          overall_confidence: 0.9,
        },
        expected_plan: {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "exposure_ev",
              mode: "delta",
              value: 0.2,
              confidence: 0.9,
              rationale: "lift the subject",
            },
          ],
          warnings: [],
        },
        current_settings: { Exposure2012: 0 },
        expected_settings: { Exposure2012: 0.2 },
      },
      {
        id: "white-balance-temperature",
        control_group: "white-balance",
        intent: {
          schema_version: "0.1.0",
          creative_goal: "warm the scene",
          adjustments: [
            {
              parameter: "temperature",
              direction: "increase",
              strength: "medium",
              rationale: "warm the ambient light",
              confidence: 0.9,
            },
          ],
          overall_confidence: 0.9,
        },
        expected_plan: {
          schema_version: "0.1.0",
          operations: [
            {
              parameter: "temperature_k",
              mode: "delta",
              value: 500,
              confidence: 0.9,
              rationale: "warm the ambient light",
            },
          ],
          warnings: [],
        },
      },
    ]);
    expect(vectors.map((vector) => [vector.id, vector.control_group])).toEqual([
      ["global-exposure", "global-tonal"],
      ["white-balance-temperature", "white-balance"],
    ]);
    expect(vectors[0]?.settings).toEqual({ Exposure2012: 0.2 });
    const duplicate = {
      id: "duplicate",
      control_group: "empty-plan",
      intent: {
        schema_version: "0.1.0" as const,
        creative_goal: "no-op",
        adjustments: [],
        overall_confidence: 1,
      },
      expected_plan: {
        schema_version: "0.1.0" as const,
        operations: [],
        warnings: ["No executable adjustment met the confidence threshold; manual review required"],
      },
    };
    expect(() => runTranslatorGoldenVectors([duplicate, duplicate])).toThrow(
      /Duplicate translator golden vector/,
    );
  });
});

describe("T30 Color Mixer planning", () => {
  const colorMixerPlan = {
    schema_version: "0.1.0" as const,
    parameter_registry_version: PARAMETER_REGISTRY_VERSION,
    operations: [
      {
        parameter: "hue_red" as const,
        mode: "absolute" as const,
        value: -100,
        confidence: 0.95,
        rationale: "boundary hue fixture",
      },
      {
        parameter: "saturation_magenta" as const,
        mode: "absolute" as const,
        value: 100,
        confidence: 0.95,
        rationale: "boundary saturation fixture",
      },
    ],
    warnings: [],
  };

  it("covers every supported channel/component with explicit bounds and backend keys", () => {
    expect(COLOR_MIXER_CHANNELS).toHaveLength(8);
    expect(COLOR_MIXER_COMPONENTS).toHaveLength(3);
    expect(COLOR_MIXER_PARAMETERS).toHaveLength(24);
    for (const component of COLOR_MIXER_COMPONENTS) {
      for (const channel of COLOR_MIXER_CHANNELS) {
        const parameter =
          `${component.prefix}_${channel}` as (typeof COLOR_MIXER_PARAMETERS)[number];
        const definition = PARAMETER_REGISTRY[parameter];
        expect(definition.control_group).toBe("color_mixer");
        expect(definition.backend_key).toBe(
          `${component.backendPrefix}${channel[0]!.toUpperCase()}${channel.slice(1)}`,
        );
        expect(definition.absolute_range).toEqual([-100, 100]);
        expect(definition.delta_range).toEqual([-100, 100]);
        expect(definition.allowed_modes).toEqual(["delta", "absolute"]);
        expect(definition.propagation.eligible).toBe(true);
        expect(definition.propagation.minimum_confidence).toBe(0.8);
      }
    }
  });

  it("preserves channel boundaries, rejects out-of-range values, and filters propagation explicitly", () => {
    expect(
      resolveLightroomSettings(
        { HueAdjustmentRed: 0, SaturationAdjustmentMagenta: 0 },
        colorMixerPlan,
      ),
    ).toEqual({ HueAdjustmentRed: -100, SaturationAdjustmentMagenta: 100 });
    expect(() =>
      validateNormalizedPlan({
        ...colorMixerPlan,
        operations: [
          {
            ...colorMixerPlan.operations[0],
            value: 101,
          },
        ],
      }),
    ).toThrow(/outside/);
    expect(
      selectPropagatableOperations(colorMixerPlan, ["hue_red", "saturation_magenta"]).map(
        (operation) => operation.parameter,
      ),
    ).toEqual(["hue_red", "saturation_magenta"]);
    expect(selectPropagatableOperations(colorMixerPlan, ["hue_red"])).toHaveLength(1);
    expect(selectPropagatableOperations(colorMixerPlan, [])).toHaveLength(0);
    expect(
      selectPropagatableOperations(
        {
          ...colorMixerPlan,
          operations: [{ ...colorMixerPlan.operations[0], confidence: 0.79 }],
        },
        ["hue_red"],
      ),
    ).toHaveLength(0);
  });

  it("refuses Color Mixer before mutation unless the backend declares every setting", async () => {
    expect(() => assertBackendSupportsPlan(MOCK_CAPABILITIES, colorMixerPlan)).toThrow(
      /does not declare support/,
    );
    const capableManifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      operations: {
        ...MOCK_CAPABILITIES.operations,
        apply_global_adjustment: {
          ...MOCK_CAPABILITIES.operations.apply_global_adjustment,
          supported_settings: ["HueAdjustmentRed", "SaturationAdjustmentMagenta"],
        },
      },
    });
    expect(() => assertBackendSupportsPlan(capableManifest, colorMixerPlan)).not.toThrow();

    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: {
        requiresCloudPreview: false,
        analyze: async () => ({
          intent: {
            schema_version: "0.1.0" as const,
            creative_goal: "adjust red hue",
            adjustments: [
              {
                parameter: "hue_red" as const,
                direction: "decrease" as const,
                strength: "slight" as const,
                rationale: "fixture color mixer request",
                confidence: 0.95,
              },
            ],
            overall_confidence: 0.95,
          },
          metadata: {
            provider: "mock" as const,
            model: "color-mixer-fixture",
            promptVersion: "color-mixer-fixture-v1",
            promptHash: "0".repeat(64),
            cloudPreview: false,
          },
        }),
      },
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).toEqual(["connect", "handshake", "close"]);
  });
});

describe("T12 workflow budgets", () => {
  it("stops before a render budget can start another iteration", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: new ScriptedEvaluator([refinement]),
      maxIterations: 3,
      budget: { maxRenders: 1 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      reason: string;
      render_count: number;
      budget: { max_renders: number };
      iteration_records: Array<{ state: string }>;
    };
    expect(report).toMatchObject({
      reason: "render_budget_exhausted",
      render_count: 1,
      budget: { max_renders: 1 },
    });
    expect(report.iteration_records.map((record) => record.state)).toEqual(["REFINING"]);
  });

  it("does not accept an evaluation that exceeds token or cost limits", async () => {
    const { root, raw, preview } = await fixturePair();
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      evaluator: {
        name: "over-budget-fixture",
        requiresCloudPreview: false,
        evaluate: async () => ({
          schema_version: "0.2.0" as const,
          verdict: "accept" as const,
          confidence: 0.99,
          rationale: "The fixture would otherwise be accepted",
          issues: [],
          usage: { evaluator_calls: 1, total_tokens: 101, estimated_cost_usd: 0.02 },
        }),
      },
      budget: { maxTotalTokens: 100, maxCostUsd: 0.01 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as {
      reason: string;
      iterations: number;
      render_count: number;
      evaluator_calls: number;
      total_tokens: number;
      estimated_cost_usd: number;
      iteration_records: Array<{ state: string; error?: string }>;
    };
    expect(report).toMatchObject({
      reason: "token_budget_exhausted",
      iterations: 1,
      render_count: 1,
      evaluator_calls: 1,
      total_tokens: 101,
      estimated_cost_usd: 0.02,
    });
    expect(report.iteration_records[0]).toMatchObject({
      state: "REVIEW_REQUIRED",
      error: "token_budget_exhausted",
    });
  });

  it("records a zero-time budget as review without mutating the backend", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend,
      budget: { maxElapsedMs: 0 },
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });

    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).not.toContain("create_workflow_copy");
    const report = JSON.parse(
      await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
    ) as { reason: string; iterations: number; render_count: number };
    expect(report).toMatchObject({
      reason: "time_budget_exhausted",
      iterations: 0,
      render_count: 0,
    });
  });
});
