import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  LIGHTROOM_MCP_SERVER_NAME,
  LightroomMcpAdapter,
  MASK_READBACK_META_KEY,
  MockBackend,
  OPERATION_SEMANTICS_META_KEY,
} from "../src/backends.js";
import { ClaudeProvider } from "../src/claude.js";
import { maskPolicyFromFlags } from "../src/cli.js";
import { AcceptingMockEvaluator, HandoffEvaluator, ScriptedEvaluator } from "../src/evaluation.js";
import {
  applyMaskFeedback,
  findUnpreservableCorrection,
  mergeMaskCorrections,
} from "../src/masks.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { PROMPT, EVALUATION_PROMPT } from "../src/prompts.js";
import { SemanticIntentPlanSchema } from "../src/schemas.js";
import { checkpointKeysFor, translateIntent } from "../src/translator.js";
import type {
  AnalysisProvider,
  EvaluationResult,
  LightroomMaskCorrection,
  SemanticIntentPlan,
} from "../src/types.js";
import { runUnattendedBatch } from "../src/unattended.js";
import {
  continueSession,
  recoverSession,
  restoreMasks,
  runSinglePhoto,
  sameDevelopSettings,
} from "../src/workflow.js";

const USER_MASK: LightroomMaskCorrection = {
  What: "Correction",
  CorrectionName: "user sky",
  CorrectionAmount: 1,
  CorrectionActive: true,
  LocalExposure2012: -0.1,
  CorrectionMasks: [
    {
      What: "Mask/Gradient",
      MaskActive: true,
      MaskValue: 1,
      ZeroX: 0.5,
      ZeroY: 0.4,
      FullX: 0.5,
      FullY: 0,
      Version: 2,
    },
  ],
};

function intentWithMasks(
  masks: SemanticIntentPlan["masks"],
  adjustments: SemanticIntentPlan["adjustments"] = [],
): SemanticIntentPlan {
  return SemanticIntentPlanSchema.parse({
    schema_version: "0.1.0",
    creative_goal: "lift the subject, calm the sky",
    adjustments,
    overall_confidence: 0.9,
    masks,
  });
}

const FACE_MASK = {
  id: "face",
  target: "shadowed face on the left",
  region: {
    type: "radial" as const,
    center_x: 0.3,
    center_y: 0.4,
    width: 0.2,
    height: 0.3,
    angle_deg: 0,
    feather: 70,
    invert: false,
  },
  adjustments: [
    { parameter: "exposure" as const, direction: "increase" as const, strength: "strong" as const },
    { parameter: "shadows" as const, direction: "increase" as const, strength: "medium" as const },
  ],
  placement_certainty: "clear" as const,
  rationale: "Face is underexposed relative to the background",
  confidence: 0.9,
};

const SKY_MASK = {
  id: "sky",
  target: "bright sky above the horizon",
  region: { type: "linear" as const, full_x: 0.5, full_y: 0, zero_x: 0.5, zero_y: 0.45 },
  adjustments: [
    {
      parameter: "highlights" as const,
      direction: "decrease" as const,
      strength: "medium" as const,
    },
  ],
  placement_certainty: "subjective" as const,
  rationale: "Sky is brighter than the subject",
  confidence: 0.85,
};

const EXPOSURE_UP = [
  {
    parameter: "exposure" as const,
    direction: "increase" as const,
    strength: "slight" as const,
    rationale: "slightly dark overall",
    confidence: 0.9,
  },
];

function fixedProvider(intent: SemanticIntentPlan): AnalysisProvider {
  return {
    requiresCloudPreview: false,
    async analyze() {
      return {
        intent,
        metadata: {
          provider: "mock",
          model: "mask-fixture",
          promptVersion: "test",
          promptHash: "0".repeat(64),
          cloudPreview: false,
        },
      };
    },
  };
}

async function fixturePair(): Promise<{ root: string; raw: string; preview: string }> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-masks-"));
  const raw = join(root, "DSC_0001.NEF");
  const preview = join(root, "DSC_0001.JPG");
  await writeFile(raw, "synthetic raw fixture", "utf8");
  await writeFixtureJpeg(preview);
  return { root, raw, preview };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function evaluation(overrides: Partial<EvaluationResult>): EvaluationResult {
  return {
    schema_version: "0.2.0",
    verdict: "accept",
    confidence: 0.9,
    rationale: "looks natural",
    issues: [],
    ...overrides,
  } as EvaluationResult;
}

