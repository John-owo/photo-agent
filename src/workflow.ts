import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  APPLY_PRESET_OPERATION,
  nextCopyVersionName,
  RENAME_COPY_OPERATION,
  workflowCopyMarker,
} from "./backends.js";
import { describeEvaluationInput } from "./claude.js";
import {
  EvaluationInputRequiredError,
  HandoffEvaluator,
  MIN_EVALUATION_CONFIDENCE,
  planFingerprint,
  renderFingerprint,
} from "./evaluation.js";
import { EVALUATION_PROMPT } from "./prompts.js";
import {
  RECOVERY_OPERATIONS,
  requireBackendHandshake,
  SINGLE_PHOTO_OPERATIONS,
  WORKFLOW_COPY_RECONCILIATION_OPERATION,
} from "./backend-handshake.js";
import { ingestPair } from "./ingest.js";
import {
  applyMaskFeedback,
  correctionsMatch,
  findUnpreservableCorrection,
  isOwnedCorrection,
  maskBackendSupport,
  maskOwnerPrefix,
  masksFingerprint,
  mergeMaskCorrections,
  partitionMasksForApply,
  sidecarMaskEvidence,
  type MaskBackendSupport,
} from "./masks.js";
import { createSanitizedPreview } from "./preview.js";
import {
  dropUnreadableOperations,
  resolveLightroomSettings,
  translateIntent,
  checkpointKeysFor,
} from "./translator.js";
import {
  CodexInputRequiredError,
  CODEX_PROMPT_HASH,
  CODEX_PROMPT_VERSION,
  CodexProvider,
  writeCodexAnalysisRequest,
} from "./providers.js";
import { acquireMutationLock, SessionStore } from "./runtime.js";
import {
  BackendPhotoIdentitySchema,
  BackendPhotoStateSchema,
  NormalizedEditPlanSchema,
  NormalizedMaskSchema,
  DevelopIterationIntentSchema,
  CheckpointEvidenceSchema,
  DevelopReadbackEvidenceSchema,
  EvaluationResultSchema,
  MaskDecisionSchema,
  MaskRestoreEvidenceSchema,
  MaskWriteIntentSchema,
  MaskWriteResultSchema,
  RecoveryEvidenceSchema,
  WorkflowCopyIntentSchema,
  WorkflowCopyResultSchema,
  WorkflowCopyVerificationSchema,
} from "./schemas.js";
import type {
  BackendAdapter,
  BackendCapabilityManifest,
  BackendPhotoIdentity,
  CheckpointEvidence,
  DevelopIterationIntent,
  DevelopReadbackEvidence,
  BackendPhotoState,
  EditEvaluator,
  EvaluationInput,
  EvaluationResult,
  LightroomMaskCorrection,
  MaskDecision,
  MaskPolicy,
  MaskWriteIntent,
  MaskWriteResult,
  NormalizedMask,
  NormalizedEditPlan,
  ProviderResult,
  RecoveryEvidence,
  SourceAssetPair,
  WorkflowOptions,
  WorkflowCopyIntent,
  WorkflowCopyResult,
  WorkflowCopyVerification,
  WorkflowResult,
} from "./types.js";

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export function sameDevelopSettings(
  left: Record<string, number | string | boolean>,
  right: Record<string, number | string | boolean>,
): boolean {
  // Under "As Shot", Lightroom fills Temperature/Tint lazily (after a render),
  // so the key can appear between two reads with no edit. A real white-balance
  // edit switches WhiteBalance away from "As Shot" and still counts as a change.
  const asShot = left.WhiteBalance === "As Shot" && right.WhiteBalance === "As Shot";
  const lazyKey = (key: string, other: Record<string, unknown>) =>
    asShot && (key === "Temperature" || key === "Tint") && other[key] === undefined;
  const entries = (side: Record<string, number | string | boolean>, other: typeof side) =>
    Object.entries(side)
      .filter(([key]) => !lazyKey(key, other))
      .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left, right)) === JSON.stringify(entries(right, left));
}

function samePhotoIdentity(
  left: BackendPhotoIdentity | undefined,
  right: BackendPhotoIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.catalog_id === right.catalog_id &&
    left.uuid === right.uuid &&
    left.master_id === right.master_id &&
    left.master_uuid === right.master_uuid &&
    left.is_virtual_copy === right.is_virtual_copy
  );
}

function isRecordedMaster(
  candidate: BackendPhotoIdentity | undefined,
  master: BackendPhotoIdentity,
): boolean {
  return samePhotoIdentity(candidate, master) && !candidate!.is_virtual_copy;
}

function isCopyOfMaster(
  candidate: BackendPhotoIdentity | undefined,
  master: BackendPhotoIdentity,
): boolean {
  return (
    candidate?.is_virtual_copy === true &&
    candidate.catalog_id !== master.catalog_id &&
    candidate.uuid !== master.uuid &&
    candidate.master_id === master.catalog_id &&
    candidate.master_uuid === master.uuid
  );
}

function workflowCopyResultMatchesIntent(
  result: WorkflowCopyResult,
  intent: WorkflowCopyIntent,
): boolean {
  return (
    result.operation_id === intent.operation_id &&
    (result.source === undefined || isRecordedMaster(result.source, intent.source)) &&
    (result.master === undefined || isRecordedMaster(result.master, intent.source)) &&
    (result.copy === undefined || isCopyOfMaster(result.copy, intent.source))
  );
}

function workflowCopyResultIsComplete(result: WorkflowCopyResult): boolean {
  return (
    result.result !== "REVIEW_REQUIRED" &&
    !result.partial &&
    result.source !== undefined &&
    result.master !== undefined &&
    result.copy !== undefined &&
    result.selection_restoration.status !== "failed" &&
    result.selection_restoration.verified
  );
}

function supportsReadOnlyWorkflowCopyReconciliation(manifest: BackendCapabilityManifest): boolean {
  const semantics = manifest.operations[WORKFLOW_COPY_RECONCILIATION_OPERATION];
  return Boolean(
    manifest.capabilities.includes(WORKFLOW_COPY_RECONCILIATION_OPERATION) &&
    semantics?.supported === true &&
    semantics.side_effect === "read_only" &&
    semantics.idempotent &&
    semantics.scope === "catalog" &&
    !semantics.requires_active_selection &&
    !semantics.requires_editor_foreground &&
    semantics.concurrency === "exclusive_backend" &&
    semantics.retry_policy === "automatic" &&
    semantics.safe_to_resume,
  );
}

function hasEffectiveSettings(
  current: Record<string, number | string | boolean>,
  requested: Record<string, number | string | boolean>,
): boolean {
  return Object.entries(requested).some(
    ([key, value]) => key !== "WhiteBalance" && current[key] !== value,
  );
}

function emptyPlan(): NormalizedEditPlan {
  return translateIntent({
    schema_version: "0.1.0",
    creative_goal: "pending",
    adjustments: [],
    overall_confidence: 0,
  });
}

function resultFor(
  session: SessionStore,
  normalizedPlan: NormalizedEditPlan,
  extra: {
    renderPath?: string;
    handoffPath?: string;
    iterations?: number;
    evaluationRequestPath?: string;
  } = {},
): WorkflowResult {
  return {
    sessionDir: session.dir,
    state: session.currentState,
    manifest: session.currentManifest,
    normalizedPlan,
    ...(extra.renderPath ? { renderPath: extra.renderPath } : {}),
    ...(extra.handoffPath ? { handoffPath: extra.handoffPath } : {}),
    ...(extra.iterations !== undefined ? { iterations: extra.iterations } : {}),
    ...(extra.evaluationRequestPath ? { evaluationRequestPath: extra.evaluationRequestPath } : {}),
  };
}

async function writeProviderArtifacts(
  session: SessionStore,
  result: ProviderResult,
): Promise<void> {
  await session.writeJson("semantic-intent.json", result.intent);
  await session.updateManifest({
    provider: {
      name: result.metadata.provider,
      model: result.metadata.model,
      prompt_version: result.metadata.promptVersion,
      prompt_hash: result.metadata.promptHash,
      cloud_preview: result.metadata.cloudPreview,
      ...(result.metadata.responseId ? { response_id: result.metadata.responseId } : {}),
      ...(result.metadata.usage
        ? {
            usage: {
              ...(result.metadata.usage.inputTokens !== undefined
                ? { input_tokens: result.metadata.usage.inputTokens }
                : {}),
              ...(result.metadata.usage.outputTokens !== undefined
                ? { output_tokens: result.metadata.usage.outputTokens }
                : {}),
              ...(result.metadata.usage.totalTokens !== undefined
                ? { total_tokens: result.metadata.usage.totalTokens }
                : {}),
            },
          }
        : {}),
    },
  });
}

type PlanExecutionOptions = {
  backend: BackendAdapter;
  sessionRoot: string;
  apply: boolean;
  evaluator?: EditEvaluator;
  maxIterations?: number;
  maskPolicy?: MaskPolicy;
  copySetup?: CopySetup;
};

/** What to do to a freshly verified Workflow Copy before the first edit. */
export type CopySetup = {
  /** Rename the Copy to "v1", "v2", ... (default true when the backend can). */
  versionNames?: boolean;
  /** Apply this develop preset first; it carries the photo's recipe profile. */
  recipePreset?: { presetName: string; profileName: string };
};

export type CopySetupRecord = {
  name: { result: string; copy_name?: string; reason?: string };
  recipe?: { result: "applied" | "failed"; preset: string; profile: string; error?: string };
};

/**
 * Name the Copy and apply the recipe preset. Neither may stop the edit: a
 * failure is recorded and shown in the report, and the photo continues with
 * the marker name or without the recipe look.
 */
