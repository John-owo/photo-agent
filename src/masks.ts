import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import {
  MAX_MASKS_PER_PHOTO,
  NormalizedMaskSchema,
  type LOCAL_LIGHTROOM_KEYS,
  type MASK_PARAMETERS,
} from "./schemas.js";
import type {
  BackendCapabilityManifest,
  LightroomMaskCorrection,
  MaskFeedback,
  NormalizedMask,
  SemanticMaskIntent,
} from "./types.js";

/**
 * Deterministic translation and bookkeeping for geometric local masks
 * (Lightroom `Mask/CircularGradient` and `Mask/Gradient`).
 *
 * Verified Lightroom MCP behaviour this module encodes:
 * - `Flipped: true` makes a circular gradient act INSIDE the ellipse.
 * - `LocalExposure2012` is roughly EV / 4 (-0.125 is about -0.5 EV).
 * - Writing `MaskGroupBasedCorrections` replaces the whole set, so callers must
 *   merge with the corrections already on the photo before writing.
 */

export const MASK_WRITE_OPERATION = "apply_geometric_mask" as const;
export const MASK_READ_OPERATION = "read_geometric_masks" as const;
/** Lightroom MCP `set_develop_settings` accepts at most 50 corrections. */
export const MAX_TOTAL_CORRECTIONS = 50;
export const MIN_MASK_CONFIDENCE = 0.65;

type MaskParameter = (typeof MASK_PARAMETERS)[number];
type LocalKey = (typeof LOCAL_LIGHTROOM_KEYS)[number];

const LOCAL_KEY: Record<MaskParameter, LocalKey> = {
  exposure: "LocalExposure2012",
  temperature: "LocalTemperature",
  tint: "LocalTint",
  contrast: "LocalContrast2012",
  highlights: "LocalHighlights2012",
  shadows: "LocalShadows2012",
  whites: "LocalWhites2012",
  blacks: "LocalBlacks2012",
  texture: "LocalTexture",
  clarity: "LocalClarity2012",
  dehaze: "LocalDehaze",
  saturation: "LocalSaturation",
};

/** Exposure steps are expressed in EV and converted with the EV/4 rule. */
const EXPOSURE_EV = { slight: 0.15, medium: 0.3, strong: 0.5 } as const;
const LOCAL_STEP = { slight: 0.08, medium: 0.15, strong: 0.25 } as const;
/** Hard caps keep a single mask from producing halos or blown regions. */
export const MAX_LOCAL_EXPOSURE_EV = 0.75;
export const MAX_LOCAL_VALUE = 0.35;

function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function evToLocalExposure(ev: number): number {
  return round4(ev / 4);
}

export function localExposureToEv(value: number): number {
  return round4(value * 4);
}

function capLocal(parameter: MaskParameter, value: number): number {
  const cap = parameter === "exposure" ? MAX_LOCAL_EXPOSURE_EV / 4 : MAX_LOCAL_VALUE;
  return round4(Math.max(-cap, Math.min(cap, value)));
}

export type MaskTranslation = { masks: NormalizedMask[]; warnings: string[] };

export function translateMasks(
  intents: readonly SemanticMaskIntent[] | undefined,
): MaskTranslation {
  const warnings: string[] = [];
  const masks: NormalizedMask[] = [];
  for (const intent of intents ?? []) {
    if (masks.length >= MAX_MASKS_PER_PHOTO) {
      warnings.push(`Skipped mask ${intent.id}: more than ${MAX_MASKS_PER_PHOTO} masks requested`);
      continue;
    }
    if (intent.confidence < MIN_MASK_CONFIDENCE) {
      warnings.push(`Skipped low-confidence mask ${intent.id} (${intent.confidence.toFixed(2)})`);
      continue;
    }
    const adjustments = intent.adjustments.map((adjustment) => {
      const sign = adjustment.direction === "increase" ? 1 : -1;
      const raw =
        adjustment.parameter === "exposure"
          ? evToLocalExposure(sign * EXPOSURE_EV[adjustment.strength])
          : sign * LOCAL_STEP[adjustment.strength];
      return {
        parameter: adjustment.parameter,
        lightroom_key: LOCAL_KEY[adjustment.parameter],
        value: capLocal(adjustment.parameter, raw),
      };
    });
    masks.push(
      NormalizedMaskSchema.parse({
        id: intent.id,
        target: intent.target,
        region: intent.region,
        adjustments,
        placement_certainty: intent.placement_certainty,
        confidence: intent.confidence,
        rationale: intent.rationale,
      }),
    );
  }
  return { masks, warnings };
}

/** Correction names carry an owner prefix so later merges can tell them apart. */
export function maskOwnerPrefix(sessionId: string): string {
  return `photo-agent:${sessionId}:`;
}