describe("mask translation", () => {
  it("maps semantic masks to capped Lightroom tables with verified quirks", () => {
    const plan = translateIntent(intentWithMasks([FACE_MASK, SKY_MASK]));
    expect(plan.masks).toHaveLength(2);
    const face = plan.masks![0]!;
    // strong exposure = +0.5 EV -> EV/4 = 0.125
    expect(face.adjustments).toContainEqual({
      parameter: "exposure",
      lightroom_key: "LocalExposure2012",
      value: 0.125,
    });
    expect(face.adjustments).toContainEqual({
      parameter: "shadows",
      lightroom_key: "LocalShadows2012",
      value: 0.15,
    });
    const [correction] = mergeMaskCorrections([], [face], "photo-agent:s1:").corrections;
    const mask = (correction!.CorrectionMasks as Record<string, unknown>[])[0]!;
    expect(correction!.CorrectionName).toBe("photo-agent:s1:face");
    expect(mask.What).toBe("Mask/CircularGradient");
    expect(mask.Flipped).toBe(true); // acts inside the ellipse
    expect(mask).toMatchObject({ Top: 0.25, Bottom: 0.55, Left: 0.2, Right: 0.4, Feather: 70 });
    const [, sky] = mergeMaskCorrections([], plan.masks!, "p:").corrections;
    expect((sky!.CorrectionMasks as Record<string, unknown>[])[0]).toMatchObject({
      What: "Mask/Gradient",
      FullX: 0.5,
      FullY: 0,
      ZeroX: 0.5,
      ZeroY: 0.45,
    });
  });

  it("inverts radial masks through Flipped=false and skips low confidence masks", () => {
    const plan = translateIntent(
      intentWithMasks([
        { ...FACE_MASK, id: "vignette", region: { ...FACE_MASK.region, invert: true } },
        { ...FACE_MASK, id: "weak", confidence: 0.4 },
      ]),
    );
    expect(plan.masks!.map((mask) => mask.id)).toEqual(["vignette"]);
    expect(plan.warnings.join(" ")).toContain("low-confidence mask weak");
    const [correction] = mergeMaskCorrections([], plan.masks!, "p:").corrections;
    expect((correction!.CorrectionMasks as Record<string, unknown>[])[0]!.Flipped).toBe(false);
  });

  it("rejects more than three masks, duplicate ids and degenerate gradients", () => {
    expect(() =>
      intentWithMasks([FACE_MASK, SKY_MASK, { ...FACE_MASK, id: "a" }, { ...FACE_MASK, id: "b" }]),
    ).toThrow();
    expect(() => intentWithMasks([FACE_MASK, FACE_MASK])).toThrow(/Duplicate mask id/);
    expect(() =>
      intentWithMasks([
        {
          ...SKY_MASK,
          region: { type: "linear", full_x: 0.5, full_y: 0.2, zero_x: 0.5, zero_y: 0.205 },
        },
      ]),
    ).toThrow(/0.02/);
  });

  it("keeps intent files written before masks existed valid", () => {
    const legacy = SemanticIntentPlanSchema.parse({
      schema_version: "0.1.0",
      creative_goal: "legacy",
      adjustments: EXPOSURE_UP,
      overall_confidence: 0.8,
    });
    expect(translateIntent(legacy).masks).toBeUndefined();
  });

  it("merges by preserving foreign corrections and replacing this session's own", () => {
    const plan = translateIntent(intentWithMasks([FACE_MASK]));
    const old = { ...USER_MASK, CorrectionName: "photo-agent:s1:old" };
    const merged = mergeMaskCorrections([USER_MASK, old], plan.masks!, "photo-agent:s1:");
    expect(merged.preservedForeign).toBe(1);
    expect(merged.corrections.map((c) => c.CorrectionName)).toEqual([
      "user sky",
      "photo-agent:s1:face",
    ]);
  });

  it("flags foreign brush or AI masks that a merge could not preserve", () => {
    expect(findUnpreservableCorrection([USER_MASK])).toBeUndefined();
    expect(
      findUnpreservableCorrection([
        { ...USER_MASK, CorrectionMasks: [{ What: "Mask/Paint", Dabs: ["d 0.1 0.2"] }] },
      ]),
    ).toMatch(/Mask\/Paint/);
  });

  it("applies evaluator feedback deterministically", () => {
    const masks = translateIntent(intentWithMasks([FACE_MASK, SKY_MASK])).masks!;
    const outcome = applyMaskFeedback(
      masks,
      [
        { mask_id: "face", assessment: "too_strong", note: "halo around the face" },
        { mask_id: "sky", assessment: "misplaced", note: "cuts the mountain" },
      ],
      { removeMisplaced: true },
    );
    expect(outcome.changed).toBe(true);
    expect(outcome.misplaced).toEqual(["sky"]);
    expect(outcome.masks.map((mask) => mask.id)).toEqual(["face"]);
    expect(outcome.masks[0]!.adjustments[0]!.value).toBe(0.0625);
    const interactive = applyMaskFeedback(
      masks,
      [{ mask_id: "sky", assessment: "misplaced", note: "x" }],
      { removeMisplaced: false },
    );
    expect(interactive.masks).toHaveLength(2);
  });

  it("keeps prompts honest about the mask contract", () => {
    expect(PROMPT).toContain("radial");
    expect(PROMPT).toContain("subjective");
    expect(PROMPT).not.toContain("Do not invent local masks");
    expect(EVALUATION_PROMPT).toContain("mask_feedback");
    expect(EVALUATION_PROMPT).toContain("too_strong");
  });

  it("derives the mask policy from CLI flags", () => {
    expect(maskPolicyFromFlags({ mode: "interactive" })).toEqual({
      unattended: false,
      allowUnverifiedReplace: false,
      approvedMaskIds: [],
    });
    expect(maskPolicyFromFlags({ mode: "unattended", "approve-masks": "sky,face" })).toEqual({
      unattended: true,
      allowUnverifiedReplace: true,
      approvedMaskIds: ["sky", "face"],
    });
    expect(() => maskPolicyFromFlags({ mode: "overnight" })).toThrow();
  });
});