async function prepareWorkflowCopy(
  session: SessionStore,
  backend: BackendAdapter,
  masterPhotoId: string,
  copy: { catalog_id: string; uuid: string },
  operationId: string,
  setup: CopySetup,
): Promise<CopySetupRecord> {
  const record: CopySetupRecord = { name: { result: "skipped" } };
  const canRename =
    backend.capabilities.capabilities.includes(RENAME_COPY_OPERATION) &&
    backend.renameWorkflowCopy !== undefined &&
    backend.listCopyNames !== undefined;
  if (setup.versionNames === false) {
    record.name = { result: "disabled" };
  } else if (!canRename) {
    record.name = { result: "unsupported", reason: "backend_cannot_rename_copies" };
  } else {
    try {
      const marker = workflowCopyMarker(operationId);
      const names = (await backend.listCopyNames!(masterPhotoId)).filter((name) => name !== marker);
      const wanted = nextCopyVersionName(names);
      const renamed = await backend.renameWorkflowCopy!(copy.catalog_id, copy.uuid, marker, wanted);
      record.name = {
        result: renamed.result,
        ...(renamed.copy_name ? { copy_name: renamed.copy_name } : {}),
        ...(renamed.reason ? { reason: renamed.reason } : {}),
      };
    } catch (error) {
      record.name = {
        result: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (setup.recipePreset) {
    const { presetName, profileName } = setup.recipePreset;
    try {
      if (
        !backend.capabilities.capabilities.includes(APPLY_PRESET_OPERATION) ||
        !backend.applyDevelopPreset
      ) {
        throw new Error("backend cannot apply develop presets");
      }
      await backend.applyDevelopPreset(copy.catalog_id, presetName);
      record.recipe = { result: "applied", preset: presetName, profile: profileName };
    } catch (error) {
      record.recipe = {
        result: "failed",
        preset: presetName,
        profile: profileName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  await session.writeJson("workflow-copy-setup.json", record);
  return record;
}

type MaskMode = MaskDecision["mode"];

async function decideMaskMode(
  support: MaskBackendSupport,
  requested: readonly NormalizedMask[],
  rawPath: string,
  policy: MaskPolicy,
): Promise<{ mode: MaskMode; reason?: string }> {
  if (requested.length === 0) return { mode: "none" };
  if (support === "unsupported") {
    return { mode: "degraded_to_global", reason: "backend_does_not_support_geometric_masks" };
  }
  if (support === "read_write") return { mode: "merge_readback" };
  if (!policy.allowUnverifiedReplace) {
    return {
      mode: "degraded_to_global",
      reason: "backend_cannot_read_existing_masks_and_replace_not_allowed",
    };
  }
  const sidecar = await sidecarMaskEvidence(rawPath);
  if (sidecar === "present") {
    return { mode: "degraded_to_global", reason: "existing_masks_detected_in_xmp_sidecar" };
  }
  if (sidecar === "unreadable") {
    return { mode: "degraded_to_global", reason: "xmp_sidecar_unreadable" };
  }
  return { mode: "replace_unverified" };
}

async function executePlan(
  session: SessionStore,
  source: SourceAssetPair,
  photoId: string,
  normalizedPlan: NormalizedEditPlan,
  options: PlanExecutionOptions,
): Promise<WorkflowResult> {
  if (!options.apply) {
    await session.transition("REVIEW_REQUIRED", { reason: "apply_not_requested" });
    return resultFor(session, normalizedPlan);
  }
  const maskPolicy = options.maskPolicy ?? {};
  const maskPartition = partitionMasksForApply(normalizedPlan.masks ?? [], {
    unattended: maskPolicy.unattended === true,
    approvedMaskIds: maskPolicy.approvedMaskIds ?? [],
  });
  if (normalizedPlan.operations.length === 0 && maskPartition.apply.length === 0) {
    await session.transition("REVIEW_REQUIRED", {
      reason:
        maskPartition.pending.length > 0
          ? "mask_placement_requires_user_confirmation"
          : "no_executable_operations",
      ...(maskPartition.pending.length > 0
        ? { pending_mask_ids: maskPartition.pending.map((mask) => mask.id) }
        : {}),
    });
    return resultFor(session, normalizedPlan);
  }
  const maxIterations = options.maxIterations ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) {
    await session.transition("FAILED", {
      error: "maxIterations must be an integer from 1 to 10",
    });
    return resultFor(session, normalizedPlan);
  }

  let sideEffectStarted = false;
  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  try {
    unlock = await acquireMutationLock(
      join(options.sessionRoot, `${options.backend.name}.mutation.lock`),
      {
        backend: options.backend.name,
        sessionId: session.currentManifest.session_id,
      },
    );
    await options.backend.connect();
    connected = true;
    const backendManifest = await requireBackendHandshake(options.backend, SINGLE_PHOTO_OPERATIONS);
    await session.updateManifest({
      backend: { name: backendManifest.backend, version: backendManifest.version },
    });
    let targetPhotoId = photoId;
    if (photoId === source.raw_path && options.backend.resolvePhotoId) {
      targetPhotoId = (await options.backend.resolvePhotoId(source.raw_path)) ?? photoId;
    }
    const master = await options.backend.readCurrentEdit(targetPhotoId);
    let current = master;
    if (!master.identity) {
      await session.transition("REVIEW_REQUIRED", { reason: "source_identity_uncertain" });
      return resultFor(session, normalizedPlan);
    }
    if (master.identity.is_virtual_copy) {
      await session.transition("REVIEW_REQUIRED", { reason: "source_is_virtual_copy" });
      return resultFor(session, normalizedPlan);
    }
    if (
      master.identity.catalog_id !== master.photo_id ||
      master.identity.master_id !== master.identity.catalog_id ||
      master.identity.master_uuid !== master.identity.uuid
    ) {
      await session.transition("REVIEW_REQUIRED", { reason: "source_identity_uncertain" });
      return resultFor(session, normalizedPlan);
    }
    if (!samePath(current.path, source.raw_path)) {
      throw new Error(
        `Lightroom photo path mismatch; refusing mutation: ${current.path} <> ${source.raw_path}`,
      );
    }
    let readable = dropUnreadableOperations(master.develop_settings, normalizedPlan);
    normalizedPlan = readable.plan;
    if (readable.skipped.length > 0) {
      await session.appendEvent(session.currentState, { skipped_operations: readable.skipped });
    }
    if (normalizedPlan.operations.length === 0 && maskPartition.apply.length === 0) {
      await session.transition("REVIEW_REQUIRED", {
        reason: "no_executable_operations",
        skipped_operations: readable.skipped,
      });
      return resultFor(session, normalizedPlan);
    }
    let initialSettings: Record<string, number | string | boolean>;
    try {
      initialSettings = resolveLightroomSettings(master.develop_settings, normalizedPlan);
    } catch (error) {
      await session.transition("REVIEW_REQUIRED", {
        reason: "no_executable_operations",
        error: error instanceof Error ? error.message : String(error),
      });
      return resultFor(session, normalizedPlan);
    }
    const maskSupport = maskBackendSupport(backendManifest, options.backend);
    const maskChoice = await decideMaskMode(
      maskSupport,
      maskPartition.apply,
      source.raw_path,
      maskPolicy,
    );
    let maskMode = maskChoice.mode;
    let maskReason = maskChoice.reason;
    let activeMasks: NormalizedMask[] =
      maskMode === "merge_readback" || maskMode === "replace_unverified"
        ? [...maskPartition.apply]
        : [];
    const recordMaskDecision = async (preserved: number): Promise<MaskDecision> => {
      const decision = MaskDecisionSchema.parse({
        requested_mask_ids: (normalizedPlan.masks ?? []).map((mask) => mask.id),
        applied_mask_ids: activeMasks.map((mask) => mask.id),
        pending_review_mask_ids: maskPartition.pending.map((mask) => mask.id),
        mode: maskMode,
        backend_support: maskSupport,
        ...(maskReason ? { reason: maskReason } : {}),
        preserved_foreign_corrections: preserved,
      });
      if ((normalizedPlan.masks ?? []).length > 0) {
        await session.writeJson("masks/mask-decision.json", decision);
        if (maskMode === "degraded_to_global") {
          await session.appendEvent(session.currentState, { mask_degraded_to_global: maskReason });
        }
      }
      return decision;
    };
    const maskDecision = await recordMaskDecision(0);
    const globalEffective = hasEffectiveSettings(master.develop_settings, initialSettings);
    if (!globalEffective && activeMasks.length === 0) {
      await session.transition("REVIEW_REQUIRED", {
        reason: maskReason ?? "no_effective_adjustments",
      });
      return resultFor(session, normalizedPlan);
    }
    const operationId = `photoagent-vc-${session.currentManifest.session_id}`;
    const workflowCopyIntent = WorkflowCopyIntentSchema.parse({
      schema_version: "0.1.0",
      operation_id: operationId,
      phase: "started",
      source: master.identity,
    });
    await session.writeJson("workflow-copy-intent.json", workflowCopyIntent);
    sideEffectStarted = true;
    const workflowCopy = await options.backend.createWorkflowCopy(
      master.identity.catalog_id,
      master.identity.uuid,
      operationId,
    );
    await session.writeJson("workflow-copy.json", workflowCopy);
    const envelopeVerified =
      workflowCopyResultMatchesIntent(workflowCopy, workflowCopyIntent) &&
      workflowCopyResultIsComplete(workflowCopy);
    if (
      workflowCopy.result === "REVIEW_REQUIRED" ||
      !workflowCopy.copy ||
      workflowCopy.partial ||
      !envelopeVerified
    ) {
      await session.transition("REVIEW_REQUIRED", {
        reason:
          workflowCopy.reason ??
          (envelopeVerified ? "workflow_copy_requires_review" : "workflow_copy_envelope_mismatch"),
        operation_id: operationId,
      });
      return resultFor(session, normalizedPlan);
    }
    const copyState = await options.backend.readCurrentEdit(workflowCopy.copy.catalog_id);
    const copyIdentity = copyState.identity;
    const copyVerified =
      copyState.photo_id === workflowCopy.copy.catalog_id &&
      samePhotoIdentity(copyIdentity, workflowCopy.copy) &&
      isCopyOfMaster(copyIdentity, master.identity) &&
      samePath(copyState.path, master.path) &&
      sameDevelopSettings(copyState.develop_settings, master.develop_settings);
    const workflowCopyVerification = WorkflowCopyVerificationSchema.parse({
      operation_id: operationId,
      verified: copyVerified,
      master: master.identity,
      copy: copyIdentity ?? null,
      inherited_develop_state: sameDevelopSettings(
        copyState.develop_settings,
        master.develop_settings,
      ),
    });
    await session.writeJson("workflow-copy-verification.json", workflowCopyVerification);
    if (!copyVerified) {
      await session.transition("REVIEW_REQUIRED", {
        reason: "workflow_copy_identity_or_inheritance_mismatch",
        operation_id: operationId,
      });
      return resultFor(session, normalizedPlan);
    }
    current = copyState;
    const setupRecord = await prepareWorkflowCopy(
      session,
      options.backend,
      master.identity.catalog_id,
      workflowCopy.copy,
      operationId,
      options.copySetup ?? {},
    );
    if (setupRecord.recipe?.result === "applied") {
      // The recipe preset sets only the profile; re-read so every later
      // comparison starts from the Copy as it now is.
      current = await options.backend.readCurrentEdit(workflowCopy.copy.catalog_id);
    }
    // Lightroom reports Temperature/Tint under "As Shot" only after a render, so
    // the Copy can lack a value the Master had. Decide on the Copy that is edited.
    const onCopy = dropUnreadableOperations(current.develop_settings, normalizedPlan);
    if (onCopy.skipped.length > 0) {
      normalizedPlan = onCopy.plan;
      readable = { plan: onCopy.plan, skipped: [...readable.skipped, ...onCopy.skipped] };
      await session.appendEvent(session.currentState, { skipped_operations: readable.skipped });
      initialSettings = resolveLightroomSettings(current.develop_settings, normalizedPlan);
      if (
        !hasEffectiveSettings(current.develop_settings, initialSettings) &&
        activeMasks.length === 0
      ) {
        await session.transition("REVIEW_REQUIRED", {
          reason: "no_executable_operations",
          skipped_operations: readable.skipped,
        });
        return resultFor(session, normalizedPlan);
      }
    }
    const activePhotoId = workflowCopy.copy.catalog_id;
    const ownerPrefix = maskOwnerPrefix(session.currentManifest.session_id);
    const loopState: LoopState = {
      iteration: 1,
      maxIterations,
      activePhotoId,
      copyIdentity: copyIdentity!,
      current,
      initialSettings,
      activePlan: normalizedPlan,
      activeMasks,
      maskMode,
      ...(maskReason ? { maskReason } : {}),
      maskSupport,
      maskPolicy,
      requestedMaskIds: maskDecision.requested_mask_ids,
      pendingReviewMaskIds: maskDecision.pending_review_mask_ids,
      knownMasks: [],
      knownMasksStatus: "unverified_assumed_empty",
      writtenMaskFingerprint: masksFingerprint([]),
      preservedForeign: 0,
      maskNotes: [],
      skippedOperations: readable.skipped,
      evaluatorCalls: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      elapsedMs: 0,
    };
    const ctx: LoopContext = {
      session,
      backend: options.backend,
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      normalizedPlan,
      ownerPrefix,
      markSideEffect: () => {
        sideEffectStarted = true;
      },
    };
    if (loopState.maskMode === "merge_readback") {
      // Read what the copy inherited from the Master before deciding to write.
      const inherited = await options.backend.readMaskCorrections!(activePhotoId);
      if (inherited.status === "absent") {
        const fallback = await decideMaskMode(
          "write_only",
          loopState.activeMasks,
          source.raw_path,
          maskPolicy,
        );
        loopState.maskMode = fallback.mode;
        loopState.maskReason = `mask_readback_absent${fallback.reason ? `:${fallback.reason}` : ""}`;
      } else if (inherited.status === "unreadable") {
        loopState.maskMode = "degraded_to_global";
        loopState.maskReason = inherited.detail
          ? `existing_masks_unreadable: ${inherited.detail}`
          : "existing_masks_unreadable";
      } else {
        const unpreservable = findUnpreservableCorrection(
          inherited.corrections.filter((correction) => !isOwnedCorrection(correction, ownerPrefix)),
        );
        if (unpreservable) {
          loopState.maskMode = "degraded_to_global";
          loopState.maskReason = `existing_masks_cannot_be_preserved: ${unpreservable}`;
        } else {
          loopState.knownMasks = inherited.corrections;
          loopState.knownMasksStatus = "read_back";
        }
      }
      maskMode = loopState.maskMode;
      maskReason = loopState.maskReason;
      if (loopState.maskMode === "degraded_to_global") {
        loopState.activeMasks = [];
        activeMasks = [];
        await recordMaskDecision(0);
        if (!globalEffective) {
          await session.transition("REVIEW_REQUIRED", {
            reason: loopState.maskReason ?? "mask_degraded_without_global_adjustments",
            operation_id: operationId,
          });
          return resultFor(session, normalizedPlan);
        }
      } else if (loopState.maskMode === "replace_unverified") {
        await recordMaskDecision(0);
      }
    }
    return await runClosedLoop(ctx, loopState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.writeJson("error.json", { message, side_effect_started: sideEffectStarted });
    if (sideEffectStarted && session.currentState !== "REVIEW_REQUIRED") {
      await session.transition("REVIEW_REQUIRED", {
        reason: "uncertain_backend_state",
        error: message,
      });
    } else if (session.currentState !== "FAILED" && session.currentState !== "REVIEW_REQUIRED") {
      await session.transition("FAILED", { error: message });
    }
    return resultFor(session, normalizedPlan);
  } finally {
    if (connected) await options.backend.close();
    if (unlock) await unlock();
  }
}

type LoopContext = {
  session: SessionStore;
  backend: BackendAdapter;
  evaluator?: EditEvaluator;
  normalizedPlan: NormalizedEditPlan;
  ownerPrefix: string;
  markSideEffect: () => void;
};

/**
 * Everything the closed loop needs to continue after a pause. It is written to
 * `loop-state.json` when the loop waits for an agent-written evaluation, so a
 * later `continue` resumes on the same verified Workflow Copy.
 */
const LoopStateSchema = z
  .object({
    iteration: z.number().int().positive(),
    maxIterations: z.number().int().min(1).max(10),
    activePhotoId: z.string().min(1),
    copyIdentity: BackendPhotoIdentitySchema,
    current: BackendPhotoStateSchema,
    initialSettings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    activePlan: NormalizedEditPlanSchema,
    activeMasks: z.array(NormalizedMaskSchema),
    maskMode: z.enum(["none", "merge_readback", "replace_unverified", "degraded_to_global"]),
    maskReason: z.string().optional(),
    maskSupport: z.enum(["read_write", "write_only", "unsupported"]),
    maskPolicy: z
      .object({
        unattended: z.boolean().optional(),
        approvedMaskIds: z.union([z.array(z.string()), z.literal("all")]).optional(),
        allowUnverifiedReplace: z.boolean().optional(),
      })
      .strict(),
    requestedMaskIds: z.array(z.string()),
    pendingReviewMaskIds: z.array(z.string()),
    knownMasks: z.array(z.record(z.string(), z.unknown())),
    knownMasksStatus: z.enum(["read_back", "written_by_this_session", "unverified_assumed_empty"]),
    writtenMaskFingerprint: z.string(),
    preservedForeign: z.number().int().nonnegative(),
    maskNotes: z.array(z.string()),
    // Optional so loop states saved before this field existed still resume.
    skippedOperations: z.array(z.string()).optional(),
    previousRenderHash: z.string().optional(),
    previousPlanHash: z.string().optional(),
    evaluatorCalls: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    elapsedMs: z.number().nonnegative(),
    paused: z
      .object({
        iteration: z.number().int().positive(),
        checkpointName: z.string().min(1),
        renderPath: z.string().min(1),
        readBack: BackendPhotoStateSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

type LoopState = z.infer<typeof LoopStateSchema>;

async function writeMasksIfChanged(
  ctx: LoopContext,
  state: LoopState,
  iteration: number,
): Promise<"ok" | "mismatch"> {
  if (state.maskMode !== "merge_readback" && state.maskMode !== "replace_unverified") return "ok";
  const fingerprint = masksFingerprint(state.activeMasks);
  if (fingerprint === state.writtenMaskFingerprint) return "ok";
  const { backend, session } = ctx;
  if (state.maskMode === "merge_readback") {
    const fresh = await backend.readMaskCorrections!(state.activePhotoId);
    if (fresh.status !== "ok") {
      throw new Error("Mask readback became unavailable before a merge write; refusing to write");
    }
    state.knownMasks = fresh.corrections;
    state.knownMasksStatus = "read_back";
  }
  const merged = mergeMaskCorrections(state.knownMasks, state.activeMasks, ctx.ownerPrefix);
  state.preservedForeign = merged.preservedForeign;
  const maskOperationId = `photoagent-masks-${session.currentManifest.session_id}-${iteration}`;
  const intent = MaskWriteIntentSchema.parse({
    schema_version: "0.1.0",
    operation_id: maskOperationId,
    kind: "mask_write",
    phase: "started",
    iteration,
    target: state.copyIdentity,
    mode: state.maskMode,
    owner_prefix: ctx.ownerPrefix,
    before: state.knownMasksStatus === "unverified_assumed_empty" ? null : state.knownMasks,
    before_status: state.knownMasksStatus,
    requested: merged.corrections,
    applied_mask_ids: state.activeMasks.map((mask) => mask.id),
  });
  await session.writeJson(`masks/iteration-${iteration}-intent.json`, intent);
  ctx.markSideEffect();
  await backend.applyMaskCorrections!(state.activePhotoId, merged.corrections);
  let readBack: LightroomMaskCorrection[] | null = null;
  let readbackStatus: MaskWriteResult["readback_status"] = "unavailable";
  if (state.maskSupport === "read_write") {
    const after = await backend.readMaskCorrections!(state.activePhotoId);
    readBack = after.corrections;
    readbackStatus =
      (after.status === "ok" || merged.corrections.length === 0) &&
      correctionsMatch(merged.corrections, after.corrections)
        ? "verified"
        : "mismatch";
  }
  await session.writeJson(
    `masks/iteration-${iteration}-result.json`,
    MaskWriteResultSchema.parse({
      operation_id: maskOperationId,
      iteration,
      readback_status: readbackStatus,
      read_back: readBack,
    }),
  );
  state.knownMasks = readBack ?? merged.corrections;
  state.knownMasksStatus = readbackStatus === "verified" ? "read_back" : "written_by_this_session";
  state.writtenMaskFingerprint = fingerprint;
  return readbackStatus === "mismatch" ? "mismatch" : "ok";
}

async function finishLoopReport(
  ctx: LoopContext,
  state: LoopState,
  segmentStartedAt: number,
  iterations: number,
  reason: string,
): Promise<void> {
  await ctx.session.writeJson("iteration-report.json", {
    evaluator: ctx.evaluator?.name ?? null,
    iterations,
    evaluator_calls: state.evaluatorCalls,
    total_tokens: state.totalTokens,
    estimated_cost_usd: Number(state.estimatedCostUsd.toFixed(6)),
    elapsed_ms: state.elapsedMs + (Date.now() - segmentStartedAt),
    terminal_state: ctx.session.currentState,
    reason,
    masks: {
      mode: state.maskMode,
      backend_support: state.maskSupport,
      ...(state.maskReason ? { degrade_reason: state.maskReason } : {}),
      requested: state.requestedMaskIds,
      final_applied: state.activeMasks.map((mask) => mask.id),
      pending_review: state.pendingReviewMaskIds,
      preserved_foreign_corrections: state.preservedForeign,
      notes: state.maskNotes,
    },
    skipped_operations: state.skippedOperations ?? [],
  });
}

function evaluationRequestMarkdown(
  session: SessionStore,
  state: LoopState,
  input: EvaluationInput,
  inputPath: string,
): string {
  return [
    `# photo-agent evaluation request: iteration ${input.iteration}`,
    "",
    "The edit was applied to the photo-agent Workflow Copy and rendered. Look at the render, judge it, and write one `EvaluationResult` JSON object. Do not change Lightroom yourself.",
    "",
    `- Render to inspect: \`${input.renderPath}\``,
    `- Original preview (before): \`${session.currentManifest.source.preview_path}\``,
    `- Write the evaluation JSON to: \`${inputPath}\``,
    `- Iteration ${input.iteration} of at most ${state.maxIterations}`,
    "",
    "## What was applied",
    "",
    describeEvaluationInput(input),
    "",
    "## Rules",
    "",
    EVALUATION_PROMPT,
    "",
    "## JSON contract",
    "",
    '`{"schema_version": "0.2.0", "verdict": "accept" | "refine" | "review", "confidence": 0-1, "rationale": "...", "issues": ["..."], "refinement_plan"?: {"schema_version": "0.1.0", "operations": [{"parameter": "exposure_ev" | "temperature_k" | "tint" | "contrast" | "highlights" | "shadows" | "whites" | "blacks" | "texture" | "clarity" | "dehaze" | "vibrance" | "saturation", "mode": "delta", "value": number, "confidence": 0-1, "rationale": "..."}], "warnings": []}, "mask_feedback"?: [{"mask_id": "...", "assessment": "ok" | "too_strong" | "misplaced" | "unnecessary", "note": "..."}]}`',
    "",
    "`refine` requires `refinement_plan` (small global deltas relative to the current edit; exposure_ev in EV, temperature_k in Kelvin, others in Lightroom slider units). `accept` requires every mask_feedback entry to be `ok`.",
    "",
    "## Continue",
    "",
    `\`node dist/src/cli.js continue --session "${session.dir}" --evaluation-file "${inputPath}" --backend lightroom\``,
    "(In a batch, run `batch --resume <BATCH_DIR>` instead; it picks the file up automatically.)",
    "",
  ].join("\n");
}

/**
 * The closed loop: apply -> render -> evaluate -> (accept | refine | review).
 * With `resumeWith`, the loop starts at the paused iteration's evaluation.
 */
async function runClosedLoop(
  ctx: LoopContext,
  state: LoopState,
  resumeWith?: EvaluationResult,
): Promise<WorkflowResult> {
  const { session, backend } = ctx;
  const segmentStartedAt = Date.now();
  const finish = (iterations: number, reason: string) =>
    finishLoopReport(ctx, state, segmentStartedAt, iterations, reason);
  let pendingResume = resumeWith;

  for (;;) {
    let iteration: number;
    let checkpointName: string;
    let renderPath: string;
    let readBack: BackendPhotoState;
    let evaluation: EvaluationResult;

    if (pendingResume) {
      if (!state.paused) throw new Error("Loop state has no paused iteration to continue");
      ({ iteration, checkpointName, renderPath, readBack } = state.paused);
      evaluation = pendingResume;
      pendingResume = undefined;
      delete state.paused;
      await session.transition("EVALUATING", { iteration, render: renderPath, resumed: true });
    } else {
      iteration = state.iteration;
      if (iteration > 1) {
        const readable = dropUnreadableOperations(state.current.develop_settings, state.activePlan);
        if (readable.skipped.length > 0) {
          state.activePlan = readable.plan;
          state.skippedOperations = [
            ...(state.skippedOperations ?? []),
            ...readable.skipped.map((note) => `iteration ${iteration}: ${note}`),
          ];
        }
      }
      const settings =
        iteration === 1
          ? state.initialSettings
          : resolveLightroomSettings(state.current.develop_settings, state.activePlan);
      checkpointName = `PhotoAgent_${session.currentManifest.session_id}_iteration_${iteration}_before`;
      const iterationOperationId = `photoagent-iteration-${session.currentManifest.session_id}-${iteration}`;
      await session.transition("APPLYING", { checkpoint: checkpointName, iteration });
      const iterationIntent = DevelopIterationIntentSchema.parse({
        schema_version: "0.1.0",
        operation_id: iterationOperationId,
        kind: "develop_iteration",
        phase: "started",
        iteration,
        target: state.copyIdentity,
        checkpoint_name: checkpointName,
        requested_settings: settings,
      });
      await session.writeJson(`operations/iteration-${iteration}-intent.json`, iterationIntent);
      const checkpoint = await backend.createCheckpoint(
        state.activePhotoId,
        checkpointName,
        checkpointKeysFor(state.current.develop_settings, settings),
      );
      const checkpointEvidence = CheckpointEvidenceSchema.parse({
        iteration,
        operation_id: iterationOperationId,
        target: state.copyIdentity,
        checkpoint_name: checkpointName,
        checkpoint,
      });
      await session.writeJson(`checkpoints/iteration-${iteration}-before.json`, checkpointEvidence);
      if (iteration === 1) await session.writeJson("checkpoints/before.json", checkpointEvidence);
      ctx.markSideEffect();
      if (Object.keys(settings).length > 0) {
        await backend.applyGlobalAdjustment(state.activePhotoId, settings);
      }
      readBack = await backend.readCurrentEdit(state.activePhotoId);
      const readbackEvidence = DevelopReadbackEvidenceSchema.parse({
        iteration,
        operation_id: iterationOperationId,
        target: state.copyIdentity,
        checkpoint_name: checkpointName,
        requested: settings,
        read_back: readBack.develop_settings,
      });
      await session.writeJson(`backend-readback-iteration-${iteration}.json`, readbackEvidence);
      if (iteration === 1) await session.writeJson("backend-readback.json", readbackEvidence);
      for (const [key, value] of Object.entries(settings)) {
        if (readBack.develop_settings[key] !== value) {
          await session.transition("REVIEW_REQUIRED", {
            reason: "backend_readback_mismatch",
            key,
            iteration,
            rollback_checkpoint: checkpointName,
          });
          await finish(iteration, "backend_readback_mismatch");
          return resultFor(session, ctx.normalizedPlan, { iterations: iteration });
        }
      }
      state.current = readBack;
      if ((await writeMasksIfChanged(ctx, state, iteration)) === "mismatch") {
        await session.transition("REVIEW_REQUIRED", {
          reason: "mask_readback_mismatch",
          iteration,
          rollback_checkpoint: checkpointName,
          mask_restore: `masks/iteration-${iteration}-intent.json`,
        });
        await finish(iteration, "mask_readback_mismatch");
        return resultFor(session, ctx.normalizedPlan, { iterations: iteration });
      }
      await session.transition("RENDERING", { iteration });
      const render = await backend.renderPreview(
        state.activePhotoId,
        join(session.dir, "renders", `iteration-${iteration}`),
      );
      renderPath = render.path;
      await session.writeJson(`render-iteration-${iteration}.json`, render);
      if (iteration === 1) await session.writeJson("render.json", render);
      if (!ctx.evaluator) {
        await session.transition("REVIEW_REQUIRED", {
          reason: "visual_evaluator_not_configured",
          render: renderPath,
          rollback_checkpoint: checkpointName,
        });
        await finish(iteration, "visual_evaluator_not_configured");
        return resultFor(session, ctx.normalizedPlan, { renderPath, iterations: iteration });
      }

      await session.transition("EVALUATING", { iteration, render: renderPath });
      const evaluationPath = ctx.evaluator.requiresCloudPreview
        ? join(session.dir, "evaluations", `iteration-${iteration}-analysis.jpg`)
        : renderPath;
      if (ctx.evaluator.requiresCloudPreview) {
        await createSanitizedPreview(renderPath, evaluationPath);
      }
      const evaluationInput: EvaluationInput = {
        renderPath: evaluationPath,
        iteration,
        normalizedPlan: state.activePlan,
        readBack,
        ...(state.activeMasks.length > 0 ? { masks: state.activeMasks } : {}),
      };
      try {
        evaluation = EvaluationResultSchema.parse(await ctx.evaluator.evaluate(evaluationInput));
      } catch (error) {
        if (!(error instanceof EvaluationInputRequiredError)) throw error;
        const inputPath = join(session.dir, "evaluations", `iteration-${iteration}-input.json`);
        const requestPath = join(session.dir, "evaluations", `iteration-${iteration}-request.md`);
        state.paused = { iteration, checkpointName, renderPath, readBack };
        state.elapsedMs += Date.now() - segmentStartedAt;
        await session.writeJson("loop-state.json", LoopStateSchema.parse(state));
        await mkdir(dirname(requestPath), { recursive: true });
        await writeFile(
          requestPath,
          evaluationRequestMarkdown(session, state, evaluationInput, inputPath),
          "utf8",
        );
        await session.transition("EVALUATION_INPUT_REQUIRED", {
          iteration,
          render: renderPath,
          request: requestPath,
          evaluation_file: inputPath,
        });
        return resultFor(session, ctx.normalizedPlan, {
          renderPath,
          iterations: iteration,
          evaluationRequestPath: requestPath,
        });
      }
    }

    state.evaluatorCalls += evaluation.usage?.evaluator_calls ?? 1;
    state.totalTokens += evaluation.usage?.total_tokens ?? 0;
    state.estimatedCostUsd += evaluation.usage?.estimated_cost_usd ?? 0;
    await session.writeJson(`evaluations/iteration-${iteration}.json`, evaluation);

    const feedback = applyMaskFeedback(state.activeMasks, evaluation.mask_feedback, {
      removeMisplaced: state.maskPolicy.unattended === true,
    });
    if (feedback.notes.length > 0) {
      state.maskNotes.push(...feedback.notes.map((note) => `iteration ${iteration}: ${note}`));
      await session.writeJson(`masks/iteration-${iteration}-feedback.json`, {
        iteration,
        feedback: evaluation.mask_feedback ?? [],
        notes: feedback.notes,
        next_mask_ids: feedback.masks.map((mask) => mask.id),
      });
    }
    if (feedback.misplaced.length > 0 && state.maskPolicy.unattended !== true) {
      await session.transition("REVIEW_REQUIRED", {
        reason: "mask_placement_questioned",
        iteration,
        mask_ids: feedback.misplaced,
        rollback_checkpoint: checkpointName,
        mask_restore: `masks/iteration-${iteration}-intent.json`,
      });
      await finish(iteration, "mask_placement_questioned");
      return resultFor(session, ctx.normalizedPlan, { renderPath, iterations: iteration });
    }

    if (evaluation.confidence < MIN_EVALUATION_CONFIDENCE || evaluation.verdict === "review") {
      await session.transition("REVIEW_REQUIRED", {
        reason:
          evaluation.confidence < MIN_EVALUATION_CONFIDENCE
            ? "low_evaluator_confidence"
            : "evaluator_requested_review",
        iteration,
        rollback_checkpoint: checkpointName,
      });
      await finish(iteration, "human_review_escalation");
      return resultFor(session, ctx.normalizedPlan, { renderPath, iterations: iteration });
    }
    if (evaluation.verdict === "accept") {
      await session.transition("ACCEPTED", { iteration, render: renderPath });
      await finish(iteration, "accepted");
      return resultFor(session, ctx.normalizedPlan, { renderPath, iterations: iteration });
    }

    const nextPlan = evaluation.refinement_plan!;
    const renderHash = await renderFingerprint(renderPath);
    const nextPlanHash = planFingerprint(evaluation);
    const stalled =
      (nextPlan.operations.length === 0 && !feedback.changed) ||
      renderHash === state.previousRenderHash ||
      (!feedback.changed && nextPlanHash !== undefined && nextPlanHash === state.previousPlanHash);
    if (stalled || iteration === state.maxIterations) {
      const reason = stalled ? "closed_loop_stalled" : "iteration_budget_exhausted";
      await session.transition("REVIEW_REQUIRED", {
        reason,
        iteration,
        rollback_checkpoint: checkpointName,
      });
      await finish(iteration, reason);
      return resultFor(session, ctx.normalizedPlan, { renderPath, iterations: iteration });
    }
    state.previousRenderHash = renderHash;
    if (nextPlanHash !== undefined) state.previousPlanHash = nextPlanHash;
    state.activePlan = nextPlan;
    state.activeMasks = feedback.masks;
    state.iteration = iteration + 1;
    await session.transition("REFINING", {
      iteration,
      next_operation_count: nextPlan.operations.length,
      next_mask_ids: state.activeMasks.map((mask) => mask.id),
    });
  }
}

export type ContinueSessionOptions = {
  sessionDir: string;
  evaluationFile: string;
  backend: BackendAdapter;
  sessionRoot?: string;
  /** Evaluator for later iterations; defaults to another agent handoff. */
  evaluator?: EditEvaluator;
};

/**
 * Continue a loop that paused for an agent-written evaluation. The Workflow
 * Copy is re-read and must still match what was rendered; nothing is
 * re-applied for the paused iteration.
 */
export async function continueSession(options: ContinueSessionOptions): Promise<WorkflowResult> {
  const session = await SessionStore.open(options.sessionDir);
  const normalizedPlan = await session
    .readJson<NormalizedEditPlan>("normalized-edit-plan.json")
    .catch(() => emptyPlan());
  if (session.currentState !== "EVALUATION_INPUT_REQUIRED") {
    throw new Error(
      `Session is ${session.currentState}; only EVALUATION_INPUT_REQUIRED sessions can be continued`,
    );
  }
  const state = LoopStateSchema.parse(await session.readJson<unknown>("loop-state.json"));
  const evaluation = EvaluationResultSchema.parse(
    JSON.parse(await readFile(resolve(options.evaluationFile), "utf8")),
  );
  const sessionRoot = options.sessionRoot ?? resolve(session.dir, "..");
  let sideEffectStarted = false;
  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  try {
    unlock = await acquireMutationLock(join(sessionRoot, `${options.backend.name}.mutation.lock`), {
      backend: options.backend.name,
      sessionId: session.currentManifest.session_id,
    });
    await options.backend.connect();
    connected = true;
    const manifest = await requireBackendHandshake(options.backend, SINGLE_PHOTO_OPERATIONS);
    const current = await options.backend.readCurrentEdit(state.activePhotoId);
    const paused = state.paused;
    const unchanged =
      paused !== undefined &&
      samePhotoIdentity(current.identity, state.copyIdentity) &&
      samePath(current.path, session.currentManifest.source.raw_path) &&
      sameDevelopSettings(current.develop_settings, paused.readBack.develop_settings);
    let reason: string | undefined = unchanged ? undefined : "workflow_copy_changed_while_waiting";
    const masksActive =
      state.maskMode === "merge_readback" || state.maskMode === "replace_unverified";
    if (
      !reason &&
      masksActive &&
      maskBackendSupport(manifest, options.backend) !== state.maskSupport
    ) {
      reason = "backend_mask_support_changed_while_waiting";
    }
    if (!reason && masksActive && state.maskSupport === "read_write") {
      const masks = await options.backend.readMaskCorrections!(state.activePhotoId);
      if (
        (masks.status !== "ok" && state.knownMasks.length > 0) ||
        !correctionsMatch(state.knownMasks, masks.corrections)
      ) {
        reason = "workflow_copy_masks_changed_while_waiting";
      }
    }
    if (reason) {
      await session.transition("REVIEW_REQUIRED", { reason, iteration: paused?.iteration });
      return resultFor(session, normalizedPlan);
    }
    await session.writeJson(`evaluations/iteration-${paused!.iteration}-input-source.json`, {
      source: resolve(options.evaluationFile),
      accepted_at: new Date().toISOString(),
    });
    const ctx: LoopContext = {
      session,
      backend: options.backend,
      evaluator: options.evaluator ?? new HandoffEvaluator(),
      normalizedPlan,
      ownerPrefix: maskOwnerPrefix(session.currentManifest.session_id),
      markSideEffect: () => {
        sideEffectStarted = true;
      },
    };
    return await runClosedLoop(ctx, state, evaluation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.writeJson("error.json", { message, side_effect_started: sideEffectStarted });
    const stateAfterError: string = session.currentState;
    if (stateAfterError !== "REVIEW_REQUIRED" && stateAfterError !== "FAILED") {
      if (stateAfterError === "EVALUATION_INPUT_REQUIRED" && !sideEffectStarted) {
        // Nothing changed; leave the session waiting so the agent can retry.
        throw error;
      }
      await session.transition("REVIEW_REQUIRED", {
        reason: sideEffectStarted ? "uncertain_backend_state" : "continue_failed",
        error: message,
      });
    }
    return resultFor(session, normalizedPlan);
  } finally {
    if (connected) await options.backend.close();
    if (unlock) await unlock();
  }
}

export async function runSinglePhoto(options: WorkflowOptions): Promise<WorkflowResult> {
  if (options.provider.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This provider requires --allow-cloud-preview; no image was sent");
  }
  if (options.evaluator?.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This evaluator requires --allow-cloud-preview; no render was sent");
  }
  const source = await ingestPair(options.rawPath, options.previewPath);
  const session = await SessionStore.create(options.sessionRoot, source, options.backend.name);
  const photoId = options.photoId ?? source.raw_path;
  let normalizedPlan = emptyPlan();

  try {
    const sanitizedPath = join(session.dir, "inputs", "analysis.jpg");
    await createSanitizedPreview(source.preview_path, sanitizedPath);
    await session.writeJson("inputs.json", {
      sanitized_preview: sanitizedPath,
      raw_uploaded: false,
      exif_sent: false,
    });
    await session.transition("ANALYZING");

    let providerResult: ProviderResult;
    try {
      providerResult = await options.provider.analyze(sanitizedPath);
    } catch (error) {
      if (!(error instanceof CodexInputRequiredError)) throw error;
      const intentFilePath = join(session.dir, "codex-intent.json");
      const handoffPath = join(session.dir, "codex-analysis-request.md");
      await session.updateManifest({
        provider: {
          name: "codex",
          model: "codex-local-session",
          prompt_version: CODEX_PROMPT_VERSION,
          prompt_hash: CODEX_PROMPT_HASH,
          cloud_preview: false,
        },
      });
      await writeCodexAnalysisRequest(handoffPath, {
        rawPath: source.raw_path,
        previewPath: source.preview_path,
        sanitizedPreviewPath: sanitizedPath,
        sessionDir: session.dir,
        intentFilePath,
      });
      await session.transition("CODEX_INPUT_REQUIRED", {
        reason: "codex_local_review_required",
        request: handoffPath,
        intent_file: intentFilePath,
      });
      return resultFor(session, normalizedPlan, { handoffPath });
    }

    await writeProviderArtifacts(session, providerResult);
    normalizedPlan = translateIntent(providerResult.intent);
    await session.writeJson("normalized-edit-plan.json", normalizedPlan);
    await session.transition("PLAN_READY", { operation_count: normalizedPlan.operations.length });
    return await executePlan(session, source, photoId, normalizedPlan, {
      backend: options.backend,
      sessionRoot: options.sessionRoot,
      apply: options.apply,
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.maskPolicy ? { maskPolicy: options.maskPolicy } : {}),
      ...(options.copySetup ? { copySetup: options.copySetup } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.writeJson("error.json", { message, side_effect_started: false });
    const stateAfterError: string = session.currentState;
    if (stateAfterError !== "FAILED" && stateAfterError !== "REVIEW_REQUIRED") {
      await session.transition("FAILED", { error: message });
    }
    return resultFor(session, normalizedPlan);
  }
}

export type ResumeCodexOptions = {
  sessionDir: string;
  intentFile: string;
  photoId?: string;
  backend: BackendAdapter;
  sessionRoot?: string;
  apply: boolean;
  allowCloudPreview: boolean;
  evaluator?: EditEvaluator;
  maxIterations?: number;
  maskPolicy?: MaskPolicy;
  copySetup?: CopySetup;
};

export async function resumeCodexSession(options: ResumeCodexOptions): Promise<WorkflowResult> {
  if (options.evaluator?.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This evaluator requires --allow-cloud-preview; no render was sent");
  }
  const session = await SessionStore.open(options.sessionDir);
  if (session.currentState !== "CODEX_INPUT_REQUIRED") {
    throw new Error(
      `Session is ${session.currentState}; only CODEX_INPUT_REQUIRED sessions can be resumed`,
    );
  }
  const source = session.currentManifest.source;
  const photoId = options.photoId ?? source.raw_path;
  const sessionRoot = options.sessionRoot ?? resolve(session.dir, "..");
  let normalizedPlan = emptyPlan();

  try {
    const providerResult = await new CodexProvider(options.intentFile).analyze();
    await writeProviderArtifacts(session, providerResult);
    normalizedPlan = translateIntent(providerResult.intent);
    await session.writeJson("normalized-edit-plan.json", normalizedPlan);
    await session.transition("PLAN_READY", { operation_count: normalizedPlan.operations.length });
    return await executePlan(session, source, photoId, normalizedPlan, {
      backend: options.backend,
      sessionRoot,
      apply: options.apply,
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.maskPolicy ? { maskPolicy: options.maskPolicy } : {}),
      ...(options.copySetup ? { copySetup: options.copySetup } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.writeJson("error.json", { message, side_effect_started: false });
    const stateAfterError: string = session.currentState;
    if (stateAfterError !== "FAILED" && stateAfterError !== "REVIEW_REQUIRED") {
      await session.transition("FAILED", { error: message });
    }
    return resultFor(session, normalizedPlan);
  }
}

export type RecoverSessionOptions = {
  sessionDir: string;
  backend: BackendAdapter;
  photoId?: string;
};

function isMissingArtifact(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readWorkflowCopyEvidence(session: SessionStore): Promise<{
  intent?: WorkflowCopyIntent;
  result?: WorkflowCopyResult;
  verification?: WorkflowCopyVerification;
  invalidArtifacts: string[];
}> {
  let intent: WorkflowCopyIntent | undefined;
  let result: WorkflowCopyResult | undefined;
  let verification: WorkflowCopyVerification | undefined;
  const invalidArtifacts: string[] = [];
  try {
    intent = WorkflowCopyIntentSchema.parse(
      await session.readJson<unknown>("workflow-copy-intent.json"),
    );
  } catch (error) {
    if (!isMissingArtifact(error)) invalidArtifacts.push("workflow-copy-intent.json");
  }
  try {
    result = WorkflowCopyResultSchema.parse(await session.readJson<unknown>("workflow-copy.json"));
  } catch (error) {
    if (!isMissingArtifact(error)) invalidArtifacts.push("workflow-copy.json");
  }
  try {
    verification = WorkflowCopyVerificationSchema.parse(
      await session.readJson<unknown>("workflow-copy-verification.json"),
    );
  } catch (error) {
    if (!isMissingArtifact(error)) invalidArtifacts.push("workflow-copy-verification.json");
  }
  return {
    ...(intent ? { intent } : {}),
    ...(result ? { result } : {}),
    ...(verification ? { verification } : {}),
    invalidArtifacts,
  };
}

async function listJsonArtifacts(session: SessionStore, directory: string): Promise<string[]> {
  const names = await readdir(join(session.dir, directory)).catch((error: unknown) => {
    if (isMissingArtifact(error)) return [];
    throw error;
  });
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(directory, name));
}

type IterationEvidenceSummary = {
  checkpointArtifacts: string[];
  operationArtifacts: string[];
  readbackArtifacts: string[];
  invalidArtifacts: string[];
  status: RecoveryEvidence["operation_evidence_status"];
  lastReadback?: DevelopReadbackEvidence;
};

async function readIterationEvidence(session: SessionStore): Promise<IterationEvidenceSummary> {
  const checkpointArtifacts = await listJsonArtifacts(session, "checkpoints");
  const operationArtifacts = await listJsonArtifacts(session, "operations");
  const readbackArtifacts = (await readdir(session.dir))
    .filter((name) => /^backend-readback-iteration-\d+\.json$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const invalidArtifacts: string[] = [];
  const readbacks: DevelopReadbackEvidence[] = [];
  let status: IterationEvidenceSummary["status"] =
    operationArtifacts.length === 0 ? "none" : "consistent";

  for (const operationPath of operationArtifacts) {
    let intent: DevelopIterationIntent;
    try {
      intent = DevelopIterationIntentSchema.parse(await session.readJson<unknown>(operationPath));
    } catch {
      invalidArtifacts.push(operationPath);
      status = "contradictory";
      continue;
    }
    const checkpointPath = join("checkpoints", `iteration-${intent.iteration}-before.json`);
    const readbackPath = `backend-readback-iteration-${intent.iteration}.json`;
    let checkpoint: CheckpointEvidence | undefined;
    let readback: DevelopReadbackEvidence | undefined;
    try {
      checkpoint = CheckpointEvidenceSchema.parse(await session.readJson<unknown>(checkpointPath));
    } catch (error) {
      if (!isMissingArtifact(error)) invalidArtifacts.push(checkpointPath);
    }
    try {
      readback = DevelopReadbackEvidenceSchema.parse(await session.readJson<unknown>(readbackPath));
    } catch (error) {
      if (!isMissingArtifact(error)) invalidArtifacts.push(readbackPath);
    }
    if (!checkpoint || !readback) {
      if (status !== "contradictory") status = "insufficient";
      continue;
    }
    const checkpointMatches =
      checkpoint.iteration === intent.iteration &&
      checkpoint.operation_id === intent.operation_id &&
      checkpoint.checkpoint_name === intent.checkpoint_name &&
      checkpoint.checkpoint.name === intent.checkpoint_name &&
      samePhotoIdentity(checkpoint.target, intent.target);
    const readbackMatches =
      readback.iteration === intent.iteration &&
      readback.operation_id === intent.operation_id &&
      readback.checkpoint_name === intent.checkpoint_name &&
      samePhotoIdentity(readback.target, intent.target) &&
      sameDevelopSettings(readback.requested, intent.requested_settings);
    if (!checkpointMatches || !readbackMatches) {
      status = "contradictory";
      continue;
    }
    readbacks.push(readback);
  }

  if (invalidArtifacts.length > 0) status = "contradictory";
  readbacks.sort((left, right) => left.iteration - right.iteration);
  const lastReadback = readbacks.at(-1);
  return {
    checkpointArtifacts,
    operationArtifacts,
    readbackArtifacts,
    invalidArtifacts,
    status,
    ...(lastReadback ? { lastReadback } : {}),
  };
}

type MaskEvidenceSummary = {
  artifacts: string[];
  status: NonNullable<RecoveryEvidence["mask_evidence_status"]>;
  lastIntent?: MaskWriteIntent;
  lastResult?: MaskWriteResult;
};

async function readMaskEvidence(session: SessionStore): Promise<MaskEvidenceSummary> {
  const artifacts = (await listJsonArtifacts(session, "masks")).filter((path) =>
    /iteration-\d+-(intent|result)\.json$/.test(path),
  );
  const intents = artifacts.filter((path) => path.endsWith("-intent.json"));
  if (intents.length === 0) return { artifacts, status: "none" };
  let status: MaskEvidenceSummary["status"] = "consistent";
  let lastIntent: MaskWriteIntent | undefined;
  let lastResult: MaskWriteResult | undefined;
  for (const intentPath of intents) {
    let intent: MaskWriteIntent;
    try {
      intent = MaskWriteIntentSchema.parse(await session.readJson<unknown>(intentPath));
    } catch {
      return { artifacts, status: "contradictory" };
    }
    let result: MaskWriteResult | undefined;
    try {
      result = MaskWriteResultSchema.parse(
        await session.readJson<unknown>(intentPath.replace(/-intent\.json$/, "-result.json")),
      );
    } catch (error) {
      if (!isMissingArtifact(error)) return { artifacts, status: "contradictory" };
    }
    if (
      result &&
      (result.operation_id !== intent.operation_id || result.iteration !== intent.iteration)
    ) {
      return { artifacts, status: "contradictory" };
    }
    if (!result || result.readback_status === "mismatch") status = "insufficient";
    if (!lastIntent || intent.iteration > lastIntent.iteration) {
      lastIntent = intent;
      lastResult = result;
    }
  }
  return {
    artifacts,
    status,
    ...(lastIntent ? { lastIntent } : {}),
    ...(lastResult ? { lastResult } : {}),
  };
}

async function writeRecoveryEvidence(
  session: SessionStore,
  evidence: RecoveryEvidence,
): Promise<string> {
  const relativePath = join(
    "recovery",
    `recovery-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.json`,
  );
  await session.writeJson(relativePath, RecoveryEvidenceSchema.parse(evidence));
  return relativePath;
}

async function markRecoveryReview(
  session: SessionStore,
  details: Record<string, unknown>,
): Promise<void> {
  if (session.currentState === "REVIEW_REQUIRED") {
    await session.appendEvent("REVIEW_REQUIRED", details);
    return;
  }
  await session.transition("REVIEW_REQUIRED", details);
}

/**
 * Reconcile a session left behind by a process crash. Develop mutations are
 * never retried. An uncertain Workflow Copy creation is first read back at the
 * recorded Master and then reconciled with the same stable operation id through
 * a read-only backend query.
 */
export async function recoverSession(options: RecoverSessionOptions): Promise<WorkflowResult> {
  const session = await SessionStore.open(options.sessionDir);
  const normalizedPlan = await session
    .readJson<NormalizedEditPlan>("normalized-edit-plan.json")
    .catch(() => emptyPlan());
  const state = session.currentState;

  if (state === "ACCEPTED" || state === "FAILED" || state === "CANCELLED") {
    return resultFor(session, normalizedPlan);
  }
  if (state === "CODEX_INPUT_REQUIRED") {
    return resultFor(session, normalizedPlan);
  }
  const copyEvidence = await readWorkflowCopyEvidence(session);
  const hasCopyEvidence = Boolean(copyEvidence.intent || copyEvidence.result);
  if (state === "REVIEW_REQUIRED" && !hasCopyEvidence) {
    return resultFor(session, normalizedPlan);
  }
  if (
    (state === "PENDING" || state === "ANALYZING" || state === "PLAN_READY") &&
    !hasCopyEvidence
  ) {
    await session.transition("REVIEW_REQUIRED", {
      reason: "recovered_before_backend_mutation",
      interrupted_state: state,
    });
    return resultFor(session, normalizedPlan);
  }

  const iterationEvidence = await readIterationEvidence(session);
  const maskEvidence = await readMaskEvidence(session);
  const evidenceBase = {
    mask_artifacts: maskEvidence.artifacts,
    mask_evidence_status: maskEvidence.status,
    schema_version: "0.1.0" as const,
    interrupted_state: state,
    workflow_copy_intent: copyEvidence.intent ?? null,
    workflow_copy: copyEvidence.result ?? null,
    workflow_copy_verification: copyEvidence.verification ?? null,
    checkpoint_artifacts: iterationEvidence.checkpointArtifacts,
    operation_artifacts: iterationEvidence.operationArtifacts,
    readback_artifacts: iterationEvidence.readbackArtifacts,
    operation_evidence_status: iterationEvidence.status,
    invalid_artifacts: [...copyEvidence.invalidArtifacts, ...iterationEvidence.invalidArtifacts],
    copy_creation_reconciled: false,
    copy_creation_retried: false as const,
    mutation_retried: false as const,
    ...(options.photoId ? { requested_photo_id: options.photoId } : {}),
  };
  const recordWithoutReadback = async (
    evidenceStatus: RecoveryEvidence["evidence_status"],
    reason: string,
    targetPhotoId?: string,
  ): Promise<WorkflowResult> => {
    const recoveryPath = await writeRecoveryEvidence(session, {
      ...evidenceBase,
      recovered_at: new Date().toISOString(),
      evidence_status: evidenceStatus,
      reason,
      ...(targetPhotoId ? { target_photo_id: targetPhotoId } : {}),
      read_back: null,
    });
    await markRecoveryReview(session, {
      reason,
      interrupted_state: state,
      recovery: recoveryPath,
    });
    return resultFor(session, normalizedPlan);
  };

  if (copyEvidence.invalidArtifacts.length > 0) {
    return await recordWithoutReadback("contradictory", "invalid_workflow_copy_evidence");
  }
  if (copyEvidence.result && !copyEvidence.intent) {
    return await recordWithoutReadback(
      "contradictory",
      "workflow_copy_result_missing_durable_intent",
    );
  }
  const intent = copyEvidence.intent;
  const recordedResult = copyEvidence.result;
  const recordedCopy = recordedResult?.copy;
  const recordedVerification = copyEvidence.verification;
  if (recordedVerification && (!intent || !recordedResult || !recordedCopy)) {
    return await recordWithoutReadback(
      "contradictory",
      "workflow_copy_verification_missing_identity_evidence",
    );
  }
  if (intent && recordedResult && !workflowCopyResultMatchesIntent(recordedResult, intent)) {
    return await recordWithoutReadback(
      "contradictory",
      "workflow_copy_artifacts_contradict_each_other",
    );
  }
  if (
    intent &&
    recordedCopy &&
    recordedVerification &&
    (recordedVerification.operation_id !== intent.operation_id ||
      !isRecordedMaster(recordedVerification.master, intent.source) ||
      !samePhotoIdentity(recordedVerification.copy ?? undefined, recordedCopy))
  ) {
    return await recordWithoutReadback(
      "contradictory",
      "workflow_copy_verification_contradicts_recorded_identity",
    );
  }

  let targetPhotoId =
    recordedCopy?.catalog_id ??
    intent?.source.catalog_id ??
    options.photoId ??
    session.currentManifest.source.raw_path;
  const expectedOverride = recordedCopy?.catalog_id ?? intent?.source.catalog_id;
  if (options.photoId && expectedOverride && options.photoId !== expectedOverride) {
    return await recordWithoutReadback(
      "contradictory",
      "recovery_photo_id_conflicts_with_recorded_identity",
      targetPhotoId,
    );
  }

  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  let copyCreationReconciled = false;
  try {
    unlock = await acquireMutationLock(
      join(resolve(session.dir, ".."), `${options.backend.name}.mutation.lock`),
      {
        backend: options.backend.name,
        sessionId: session.currentManifest.session_id,
        staleAfterMs: 0,
      },
    );
    await options.backend.connect();
    connected = true;
    const backendManifest = await requireBackendHandshake(options.backend, RECOVERY_OPERATIONS);
    await session.updateManifest({
      backend: { name: backendManifest.backend, version: backendManifest.version },
    });
    let current = await options.backend.readCurrentEdit(targetPhotoId);
    let effectiveResult = recordedResult;
    let effectiveCopy = recordedCopy;
    let effectiveVerification = recordedVerification;
    let evidenceStatus: RecoveryEvidence["evidence_status"] = "insufficient";
    let reason = "legacy_recovery_without_workflow_copy_evidence";

    if (intent && !effectiveCopy) {
      const sourceMatches =
        current.photo_id === intent.source.catalog_id &&
        isRecordedMaster(current.identity, intent.source) &&
        samePath(current.path, session.currentManifest.source.raw_path);
      if (!sourceMatches) {
        evidenceStatus = "contradictory";
        reason = "workflow_copy_intent_source_contradicts_backend";
      } else if (!supportsReadOnlyWorkflowCopyReconciliation(backendManifest)) {
        evidenceStatus = "insufficient";
        reason = "workflow_copy_read_only_reconciliation_unavailable";
      } else {
        const sourceState = current;
        effectiveResult = await options.backend.reconcileWorkflowCopy(
          intent.source.catalog_id,
          intent.source.uuid,
          intent.operation_id,
        );
        const resultMatchesIntent = workflowCopyResultMatchesIntent(effectiveResult, intent);
        if (!resultMatchesIntent) {
          evidenceStatus = "contradictory";
          reason = "workflow_copy_reconciliation_returned_contradictory_identity";
        } else if (effectiveResult.result === "created") {
          evidenceStatus = "contradictory";
          reason = "workflow_copy_reconciliation_returned_mutating_result";
        } else if (
          effectiveResult.result !== "reconciled" ||
          effectiveResult.partial ||
          !effectiveResult.copy ||
          !workflowCopyResultIsComplete(effectiveResult)
        ) {
          evidenceStatus = "insufficient";
          reason = effectiveResult.reason ?? "workflow_copy_reconciliation_evidence_insufficient";
        } else {
          copyCreationReconciled = true;
          effectiveCopy = effectiveResult.copy;
          targetPhotoId = effectiveCopy.catalog_id;
          if (!recordedResult) await session.writeJson("workflow-copy.json", effectiveResult);
          current = await options.backend.readCurrentEdit(targetPhotoId);
          const verified =
            current.photo_id === effectiveCopy.catalog_id &&
            samePhotoIdentity(current.identity, effectiveCopy) &&
            isCopyOfMaster(current.identity, intent.source) &&
            samePath(current.path, sourceState.path) &&
            sameDevelopSettings(current.develop_settings, sourceState.develop_settings);
          effectiveVerification = WorkflowCopyVerificationSchema.parse({
            operation_id: intent.operation_id,
            verified,
            master: intent.source,
            copy: current.identity ?? null,
            inherited_develop_state: sameDevelopSettings(
              current.develop_settings,
              sourceState.develop_settings,
            ),
          });
          if (!copyEvidence.verification) {
            await session.writeJson("workflow-copy-verification.json", effectiveVerification);
          }
          evidenceStatus = verified ? "consistent" : "contradictory";
          reason = verified
            ? "workflow_copy_creation_reconciled_read_only"
            : "workflow_copy_reconciliation_readback_mismatch";
        }
      }
    } else if (effectiveCopy && intent) {
      const copyMatches =
        current.photo_id === effectiveCopy.catalog_id &&
        samePhotoIdentity(current.identity, effectiveCopy) &&
        isCopyOfMaster(current.identity, intent.source) &&
        samePath(current.path, session.currentManifest.source.raw_path);
      const completeResult =
        effectiveResult !== undefined &&
        workflowCopyResultIsComplete(effectiveResult) &&
        (effectiveVerification === undefined ||
          (effectiveVerification.verified && effectiveVerification.inherited_develop_state));
      evidenceStatus = !copyMatches
        ? "contradictory"
        : completeResult
          ? "consistent"
          : "insufficient";
      reason = !copyMatches
        ? "recorded_workflow_copy_contradicts_backend"
        : completeResult
          ? "recorded_workflow_copy_reconciled"
          : "recorded_workflow_copy_requires_review";
    } else if (!samePath(current.path, session.currentManifest.source.raw_path)) {
      evidenceStatus = "contradictory";
      reason = "legacy_recovery_path_mismatch";
    }

    if (evidenceStatus !== "contradictory" && iterationEvidence.status === "contradictory") {
      evidenceStatus = "contradictory";
      reason = "develop_iteration_evidence_contradictory";
    } else if (evidenceStatus === "consistent" && iterationEvidence.status === "insufficient") {
      evidenceStatus = "insufficient";
      reason = "develop_iteration_outcome_uncertain";
    } else if (
      evidenceStatus === "consistent" &&
      iterationEvidence.lastReadback &&
      !sameDevelopSettings(current.develop_settings, iterationEvidence.lastReadback.read_back)
    ) {
      evidenceStatus = "contradictory";
      reason = "develop_iteration_readback_contradicts_backend";
    }
    if (evidenceStatus !== "contradictory" && maskEvidence.status === "contradictory") {
      evidenceStatus = "contradictory";
      reason = "mask_write_evidence_contradictory";
    } else if (evidenceStatus === "consistent" && maskEvidence.status === "insufficient") {
      evidenceStatus = "insufficient";
      reason = "mask_write_outcome_uncertain";
    } else if (
      evidenceStatus === "consistent" &&
      maskEvidence.lastIntent &&
      maskBackendSupport(backendManifest, options.backend) === "read_write"
    ) {
      // Read-only comparison; the mask write is never retried here.
      const currentMasks = await options.backend.readMaskCorrections!(targetPhotoId);
      const requested = maskEvidence.lastIntent.requested;
      if (
        (currentMasks.status !== "ok" && requested.length > 0) ||
        !correctionsMatch(requested, currentMasks.corrections)
      ) {
        evidenceStatus = "contradictory";
        reason = "mask_state_contradicts_backend";
      }
    }
    const recoveryPath = await writeRecoveryEvidence(session, {
      ...evidenceBase,
      recovered_at: new Date().toISOString(),
      evidence_status: evidenceStatus,
      reason,
      target_photo_id: targetPhotoId,
      workflow_copy: effectiveResult ?? null,
      workflow_copy_verification: effectiveVerification ?? null,
      copy_creation_reconciled: copyCreationReconciled,
      read_back: current,
    });
    await markRecoveryReview(session, {
      reason,
      interrupted_state: state,
      recovery: recoveryPath,
    });
    return resultFor(session, normalizedPlan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recoveryPath = await writeRecoveryEvidence(session, {
      ...evidenceBase,
      recovered_at: new Date().toISOString(),
      evidence_status: "readback_failed",
      reason: `recovery_readback_failed: ${message}`,
      target_photo_id: targetPhotoId,
      copy_creation_reconciled: copyCreationReconciled,
      read_back: null,
    });
    await markRecoveryReview(session, {
      reason: "recovery_readback_failed",
      error: message,
      recovery: recoveryPath,
    });
    return resultFor(session, normalizedPlan);
  } finally {
    if (connected) await options.backend.close();
    if (unlock) await unlock();
  }
}

export type RestoreMasksOptions = {
  sessionDir: string;
  backend: BackendAdapter;
  /** Restore the mask set recorded before this iteration's mask write. */
  iteration: number;
};

export type RestoreMasksResult = {
  evidencePath: string;
  written: number;
  readbackStatus: MaskWriteResult["readback_status"];
  note: string;
};

/**
 * Explicit, user-invoked mask rollback. Lightroom develop checkpoints cannot
 * carry MaskGroupBasedCorrections, so every mask write records the full set
 * that was on the Workflow Copy before it. This writes that recorded set back
 * to the same, re-verified Workflow Copy. It never touches the Master.
 */
export async function restoreMasks(options: RestoreMasksOptions): Promise<RestoreMasksResult> {
  const session = await SessionStore.open(options.sessionDir);
  const intent = MaskWriteIntentSchema.parse(
    await session.readJson<unknown>(`masks/iteration-${options.iteration}-intent.json`),
  );
  if (!intent.target.is_virtual_copy) {
    throw new Error("Refusing to restore masks on a photo that is not a Workflow Copy");
  }
  const before = intent.before ?? [];
  const note =
    intent.before_status === "unverified_assumed_empty"
      ? "Backend could not read masks before the first write; restored to an empty mask set. Masks inherited from the Master (if any) remain on the Master only."
      : "Restored the mask set recorded before this iteration's write.";
  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  try {
    unlock = await acquireMutationLock(
      join(resolve(session.dir, ".."), `${options.backend.name}.mutation.lock`),
      { backend: options.backend.name, sessionId: session.currentManifest.session_id },
    );
    await options.backend.connect();
    connected = true;
    const manifest = await requireBackendHandshake(options.backend, RECOVERY_OPERATIONS);
    const support = maskBackendSupport(manifest, options.backend);
    if (support === "unsupported") {
      throw new Error("Backend does not support geometric mask writes; nothing was restored");
    }
    const current = await options.backend.readCurrentEdit(intent.target.catalog_id);
    if (
      !samePhotoIdentity(current.identity, intent.target) ||
      !samePath(current.path, session.currentManifest.source.raw_path)
    ) {
      throw new Error("Workflow Copy identity changed since the mask write; refusing to restore");
    }
    await options.backend.applyMaskCorrections!(intent.target.catalog_id, before);
    let readbackStatus: MaskWriteResult["readback_status"] = "unavailable";
    if (support === "read_write") {
      const readBack = await options.backend.readMaskCorrections!(intent.target.catalog_id);
      readbackStatus =
        (readBack.status === "ok" || before.length === 0) &&
        correctionsMatch(before, readBack.corrections)
          ? "verified"
          : "mismatch";
    }
    const evidencePath = join(
      "masks",
      `restore-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}.json`,
    );
    await session.writeJson(
      evidencePath,
      MaskRestoreEvidenceSchema.parse({
        schema_version: "0.1.0",
        restored_at: new Date().toISOString(),
        source_operation_id: intent.operation_id,
        iteration: intent.iteration,
        target: intent.target,
        written: before,
        before_status: intent.before_status,
        readback_status: readbackStatus,
        note,
      }),
    );
    await session.appendEvent(session.currentState, {
      masks_restored_from: intent.operation_id,
      readback_status: readbackStatus,
    });
    return {
      evidencePath: join(session.dir, evidencePath),
      written: before.length,
      readbackStatus,
      note,
    };
  } finally {
    if (connected) await options.backend.close();
    if (unlock) await unlock();
  }
}