export function correctionName(prefix: string, mask: NormalizedMask): string {
  return `${prefix}${mask.id}`;
}

export function toLightroomCorrection(
  mask: NormalizedMask,
  ownerPrefix: string,
): LightroomMaskCorrection {
  const correction: LightroomMaskCorrection = {
    What: "Correction",
    CorrectionName: correctionName(ownerPrefix, mask),
    CorrectionAmount: 1,
    CorrectionActive: true,
  };
  for (const adjustment of mask.adjustments) {
    correction[adjustment.lightroom_key] = adjustment.value;
  }
  if (mask.region.type === "radial") {
    const region = mask.region;
    correction.CorrectionMasks = [
      {
        What: "Mask/CircularGradient",
        MaskActive: true,
        MaskValue: 1,
        Top: round4(region.center_y - region.height / 2),
        Left: round4(region.center_x - region.width / 2),
        Bottom: round4(region.center_y + region.height / 2),
        Right: round4(region.center_x + region.width / 2),
        Angle: round4(region.angle_deg),
        Midpoint: 50,
        Feather: round4(region.feather),
        // Lightroom acts inside the ellipse only when Flipped is true.
        Flipped: !region.invert,
        Roundness: 0,
        Version: 2,
      },
    ];
  } else {
    const region = mask.region;
    correction.CorrectionMasks = [
      {
        What: "Mask/Gradient",
        MaskActive: true,
        MaskValue: 1,
        ZeroX: round4(region.zero_x),
        ZeroY: round4(region.zero_y),
        FullX: round4(region.full_x),
        FullY: round4(region.full_y),
        Version: 2,
      },
    ];
  }
  return correction;
}

const WRITABLE_MASK_TYPES = new Set(["Mask/CircularGradient", "Mask/Gradient"]);

function isScalar(value: unknown): boolean {
  return typeof value === "number" || typeof value === "string" || typeof value === "boolean";
}

/**
 * Lightroom MCP only accepts geometric masks with scalar fields on write. A
 * foreign correction that uses a brush, AI or range mask (or nested tables)
 * could not be written back unchanged, so merging would delete it. Return a
 * description of the first such correction, or undefined when all are safe.
 */
export function findUnpreservableCorrection(
  corrections: readonly LightroomMaskCorrection[],
): string | undefined {
  for (const [index, correction] of corrections.entries()) {
    if (correction.What !== "Correction") return `correction ${index} is not a Correction table`;
    for (const [key, value] of Object.entries(correction)) {
      if (key === "CorrectionMasks") continue;
      if (!isScalar(value)) return `correction ${index} field ${key} is not a scalar`;
    }
    const masks = correction.CorrectionMasks;
    if (!Array.isArray(masks) || masks.length === 0) {
      return `correction ${index} has no CorrectionMasks`;
    }
    for (const mask of masks) {
      const record = mask && typeof mask === "object" ? (mask as Record<string, unknown>) : {};
      if (!WRITABLE_MASK_TYPES.has(String(record.What))) {
        return `correction ${index} uses ${String(record.What)}`;
      }
      if (Object.values(record).some((value) => !isScalar(value))) {
        return `correction ${index} has a mask with nested values`;
      }
    }
  }
  return undefined;
}

export function isOwnedCorrection(
  correction: LightroomMaskCorrection,
  ownerPrefix: string,
): boolean {
  return (
    typeof correction.CorrectionName === "string" &&
    correction.CorrectionName.startsWith(ownerPrefix)
  );
}

/**
 * Merge this session's masks into the full set already on the photo: every
 * correction not owned by this session is preserved untouched and in order;
 * this session's previous corrections are replaced by the new set.
 */
export function mergeMaskCorrections(
  existing: readonly LightroomMaskCorrection[],
  masks: readonly NormalizedMask[],
  ownerPrefix: string,
): { corrections: LightroomMaskCorrection[]; preservedForeign: number } {
  const foreign = existing.filter((correction) => !isOwnedCorrection(correction, ownerPrefix));
  const corrections = [
    ...foreign,
    ...masks.map((mask) => toLightroomCorrection(mask, ownerPrefix)),
  ];
  if (corrections.length > MAX_TOTAL_CORRECTIONS) {
    throw new Error(
      `Merged mask set has ${corrections.length} corrections; Lightroom MCP accepts at most ${MAX_TOTAL_CORRECTIONS}`,
    );
  }
  return { corrections, preservedForeign: foreign.length };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  if (typeof value === "number") return round4(value);
  return value;
}