describe("mask workflow on the mock backend", () => {
  it("merges with a user's existing mask on the Workflow Copy and never touches the Master", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write", existingMasks: [USER_MASK] });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("ACCEPTED");
    const copyId = backend.maskWrites[0]!.photoId;
    expect(copyId).not.toBe(raw);
    expect(backend.masksFor(copyId).map((c) => c.CorrectionName)).toEqual([
      "user sky",
      expect.stringMatching(/^photo-agent:.+:face$/),
    ]);
    expect(backend.masksFor(raw)).toEqual([USER_MASK]);
    const decision = await readJson<{ mode: string }>(
      join(result.sessionDir, "masks", "mask-decision.json"),
    );
    expect(decision.mode).toBe("merge_readback");
    const intent = await readJson<{ before: unknown[]; before_status: string }>(
      join(result.sessionDir, "masks", "iteration-1-intent.json"),
    );
    expect(intent.before_status).toBe("read_back");
    expect(intent.before).toEqual([USER_MASK]);
    const written = await readJson<{ readback_status: string }>(
      join(result.sessionDir, "masks", "iteration-1-result.json"),
    );
    expect(written.readback_status).toBe("verified");
  });

  it("degrades to global adjustments on a backend without mask support and says why", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("ACCEPTED");
    expect(backend.maskWrites).toHaveLength(0);
    expect(backend.calls).toContain("apply_global_adjustment");
    const decision = await readJson<{ mode: string; reason: string }>(
      join(result.sessionDir, "masks", "mask-decision.json"),
    );
    expect(decision).toMatchObject({
      mode: "degraded_to_global",
      reason: "backend_does_not_support_geometric_masks",
    });
    const report = await readJson<{ masks: { degrade_reason: string } }>(
      join(result.sessionDir, "iteration-report.json"),
    );
    expect(report.masks.degrade_reason).toBe("backend_does_not_support_geometric_masks");
  });

  it("stops for review when only masks were planned and the backend cannot draw them", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK])),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).not.toContain("create_workflow_copy");
  });

  it("refuses unverified replacement unless unattended, and honours an XMP sidecar with masks", async () => {
    const run = async (
      policy: Parameters<typeof runSinglePhoto>[0]["maskPolicy"],
      sidecar?: string,
    ) => {
      const { root, raw, preview } = await fixturePair();
      if (sidecar) await writeFile(join(root, "DSC_0001.xmp"), sidecar, "utf8");
      const backend = new MockBackend(raw, { maskSupport: "write_only" });
      const result = await runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
        backend,
        sessionRoot: join(root, "sessions"),
        apply: true,
        allowCloudPreview: false,
        evaluator: new AcceptingMockEvaluator(),
        ...(policy ? { maskPolicy: policy } : {}),
      });
      const decision = await readJson<{ mode: string; reason?: string }>(
        join(result.sessionDir, "masks", "mask-decision.json"),
      );
      return { backend, decision };
    };
    const interactive = await run(undefined);
    expect(interactive.decision.reason).toBe(
      "backend_cannot_read_existing_masks_and_replace_not_allowed",
    );
    expect(interactive.backend.maskWrites).toHaveLength(0);
    const unattended = await run({ unattended: true, allowUnverifiedReplace: true });
    expect(unattended.decision.mode).toBe("replace_unverified");
    expect(unattended.backend.maskWrites).toHaveLength(1);
    const withSidecar = await run(
      { unattended: true, allowUnverifiedReplace: true },
      "<crs:MaskGroupBasedCorrections><rdf:Seq><rdf:li>user mask</rdf:li></rdf:Seq></crs:MaskGroupBasedCorrections>",
    );
    expect(withSidecar.decision.reason).toBe("existing_masks_detected_in_xmp_sidecar");
    expect(withSidecar.backend.maskWrites).toHaveLength(0);
  });

  it("treats an absent mask readback as unknown, not as empty", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, {
      maskSupport: "read_write",
      maskReadbackAbsentWhenEmpty: true,
    });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("ACCEPTED");
    expect(backend.maskWrites).toHaveLength(0);
    const decision = await readJson<{ reason: string }>(
      join(result.sessionDir, "masks", "mask-decision.json"),
    );
    expect(decision.reason).toMatch(/^mask_readback_absent/);
  });

  it("degrades to global adjustments when the plugin cannot read masks back", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, {
      maskSupport: "read_write",
      maskReadbackUnreadable: "plugin_without_mask_readback",
    });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
      maskPolicy: { unattended: true },
    });
    expect(result.state).toBe("ACCEPTED");
    expect(backend.maskWrites).toHaveLength(0);
    expect(backend.calls).toContain("apply_global_adjustment");
    const report = await readJson<{ masks: { mode: string; degrade_reason: string } }>(
      join(result.sessionDir, "iteration-report.json"),
    );
    expect(report.masks).toMatchObject({
      mode: "degraded_to_global",
      degrade_reason: "existing_masks_unreadable: plugin_without_mask_readback",
    });
  });

  it("skips an adjustment Lightroom cannot read back and applies the rest", async () => {
    const { root, raw, preview } = await fixturePair();
    // Live run 2026-11-27: "As Shot" white balance came back without Temperature.
    const backend = new MockBackend(raw, { maskSupport: "none", omitDevelopKeys: ["Temperature"] });
    const intent = intentWithMasks(
      [],
      [
        ...EXPOSURE_UP,
        {
          parameter: "temperature",
          direction: "decrease",
          strength: "slight",
          rationale: "slightly orange",
          confidence: 0.8,
        },
      ],
    );
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intent),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("ACCEPTED");
    expect(backend.calls).toContain("apply_global_adjustment");
    const report = await readJson<{ skipped_operations: string[] }>(
      join(result.sessionDir, "iteration-report.json"),
    );
    expect(report.skipped_operations).toHaveLength(1);
    expect(report.skipped_operations[0]).toMatch(/^temperature_k：.*Temperature.*As Shot/);
    // Live rerun 2026-11-27: the checkpoint must not ask for the missing key.
    expect(backend.calls).toContain("create_checkpoint");
  });

  it("ignores Temperature/Tint that Lightroom fills in lazily under As Shot", () => {
    // Live rerun 2026-11-27: Temperature 4850 appeared on the copy after the render.
    const paused = { WhiteBalance: "As Shot", Shadows2012: 16 };
    expect(sameDevelopSettings({ ...paused, Temperature: 4850, Tint: 11 }, paused)).toBe(true);
    expect(
      sameDevelopSettings({ WhiteBalance: "Custom", Shadows2012: 16, Temperature: 4850 }, paused),
    ).toBe(false);
    expect(
      sameDevelopSettings({ ...paused, Temperature: 4850 }, { ...paused, Temperature: 5200 }),
    ).toBe(false);
    expect(sameDevelopSettings({ ...paused, Shadows2012: 20 }, paused)).toBe(false);
  });

  it("checkpoints only reported keys and refuses to write an uncovered one", () => {
    const current = { WhiteBalance: "As Shot", Exposure2012: 0, Shadows2012: 0 };
    expect(checkpointKeysFor(current, { Shadows2012: 10 })).toEqual(
      expect.arrayContaining(["WhiteBalance", "Exposure2012", "Shadows2012"]),
    );
    expect(checkpointKeysFor(current, { Shadows2012: 10 })).not.toContain("Temperature");
    expect(() => checkpointKeysFor(current, { Temperature: 4800 })).toThrow(/Temperature/);
  });

  it("still stops for review when every adjustment is unreadable", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "none", omitDevelopKeys: ["Temperature"] });
    const intent = intentWithMasks(
      [],
      [
        {
          parameter: "temperature",
          direction: "decrease",
          strength: "slight",
          rationale: "slightly orange",
          confidence: 0.8,
        },
      ],
    );
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intent),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.calls).not.toContain("apply_global_adjustment");
    const log = await readFile(join(result.sessionDir, "session.log"), "utf8");
    expect(log).toContain("no_executable_operations");
    expect(log).toContain("temperature_k");
  });

  it("refuses to merge over a foreign brush mask", async () => {
    const { root, raw, preview } = await fixturePair();
    const brush = { ...USER_MASK, CorrectionMasks: [{ What: "Mask/Paint", Dabs: ["d 0.1 0.2"] }] };
    const backend = new MockBackend(raw, { maskSupport: "read_write", existingMasks: [brush] });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    expect(result.state).toBe("ACCEPTED");
    expect(backend.maskWrites).toHaveLength(0);
    const decision = await readJson<{ reason: string }>(
      join(result.sessionDir, "masks", "mask-decision.json"),
    );
    expect(decision.reason).toMatch(/existing_masks_cannot_be_preserved/);
  });

  it("holds subjective masks for review in interactive mode until approved", async () => {
    const run = async (policy?: { approvedMaskIds: string[] }) => {
      const { root, raw, preview } = await fixturePair();
      const backend = new MockBackend(raw, { maskSupport: "read_write" });
      const result = await runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: fixedProvider(intentWithMasks([FACE_MASK, SKY_MASK])),
        backend,
        sessionRoot: join(root, "sessions"),
        apply: true,
        allowCloudPreview: false,
        evaluator: new AcceptingMockEvaluator(),
        ...(policy ? { maskPolicy: policy } : {}),
      });
      const decision = await readJson<{
        applied_mask_ids: string[];
        pending_review_mask_ids: string[];
      }>(join(result.sessionDir, "masks", "mask-decision.json"));
      return decision;
    };
    expect(await run()).toMatchObject({
      applied_mask_ids: ["face"],
      pending_review_mask_ids: ["sky"],
    });
    expect(await run({ approvedMaskIds: ["sky"] })).toMatchObject({
      applied_mask_ids: ["face", "sky"],
      pending_review_mask_ids: [],
    });
  });

  it("halves an over-strong mask on refine and stops for review when a mask is misplaced", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write" });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      maxIterations: 3,
      evaluator: new ScriptedEvaluator([
        evaluation({
          verdict: "refine",
          refinement_plan: { schema_version: "0.1.0", operations: [], warnings: [] },
          mask_feedback: [{ mask_id: "face", assessment: "too_strong", note: "glowing halo" }],
        }),
        evaluation({
          verdict: "refine",
          refinement_plan: { schema_version: "0.1.0", operations: [], warnings: [] },
          mask_feedback: [{ mask_id: "face", assessment: "misplaced", note: "hits the wall" }],
        }),
      ]),
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    expect(backend.maskWrites).toHaveLength(2);
    const second = backend.maskWrites[1]!.corrections[0]!;
    expect(second.LocalExposure2012).toBe(0.0625);
    const log = await readFile(join(result.sessionDir, "session.log"), "utf8");
    expect(log).toContain("mask_placement_questioned");
  });

  it("records an uncertain mask write so recover reports it without retrying", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write", failMaskWrite: true });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    const masksDir = await readdir(join(result.sessionDir, "masks"));
    expect(masksDir).toContain("iteration-1-intent.json");
    expect(masksDir).not.toContain("iteration-1-result.json");
    const recovered = await recoverSession({ sessionDir: result.sessionDir, backend });
    expect(recovered.state).toBe("REVIEW_REQUIRED");
    const reports = await readdir(join(result.sessionDir, "recovery"));
    const report = await readJson<{
      mask_evidence_status: string;
      reason: string;
      mutation_retried: boolean;
    }>(join(result.sessionDir, "recovery", reports[0]!));
    expect(report.mask_evidence_status).toBe("insufficient");
    expect(report.reason).toBe("mask_write_outcome_uncertain");
    expect(report.mutation_retried).toBe(false);
    expect(backend.calls.filter((call) => call === "apply_geometric_mask")).toHaveLength(1);
  });

  it("restores the recorded mask set on the same Workflow Copy", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write", existingMasks: [USER_MASK] });
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new AcceptingMockEvaluator(),
    });
    const copyId = backend.maskWrites[0]!.photoId;
    expect(backend.masksFor(copyId)).toHaveLength(2);
    const restored = await restoreMasks({ sessionDir: result.sessionDir, backend, iteration: 1 });
    expect(restored.readbackStatus).toBe("verified");
    expect(backend.masksFor(copyId)).toEqual([USER_MASK]);
  });
});