export function masksFingerprint(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * Compare what was written with what Lightroom reports. Lightroom may add
 * default fields (sync ids, zeroed local keys), so only the requested keys are
 * compared, numerically with a small tolerance.
 */
export function correctionsMatch(
  requested: readonly LightroomMaskCorrection[],
  readBack: readonly LightroomMaskCorrection[],
): boolean {
  if (requested.length !== readBack.length) return false;
  const near = (left: unknown, right: unknown): boolean => {
    if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) < 1e-3;
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((item, index) => near(item, right[index]));
    }
    if (left && typeof left === "object" && right && typeof right === "object") {
      return Object.entries(left as Record<string, unknown>).every(([key, item]) =>
        near(item, (right as Record<string, unknown>)[key]),
      );
    }
    return left === right;
  };
  return requested.every((correction, index) => near(correction, readBack[index]));
}

export type MaskFeedbackOutcome = {
  masks: NormalizedMask[];
  changed: boolean;
  misplaced: string[];
  notes: string[];
};

/**
 * Apply evaluator feedback deterministically: `too_strong` halves every local
 * value of that mask, `unnecessary` removes it, `misplaced` is reported so the
 * controller can remove the mask (unattended) or stop for review.
 */
export function applyMaskFeedback(
  masks: readonly NormalizedMask[],
  feedback: readonly MaskFeedback[] | undefined,
  options: { removeMisplaced: boolean },
): MaskFeedbackOutcome {
  const byId = new Map((feedback ?? []).map((item) => [item.mask_id, item]));
  const notes: string[] = [];
  const misplaced: string[] = [];
  let changed = false;
  const next: NormalizedMask[] = [];
  for (const mask of masks) {
    const item = byId.get(mask.id);
    if (!item || item.assessment === "ok") {
      next.push(mask);
      continue;
    }
    if (item.assessment === "too_strong") {
      changed = true;
      const adjustments = mask.adjustments
        .map((adjustment) => ({ ...adjustment, value: round4(adjustment.value / 2) }))
        .filter((adjustment) => Math.abs(adjustment.value) >= 0.005);
      if (adjustments.length === 0) {
        notes.push(`Removed mask ${mask.id}: too strong and already minimal`);
        continue;
      }
      notes.push(`Halved mask ${mask.id}: ${item.note}`);
      next.push(NormalizedMaskSchema.parse({ ...mask, adjustments }));
      continue;
    }
    if (item.assessment === "unnecessary") {
      changed = true;
      notes.push(`Removed mask ${mask.id}: ${item.note}`);
      continue;
    }
    misplaced.push(mask.id);
    if (options.removeMisplaced) {
      changed = true;
      notes.push(`Removed misplaced mask ${mask.id}: ${item.note}`);
      continue;
    }
    next.push(mask);
  }
  for (const id of byId.keys()) {
    if (!masks.some((mask) => mask.id === id))
      notes.push(`Ignored feedback for unknown mask ${id}`);
  }
  return { masks: next, changed, misplaced, notes };
}

export type MaskBackendSupport = "read_write" | "write_only" | "unsupported";

export function maskBackendSupport(
  manifest: BackendCapabilityManifest,
  adapter: { applyMaskCorrections?: unknown; readMaskCorrections?: unknown },
): MaskBackendSupport {
  const advertised = (operation: string): boolean =>
    manifest.capabilities.includes(operation) && manifest.operations[operation]?.supported === true;
  if (!advertised(MASK_WRITE_OPERATION) || typeof adapter.applyMaskCorrections !== "function") {
    return "unsupported";
  }
  return advertised(MASK_READ_OPERATION) && typeof adapter.readMaskCorrections === "function"
    ? "read_write"
    : "write_only";
}

export type SidecarMaskEvidence = "present" | "absent" | "no_sidecar" | "unreadable";

/**
 * Read-only heuristic used only when the backend cannot read masks: look for a
 * Lightroom XMP sidecar next to the RAW and check whether it records masks.
 * A sidecar may be stale, so `absent` is weak evidence and is reported as such.
 */
export async function sidecarMaskEvidence(rawPath: string): Promise<SidecarMaskEvidence> {
  const candidates = [
    join(dirname(rawPath), `${basename(rawPath, extname(rawPath))}.xmp`),
    join(dirname(rawPath), `${basename(rawPath, extname(rawPath))}.XMP`),
  ];
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "unreadable";
    }
    return /MaskGroupBasedCorrections[\s\S]{0,400}?<rdf:li/i.test(text) ? "present" : "absent";
  }
  return "no_sidecar";
}

export function partitionMasksForApply(
  masks: readonly NormalizedMask[],
  options: { unattended: boolean; approvedMaskIds: readonly string[] | "all" },
): { apply: NormalizedMask[]; pending: NormalizedMask[] } {
  const apply: NormalizedMask[] = [];
  const pending: NormalizedMask[] = [];
  for (const mask of masks) {
    const approved = options.approvedMaskIds === "all" || options.approvedMaskIds.includes(mask.id);
    if (mask.placement_certainty === "clear" || options.unattended || approved) apply.push(mask);
    else pending.push(mask);
  }
  return { apply, pending };
}