describe("agent-driven evaluation handoff", () => {
  it("pauses after the render and continues on the same Workflow Copy", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write" });
    const first = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      maxIterations: 3,
      evaluator: new HandoffEvaluator(),
      maskPolicy: { unattended: true, allowUnverifiedReplace: true },
    });
    expect(first.state).toBe("EVALUATION_INPUT_REQUIRED");
    expect(first.evaluationRequestPath).toBeDefined();
    const request = await readFile(first.evaluationRequestPath!, "utf8");
    expect(request).toContain('Mask "face"');
    expect(request).toContain("+0.50 EV");

    const refine = join(root, "eval-1.json");
    await writeFile(
      refine,
      JSON.stringify(
        evaluation({
          verdict: "refine",
          refinement_plan: {
            schema_version: "0.1.0",
            operations: [
              {
                parameter: "contrast",
                mode: "delta",
                value: 5,
                confidence: 0.8,
                rationale: "a bit flat",
              },
            ],
            warnings: [],
          },
          mask_feedback: [{ mask_id: "face", assessment: "too_strong", note: "bright halo" }],
        }),
      ),
      "utf8",
    );
    const second = await continueSession({
      sessionDir: first.sessionDir,
      evaluationFile: refine,
      backend,
    });
    expect(second.state).toBe("EVALUATION_INPUT_REQUIRED");
    expect(second.iterations).toBe(2);
    expect(backend.maskWrites).toHaveLength(2);
    expect(backend.maskWrites[1]!.corrections[0]!.LocalExposure2012).toBe(0.0625);

    const accept = join(root, "eval-2.json");
    await writeFile(
      accept,
      JSON.stringify(
        evaluation({ mask_feedback: [{ mask_id: "face", assessment: "ok", note: "natural" }] }),
      ),
      "utf8",
    );
    const third = await continueSession({
      sessionDir: first.sessionDir,
      evaluationFile: accept,
      backend,
    });
    expect(third.state).toBe("ACCEPTED");
    const report = await readJson<{ iterations: number; masks: { notes: string[] } }>(
      join(first.sessionDir, "iteration-report.json"),
    );
    expect(report.iterations).toBe(2);
    expect(report.masks.notes.join(" ")).toContain("Halved mask face");
  });

  it("refuses to continue when the Workflow Copy changed while waiting", async () => {
    const { root, raw, preview } = await fixturePair();
    const backend = new MockBackend(raw, { maskSupport: "read_write" });
    const first = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: fixedProvider(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
      backend,
      sessionRoot: join(root, "sessions"),
      apply: true,
      allowCloudPreview: false,
      evaluator: new HandoffEvaluator(),
    });
    const copyId = backend.maskWrites[0]!.photoId;
    await backend.connect();
    await backend.handshake();
    await backend.applyGlobalAdjustment(copyId, { Exposure2012: 2 });
    await backend.close();
    const accept = join(root, "eval.json");
    await writeFile(accept, JSON.stringify(evaluation({})), "utf8");
    const result = await continueSession({
      sessionDir: first.sessionDir,
      evaluationFile: accept,
      backend,
    });
    expect(result.state).toBe("REVIEW_REQUIRED");
    const log = await readFile(join(first.sessionDir, "session.log"), "utf8");
    expect(log).toContain("workflow_copy_changed_while_waiting");
  });
});

describe("unattended batch", () => {
  it("drives a folder through agent analysis and evaluation files to a morning report", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-batch-"));
    const shoot = join(root, "shoot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shoot);
    for (const name of ["A_001", "A_002"]) {
      await writeFile(join(shoot, `${name}.NEF`), `raw ${name}`, "utf8");
      await writeFixtureJpeg(join(shoot, `${name}.JPG`));
    }
    const backends = new Map<string, MockBackend>();
    const options = {
      batchRoot: join(root, "batches"),
      providerFactory: () => new (class extends Object {})() as never,
      evaluatorFactory: () => new HandoffEvaluator(),
      backendFactory: (rawPath: string) => {
        if (!backends.has(rawPath))
          backends.set(rawPath, new MockBackend(rawPath, { maskSupport: "read_write" }));
        return backends.get(rawPath)!;
      },
      allowCloudPreview: false,
      maxIterations: 2,
      maskPolicy: { unattended: true, allowUnverifiedReplace: true },
      mode: "unattended" as const,
      labels: { provider: "codex", evaluator: "handoff", backend: "mock" },
      exiftool: null,
    };
    const { CodexProvider } = await import("../src/providers.js");
    options.providerFactory = () => new CodexProvider() as never;

    const first = await runUnattendedBatch({ ...options, root: shoot });
    expect(first.waiting).toBe(2);
    expect(first.records.every((record) => record.state === "CODEX_INPUT_REQUIRED")).toBe(true);
    const worklist = await readJson<{ items: { kind: string; output: string; image: string }[] }>(
      join(first.batchDir, "worklist.json"),
    );
    expect(worklist.items.map((item) => item.kind)).toEqual(["analyze", "analyze"]);
    for (const item of worklist.items) {
      await writeFile(
        item.output,
        JSON.stringify(intentWithMasks([FACE_MASK], EXPOSURE_UP)),
        "utf8",
      );
    }

    const second = await runUnattendedBatch({ ...options, resumeDir: first.batchDir });
    expect(second.records.map((record) => record.state)).toEqual([
      "EVALUATION_INPUT_REQUIRED",
      "EVALUATION_INPUT_REQUIRED",
    ]);
    const evaluateList = await readJson<{
      items: { kind: string; output: string; image: string }[];
    }>(join(first.batchDir, "worklist.json"));
    expect(
      evaluateList.items.every((item) => item.kind === "evaluate" && item.image.endsWith(".jpg")),
    ).toBe(true);
    await writeFile(evaluateList.items[0]!.output, JSON.stringify(evaluation({})), "utf8");
    await writeFile(
      evaluateList.items[1]!.output,
      JSON.stringify(evaluation({ verdict: "review", rationale: "skin tone is a judgement call" })),
      "utf8",
    );

    const third = await runUnattendedBatch({ ...options, resumeDir: first.batchDir });
    expect(third.waiting).toBe(0);
    expect(third.records.map((record) => record.state)).toEqual(["ACCEPTED", "REVIEW_REQUIRED"]);
    const report = await readFile(third.reportPath, "utf8");
    expect(report).toContain("晨間修圖報告");
    expect(report).toContain("完成 1");
    expect(report).toContain("評估器認為需要人工判斷");
    // A finished batch is idempotent: nothing is re-applied.
    const writesBefore = [...backends.values()].reduce((sum, b) => sum + b.maskWrites.length, 0);
    const fourth = await runUnattendedBatch({ ...options, resumeDir: first.batchDir });
    expect(fourth.records.map((record) => record.state)).toEqual(["ACCEPTED", "REVIEW_REQUIRED"]);
    expect([...backends.values()].reduce((sum, b) => sum + b.maskWrites.length, 0)).toBe(
      writesBefore,
    );
  });

  it("stops after consecutive failures instead of burning through the folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-batch-fail-"));
    const shoot = join(root, "shoot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shoot);
    for (const name of ["B_001", "B_002", "B_003"]) {
      await writeFile(join(shoot, `${name}.NEF`), `raw ${name}`, "utf8");
      await writeFixtureJpeg(join(shoot, `${name}.JPG`));
    }
    const result = await runUnattendedBatch({
      root: shoot,
      batchRoot: join(root, "batches"),
      providerFactory: () => ({
        requiresCloudPreview: false,
        analyze: async () => {
          throw new Error("provider offline");
        },
      }),
      evaluatorFactory: () => undefined,
      backendFactory: (rawPath) => new MockBackend(rawPath),
      allowCloudPreview: false,
      maxIterations: 1,
      maskPolicy: {},
      mode: "unattended",
      labels: { provider: "mock", evaluator: null, backend: "mock" },
      maxConsecutiveFailures: 2,
      exiftool: null,
    });
    expect(result.stoppedEarly).toMatch(/2 consecutive failures/);
    expect(result.records.map((record) => record.state)).toEqual(["FAILED", "FAILED", "PENDING"]);
  });
});

describe("backend capability detection", () => {
  async function lightroomWithTools(options: {
    maskInput: boolean;
    readbackMeta: boolean;
    metadata?: unknown;
  }) {
    const semantics = {
      supported: true,
      side_effect: "read_only",
      idempotent: true,
      reversible: "true_undo",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "parallel_safe",
      retry_policy: "automatic",
      safe_to_resume: true,
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: LIGHTROOM_MCP_SERVER_NAME, version: "0.10.0" },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_photo_metadata",
          inputSchema: { type: "object", properties: {} },
          _meta: {
            [OPERATION_SEMANTICS_META_KEY]: semantics,
            ...(options.readbackMeta
              ? {
                  [MASK_READBACK_META_KEY]: {
                    version: 1,
                    field: "developSettings.MaskGroupBasedCorrections",
                  },
                }
              : {}),
          },
        },
        {
          name: "set_develop_settings",
          inputSchema: {
            type: "object",
            properties: {
              settings: {
                type: "object",
                properties: options.maskInput
                  ? {
                      Exposure2012: { type: "number" },
                      MaskGroupBasedCorrections: { type: "array" },
                    }
                  : { Exposure2012: { type: "number" } },
              },
            },
          },
          _meta: {
            [OPERATION_SEMANTICS_META_KEY]: {
              ...semantics,
              side_effect: "mutating",
              idempotent: false,
            },
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            options.metadata ?? {
              developSettings: { MaskGroupBasedCorrections: [], maskReadback: "absent" },
            },
          ),
        },
      ],
    }));
    await server.connect(serverTransport);
    const client = new Client({ name: "photo-agent-test", version: "1.0.0" });
    return new LightroomMcpAdapter("unused", { client, transport: clientTransport });
  }

  it("detects geometric mask write and readback from the tool listing", async () => {
    const full = await lightroomWithTools({ maskInput: true, readbackMeta: true });
    await full.connect();
    const manifest = await full.handshake();
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["apply_geometric_mask", "read_geometric_masks"]),
    );
    expect(await full.readMaskCorrections("1")).toEqual({ status: "absent", corrections: [] });
    await full.close();

    const writeOnly = await lightroomWithTools({ maskInput: true, readbackMeta: false });
    await writeOnly.connect();
    const writeManifest = await writeOnly.handshake();
    expect(writeManifest.capabilities).toContain("apply_geometric_mask");
    expect(writeManifest.capabilities).not.toContain("read_geometric_masks");
    await writeOnly.close();

    const old = await lightroomWithTools({ maskInput: false, readbackMeta: false });
    await old.connect();
    const oldManifest = await old.handshake();
    expect(oldManifest.capabilities).not.toContain("apply_geometric_mask");
    await old.close();
  });

  it("reports masks as unreadable when the server advertises readback but the plugin is older", async () => {
    // Live run 2026-11-27: server from the mask branch, plugin from before readback.
    const mismatched = await lightroomWithTools({
      maskInput: true,
      readbackMeta: true,
      metadata: { developSettings: { whiteBalance: "As Shot", shadows: 0 } },
    });
    await mismatched.connect();
    await mismatched.handshake();
    expect(await mismatched.readMaskCorrections("1")).toEqual({
      status: "unreadable",
      corrections: [],
      detail: "plugin_without_mask_readback",
    });
    await mismatched.close();
  });
});

describe("Claude provider", () => {
  it("resumes pause_turn and validates the structured intent", async () => {
    const { root, preview } = await fixturePair();
    void root;
    const responses = [
      {
        id: "m1",
        stop_reason: "pause_turn",
        content: [{ type: "server_tool_use" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      {
        id: "m2",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: JSON.stringify(intentWithMasks([FACE_MASK], EXPOSURE_UP)) },
        ],
        usage: { input_tokens: 20, output_tokens: 30 },
      },
    ];
    const requests: unknown[] = [];
    const client = {
      beta: {
        messages: {
          create: async (request: unknown) => {
            const record = request as { tools?: unknown; fallbacks?: unknown; messages: unknown[] };
            requests.push({
              tools: record.tools,
              fallbacks: record.fallbacks,
              messages: [...record.messages],
            });
            return responses.shift();
          },
        },
      },
    };
    const provider = new ClaudeProvider({ client: client as never, webReferences: true });
    const result = await provider.analyze(preview);
    expect(result.intent.masks?.[0]?.id).toBe("face");
    expect(result.metadata).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      cloudPreview: true,
    });
    expect(result.metadata.usage?.totalTokens).toBe(62);
    expect(requests).toHaveLength(2);
    const firstRequest = requests[0] as { tools?: { type: string }[]; fallbacks?: string };
    expect(firstRequest.tools?.[0]?.type).toBe("web_search_20260209");
    expect(firstRequest.fallbacks).toBe("default");
    expect((requests[1] as { messages: unknown[] }).messages).toHaveLength(2);
  });
});
