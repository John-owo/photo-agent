import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { MIN_EVALUATION_CONFIDENCE, planFingerprint, renderFingerprint } from "./evaluation.js";
import {
  RECOVERY_OPERATIONS,
  requireBackendHandshake,
  SINGLE_PHOTO_OPERATIONS,
  WORKFLOW_COPY_RECONCILIATION_OPERATION,
} from "./backend-handshake.js";
import { ingestPair } from "./ingest.js";
import { createSanitizedPreview, materializePreviewArtifact } from "./preview.js";
import {
  resolveLightroomSettings,
  translateIntent,
  LIGHTROOM_CHECKPOINT_KEYS,
} from "./translator.js";
import {
  CodexInputRequiredError,
  CODEX_PROMPT_HASH,
  CODEX_PROMPT_VERSION,
  CodexProvider,
  writeCodexAnalysisRequest,
} from "./providers.js";
import {
  acquireMutationLock,
  SessionStore,
  throwIfCancellationRequested,
  WorkflowCancellationError,
} from "./runtime.js";
import {
  DevelopIterationIntentSchema,
  CheckpointEvidenceSchema,
  EvaluationArtifactSchema,
  DevelopReadbackEvidenceSchema,
  EvaluationResultSchema,
  IterationReportRecordSchema,
  IterationReportSchema,
  RecoveryEvidenceSchema,
  CancellationEvidenceSchema,
  WorkflowBudgetSchema,
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
  EditEvaluator,
  IterationReportRecord,
  NormalizedEditPlan,
  ProviderResult,
  RecoveryEvidence,
  SourceAssetPair,
  WorkflowOptions,
  WorkflowCopyIntent,
  WorkflowCopyResult,
  WorkflowCopyVerification,
  WorkflowBudget,
  WorkflowBudgetOptions,
  WorkflowResult,
} from "./types.js";

function cancellationFrom(
  error: unknown,
  signal: AbortSignal | undefined,
  phase: "read_only" | "mutation",
  sideEffectStarted: boolean,
): WorkflowCancellationError | undefined {
  if (error instanceof WorkflowCancellationError) return error;
  return signal?.aborted
    ? new WorkflowCancellationError(phase, sideEffectStarted, signal.reason)
    : undefined;
}

function isTerminalState(state: WorkflowResult["state"]): boolean {
  return ["ACCEPTED", "REVIEW_REQUIRED", "FAILED", "CANCELLED"].includes(state);
}

async function finalizeCancellation(
  session: SessionStore,
  cancellation: WorkflowCancellationError,
): Promise<void> {
  const evidence = await session.recordCancellation({
    phase: cancellation.phase,
    reason: cancellation.message,
    side_effect_started: cancellation.sideEffectStarted,
  });
  await session.writeJson("cancellation.json", CancellationEvidenceSchema.parse(evidence));
  if (isTerminalState(session.currentState)) {
    await session.appendEvent(session.currentState, {
      event: "cancellation_requested_after_terminal_state",
      reason: cancellation.message,
    });
    return;
  }
  if (cancellation.sideEffectStarted) {
    await session.transition("REVIEW_REQUIRED", {
      reason: "cancellation_during_mutation",
      cancellation: cancellation.message,
    });
  } else {
    await session.transition("CANCELLED", {
      reason: "cancellation_during_read_only_work",
      cancellation: cancellation.message,
    });
  }
}

async function releaseBackendLease(
  session: SessionStore,
  backend: BackendAdapter,
  connected: boolean,
): Promise<void> {
  if (!connected) return;
  let releaseError: string | undefined;
  try {
    await backend.close();
  } catch (error) {
    releaseError = error instanceof Error ? error.message : String(error);
  }
  await session.writeJson("backend-lease.json", {
    backend: backend.name,
    released: releaseError === undefined,
    released_at: new Date().toISOString(),
    ...(releaseError ? { error: releaseError } : {}),
  });
  if (releaseError) {
    await session.appendEvent(session.currentState, {
      event: "backend_lease_release_failed",
      error: releaseError,
    });
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function sessionRelativePath(sessionDir: string, path: string): string {
  return relative(sessionDir, path).split("\\").join("/");
}

type EvidenceLink = IterationReportRecord["plan"];

async function evidenceLink(
  sessionDir: string,
  path: string,
  relativePath = sessionRelativePath(sessionDir, path),
): Promise<EvidenceLink> {
  return { path: relativePath, sha256: await renderFingerprint(path) };
}

function sameDevelopSettings(
  left: Record<string, number | string | boolean>,
  right: Record<string, number | string | boolean>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
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
  extra: { renderPath?: string; handoffPath?: string; iterations?: number } = {},
): WorkflowResult {
  return {
    sessionDir: session.dir,
    state: session.currentState,
    manifest: session.currentManifest,
    normalizedPlan,
    ...(extra.renderPath ? { renderPath: extra.renderPath } : {}),
    ...(extra.handoffPath ? { handoffPath: extra.handoffPath } : {}),
    ...(extra.iterations !== undefined ? { iterations: extra.iterations } : {}),
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
  budget?: WorkflowBudgetOptions;
  signal?: AbortSignal;
};

export const DEFAULT_WORKFLOW_BUDGETS = {
  maxElapsedMs: 5 * 60 * 1000,
  maxTotalTokens: 100_000,
  maxCostUsd: 1,
} as const;

type ResolvedWorkflowBudget = {
  maxIterations: number;
  maxElapsedMs: number;
  maxRenders: number;
  maxEvaluatorCalls: number;
  maxTotalTokens: number;
  maxCostUsd: number;
};

function resolveWorkflowBudget(
  maxIterations: number,
  configured: WorkflowBudgetOptions | undefined,
): ResolvedWorkflowBudget {
  const budget: ResolvedWorkflowBudget = {
    maxIterations,
    maxElapsedMs: configured?.maxElapsedMs ?? DEFAULT_WORKFLOW_BUDGETS.maxElapsedMs,
    maxRenders: configured?.maxRenders ?? maxIterations,
    maxEvaluatorCalls: configured?.maxEvaluatorCalls ?? maxIterations,
    maxTotalTokens: configured?.maxTotalTokens ?? DEFAULT_WORKFLOW_BUDGETS.maxTotalTokens,
    maxCostUsd: configured?.maxCostUsd ?? DEFAULT_WORKFLOW_BUDGETS.maxCostUsd,
  };
  for (const [name, value] of Object.entries(budget)) {
    if (
      !Number.isFinite(value) ||
      (!Number.isInteger(value) && name !== "maxCostUsd") ||
      value < 0
    ) {
      throw new Error(`Invalid workflow budget ${name}: expected a non-negative number`);
    }
  }
  return budget;
}

function budgetArtifact(budget: ResolvedWorkflowBudget): WorkflowBudget {
  return WorkflowBudgetSchema.parse({
    max_iterations: budget.maxIterations,
    max_elapsed_ms: budget.maxElapsedMs,
    max_renders: budget.maxRenders,
    max_evaluator_calls: budget.maxEvaluatorCalls,
    max_total_tokens: budget.maxTotalTokens,
    max_cost_usd: budget.maxCostUsd,
  });
}

async function executePlan(
  session: SessionStore,
  source: SourceAssetPair,
  photoId: string,
  normalizedPlan: NormalizedEditPlan,
  options: PlanExecutionOptions,
): Promise<WorkflowResult> {
  throwIfCancellationRequested(options.signal, "read_only");
  if (!options.apply) {
    await session.transition("REVIEW_REQUIRED", { reason: "apply_not_requested" });
    return resultFor(session, normalizedPlan);
  }
  if (normalizedPlan.operations.length === 0) {
    await session.transition("REVIEW_REQUIRED", { reason: "no_executable_operations" });
    return resultFor(session, normalizedPlan);
  }
  const maxIterations = options.maxIterations ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) {
    await session.transition("FAILED", {
      error: "maxIterations must be an integer from 1 to 10",
    });
    return resultFor(session, normalizedPlan);
  }
  let budget: ResolvedWorkflowBudget;
  try {
    budget = resolveWorkflowBudget(maxIterations, options.budget);
  } catch (error) {
    await session.transition("FAILED", {
      error: error instanceof Error ? error.message : String(error),
    });
    return resultFor(session, normalizedPlan);
  }

  let sideEffectStarted = false;
  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  const startedAt = Date.now();
  let activeIteration = 0;
  let activeRecord: Partial<IterationReportRecord> | undefined;
  let iterationRecords: IterationReportRecord[] = [];
  let evaluatorCalls = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let renderCount = 0;
  let evaluatorAttempted = false;

  const budgetReasonBeforeWork = (): string | undefined => {
    if (Date.now() - startedAt >= budget.maxElapsedMs) return "time_budget_exhausted";
    if (renderCount >= budget.maxRenders) return "render_budget_exhausted";
    if (evaluatorCalls >= budget.maxEvaluatorCalls) return "evaluator_call_budget_exhausted";
    if (totalTokens >= budget.maxTotalTokens) return "token_budget_exhausted";
    if (estimatedCostUsd >= budget.maxCostUsd) return "cost_budget_exhausted";
    return undefined;
  };

  const budgetReasonBeforeEvaluation = (): string | undefined => {
    if (Date.now() - startedAt >= budget.maxElapsedMs) return "time_budget_exhausted";
    if (evaluatorCalls >= budget.maxEvaluatorCalls) return "evaluator_call_budget_exhausted";
    if (totalTokens >= budget.maxTotalTokens) return "token_budget_exhausted";
    if (estimatedCostUsd >= budget.maxCostUsd) return "cost_budget_exhausted";
    return undefined;
  };

  const budgetOverrunAfterEvaluation = (): string | undefined => {
    if (Date.now() - startedAt > budget.maxElapsedMs) return "time_budget_exhausted";
    if (evaluatorCalls > budget.maxEvaluatorCalls) return "evaluator_call_budget_exhausted";
    if (totalTokens > budget.maxTotalTokens) return "token_budget_exhausted";
    if (estimatedCostUsd > budget.maxCostUsd) return "cost_budget_exhausted";
    return undefined;
  };

  const finishReport = async (iterations: number, reason: string): Promise<void> => {
    await session.writeJson(
      "iteration-report.json",
      IterationReportSchema.parse({
        schema_version: "0.2.0",
        evaluator: options.evaluator?.name ?? null,
        iterations,
        render_count: renderCount,
        evaluator_calls: evaluatorCalls,
        total_tokens: totalTokens,
        estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
        elapsed_ms: Date.now() - startedAt,
        budget: budgetArtifact(budget),
        terminal_state: session.currentState,
        reason,
        iteration_records: iterationRecords,
      }),
    );
  };

  await session.writeJson("iteration-budget.json", budgetArtifact(budget));
  throwIfCancellationRequested(options.signal, "read_only");
  const initialBudgetReason = budgetReasonBeforeWork();
  if (initialBudgetReason) {
    await session.transition("REVIEW_REQUIRED", { reason: initialBudgetReason });
    await finishReport(0, initialBudgetReason);
    return resultFor(session, normalizedPlan);
  }

  const completeIteration = (
    state: IterationReportRecord["state"],
    extra: Partial<IterationReportRecord> = {},
  ): void => {
    if (!activeRecord) return;
    iterationRecords = [
      ...iterationRecords,
      IterationReportRecordSchema.parse({ ...activeRecord, ...extra, state }),
    ];
    activeRecord = undefined;
  };

  try {
    throwIfCancellationRequested(options.signal, "read_only");
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
    throwIfCancellationRequested(options.signal, "read_only");
    await session.updateManifest({
      backend: { name: backendManifest.backend, version: backendManifest.version },
    });
    const master = await options.backend.readCurrentEdit(photoId);
    throwIfCancellationRequested(options.signal, "read_only");
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
    if (!hasEffectiveSettings(master.develop_settings, initialSettings)) {
      await session.transition("REVIEW_REQUIRED", { reason: "no_effective_adjustments" });
      return resultFor(session, normalizedPlan);
    }
    const preMutationBudgetReason = budgetReasonBeforeWork();
    if (preMutationBudgetReason) {
      await session.transition("REVIEW_REQUIRED", { reason: preMutationBudgetReason });
      await finishReport(0, preMutationBudgetReason);
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
    throwIfCancellationRequested(options.signal, "mutation", true);
    const workflowCopy = await options.backend.createWorkflowCopy(
      master.identity.catalog_id,
      master.identity.uuid,
      operationId,
    );
    throwIfCancellationRequested(options.signal, "mutation", true);
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
    throwIfCancellationRequested(options.signal, "mutation", true);
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
    const activePhotoId = workflowCopy.copy.catalog_id;
    let activePlan = normalizedPlan;
    let previousRenderHash: string | undefined;
    let previousPlanHash: string | undefined;

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      throwIfCancellationRequested(options.signal, "mutation", true);
      const nextIterationBudgetReason = budgetReasonBeforeWork();
      if (nextIterationBudgetReason) {
        await session.transition("REVIEW_REQUIRED", {
          reason: nextIterationBudgetReason,
          iteration,
        });
        await finishReport(iteration - 1, nextIterationBudgetReason);
        return resultFor(session, normalizedPlan, { iterations: iteration - 1 });
      }
      const settings =
        iteration === 1
          ? initialSettings
          : resolveLightroomSettings(current.develop_settings, activePlan);
      const checkpointName = `PhotoAgent_${session.currentManifest.session_id}_iteration_${iteration}_before`;
      const iterationOperationId = `photoagent-iteration-${session.currentManifest.session_id}-${iteration}`;
      const planRelativePath = `plans/iteration-${iteration}.json`;
      const planPath = join(session.dir, planRelativePath);
      await session.writeJson(planRelativePath, activePlan);
      activeIteration = iteration;
      activeRecord = {
        iteration,
        operation_id: iterationOperationId,
        state: "FAILED",
        plan: await evidenceLink(session.dir, planPath, planRelativePath),
      };
      await session.transition("APPLYING", { checkpoint: checkpointName, iteration });
      const iterationIntent = DevelopIterationIntentSchema.parse({
        schema_version: "0.1.0",
        operation_id: iterationOperationId,
        kind: "develop_iteration",
        phase: "started",
        iteration,
        target: copyIdentity,
        checkpoint_name: checkpointName,
        requested_settings: settings,
      });
      await session.writeJson(`operations/iteration-${iteration}-intent.json`, iterationIntent);
      const checkpoint = await options.backend.createCheckpoint(
        activePhotoId,
        checkpointName,
        LIGHTROOM_CHECKPOINT_KEYS,
      );
      throwIfCancellationRequested(options.signal, "mutation", true);
      const checkpointEvidence = CheckpointEvidenceSchema.parse({
        iteration,
        operation_id: iterationOperationId,
        target: copyIdentity,
        checkpoint_name: checkpointName,
        checkpoint,
      });
      const checkpointRelativePath = `checkpoints/iteration-${iteration}-before.json`;
      await session.writeJson(checkpointRelativePath, checkpointEvidence);
      if (iteration === 1) await session.writeJson("checkpoints/before.json", checkpointEvidence);
      activeRecord = {
        ...activeRecord,
        checkpoint: await evidenceLink(
          session.dir,
          join(session.dir, checkpointRelativePath),
          checkpointRelativePath,
        ),
      };
      sideEffectStarted = true;
      await options.backend.applyGlobalAdjustment(activePhotoId, settings);
      throwIfCancellationRequested(options.signal, "mutation", true);
      const readBack = await options.backend.readCurrentEdit(activePhotoId);
      throwIfCancellationRequested(options.signal, "mutation", true);
      const readbackEvidence = DevelopReadbackEvidenceSchema.parse({
        iteration,
        operation_id: iterationOperationId,
        target: copyIdentity,
        checkpoint_name: checkpointName,
        requested: settings,
        read_back: readBack.develop_settings,
      });
      const readbackRelativePath = `backend-readback-iteration-${iteration}.json`;
      await session.writeJson(readbackRelativePath, readbackEvidence);
      if (iteration === 1) {
        await session.writeJson("backend-readback.json", readbackEvidence);
      }
      const readbackPath = join(session.dir, readbackRelativePath);
      const readbackLink = await evidenceLink(session.dir, readbackPath, readbackRelativePath);
      activeRecord = { ...activeRecord, readback: readbackLink };
      for (const [key, value] of Object.entries(settings)) {
        if (readBack.develop_settings[key] !== value) {
          await session.transition("REVIEW_REQUIRED", {
            reason: "backend_readback_mismatch",
            key,
            iteration,
            rollback_checkpoint: checkpointName,
          });
          completeIteration("REVIEW_REQUIRED", {
            error: `backend_readback_mismatch:${key}`,
          });
          await finishReport(iteration, "backend_readback_mismatch");
          return resultFor(session, normalizedPlan, { iterations: iteration });
        }
      }
      current = readBack;
      await session.transition("RENDERING", { iteration });
      throwIfCancellationRequested(options.signal, "mutation", true);
      const render = await options.backend.renderPreview(
        activePhotoId,
        join(session.dir, "renders", `iteration-${iteration}`),
      );
      throwIfCancellationRequested(options.signal, "mutation", true);
      renderCount += 1;
      const previewArtifact = await materializePreviewArtifact(session.dir, iteration, render.path);
      throwIfCancellationRequested(options.signal, "mutation", true);
      const previewPath = resolve(session.dir, previewArtifact.path);
      const backendRenderLink = await evidenceLink(
        session.dir,
        render.path,
        sessionRelativePath(session.dir, render.path),
      );
      const previewLink = await evidenceLink(session.dir, previewPath, previewArtifact.path);
      const renderArtifact = { ...render, preview: previewArtifact };
      await session.writeJson(`render-iteration-${iteration}.json`, renderArtifact);
      if (iteration === 1) await session.writeJson("render.json", renderArtifact);
      activeRecord = {
        ...activeRecord,
        backend_render: backendRenderLink,
        preview: previewLink,
      };
      if (!options.evaluator) {
        const postRenderBudgetReason = budgetReasonBeforeEvaluation();
        if (postRenderBudgetReason) {
          await session.transition("REVIEW_REQUIRED", {
            reason: postRenderBudgetReason,
            iteration,
            rollback_checkpoint: checkpointName,
          });
          completeIteration("REVIEW_REQUIRED", { error: postRenderBudgetReason });
          await finishReport(iteration, postRenderBudgetReason);
          return resultFor(session, normalizedPlan, {
            renderPath: render.path,
            iterations: iteration,
          });
        }
        await session.transition("REVIEW_REQUIRED", {
          reason: "visual_evaluator_not_configured",
          render: render.path,
          preview: previewArtifact.path,
          rollback_checkpoint: checkpointName,
        });
        completeIteration("REVIEW_REQUIRED", { error: "visual_evaluator_not_configured" });
        await finishReport(iteration, "visual_evaluator_not_configured");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }

      await session.transition("EVALUATING", { iteration, render: previewArtifact.path });
      const evaluationPath = options.evaluator.requiresCloudPreview
        ? join(session.dir, "evaluations", `iteration-${iteration}-analysis.jpg`)
        : previewPath;
      if (options.evaluator.requiresCloudPreview) {
        await createSanitizedPreview(previewPath, evaluationPath);
      }
      const evaluationRelativePath = sessionRelativePath(session.dir, evaluationPath);
      const preEvaluationBudgetReason = budgetReasonBeforeEvaluation();
      if (preEvaluationBudgetReason) {
        await session.transition("REVIEW_REQUIRED", {
          reason: preEvaluationBudgetReason,
          iteration,
          rollback_checkpoint: checkpointName,
        });
        completeIteration("REVIEW_REQUIRED", { error: preEvaluationBudgetReason });
        await finishReport(iteration, preEvaluationBudgetReason);
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }
      evaluatorAttempted = true;
      const evaluation = EvaluationResultSchema.parse(
        await options.evaluator.evaluate({
          renderPath: evaluationPath,
          iteration,
          normalizedPlan: activePlan,
          readBack,
        }),
      );
      throwIfCancellationRequested(options.signal, "mutation", true);
      evaluatorCalls += evaluation.usage?.evaluator_calls ?? 1;
      totalTokens += evaluation.usage?.total_tokens ?? 0;
      estimatedCostUsd += evaluation.usage?.estimated_cost_usd ?? 0;
      evaluatorAttempted = false;
      const evaluationArtifact = EvaluationArtifactSchema.parse({
        ...evaluation,
        iteration,
        operation_id: iterationOperationId,
        evidence: {
          render: await evidenceLink(session.dir, evaluationPath, evaluationRelativePath),
          preview: previewLink,
          backend_render: backendRenderLink,
          plan: activeRecord.plan,
          readback: readbackLink,
        },
      });
      await session.writeJson(`evaluations/iteration-${iteration}.json`, evaluationArtifact);
      const evaluationSummary = {
        path: `evaluations/iteration-${iteration}.json`,
        verdict: evaluation.verdict,
        confidence: evaluation.confidence,
        rationale: evaluation.rationale,
        issues: evaluation.issues,
      };
      const evaluationBudgetOverrun = budgetOverrunAfterEvaluation();
      if (evaluationBudgetOverrun) {
        await session.transition("REVIEW_REQUIRED", {
          reason: evaluationBudgetOverrun,
          iteration,
          rollback_checkpoint: checkpointName,
        });
        completeIteration("REVIEW_REQUIRED", {
          evaluation: evaluationSummary,
          error: evaluationBudgetOverrun,
        });
        await finishReport(iteration, evaluationBudgetOverrun);
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
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
        completeIteration("REVIEW_REQUIRED", { evaluation: evaluationSummary });
        await finishReport(iteration, "human_review_escalation");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }
      if (evaluation.verdict === "accept") {
        await session.transition("ACCEPTED", { iteration, render: previewArtifact.path });
        completeIteration("ACCEPTED", { evaluation: evaluationSummary });
        await finishReport(iteration, "accepted");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }

      const nextPlan = evaluation.refinement_plan!;
      const renderHash = await renderFingerprint(previewPath);
      const nextPlanHash = planFingerprint(evaluation);
      const stalled =
        nextPlan.operations.length === 0 ||
        renderHash === previousRenderHash ||
        (nextPlanHash !== undefined && nextPlanHash === previousPlanHash);
      if (stalled || iteration === maxIterations) {
        const reason = stalled ? "closed_loop_stalled" : "iteration_budget_exhausted";
        await session.transition("REVIEW_REQUIRED", {
          reason,
          iteration,
          rollback_checkpoint: checkpointName,
        });
        completeIteration("REVIEW_REQUIRED", { evaluation: evaluationSummary });
        await finishReport(iteration, reason);
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }
      previousRenderHash = renderHash;
      previousPlanHash = nextPlanHash;
      activePlan = nextPlan;
      await session.transition("REFINING", {
        iteration,
        next_operation_count: nextPlan.operations.length,
      });
      completeIteration("REFINING", { evaluation: evaluationSummary });
    }
    throw new Error("Closed-loop controller exited without a terminal state");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (evaluatorAttempted) {
      evaluatorCalls += 1;
      evaluatorAttempted = false;
    }
    const cancellation = cancellationFrom(
      error,
      options.signal,
      sideEffectStarted ? "mutation" : "read_only",
      sideEffectStarted,
    );
    if (cancellation) {
      await finalizeCancellation(session, cancellation);
      completeIteration("REVIEW_REQUIRED", { error: cancellation.message });
      if (activeIteration > 0) {
        await finishReport(activeIteration, "cancellation_requested");
      }
      return resultFor(session, normalizedPlan);
    }
    await session.writeJson("error.json", { message, side_effect_started: sideEffectStarted });
    if (sideEffectStarted && session.currentState !== "REVIEW_REQUIRED") {
      await session.transition("REVIEW_REQUIRED", {
        reason: "uncertain_backend_state",
        error: message,
      });
    } else if (session.currentState !== "FAILED" && session.currentState !== "REVIEW_REQUIRED") {
      await session.transition("FAILED", { error: message });
    }
    completeIteration("REVIEW_REQUIRED", { error: message });
    if (activeIteration > 0) {
      await finishReport(activeIteration, "controller_error");
    }
    return resultFor(session, normalizedPlan);
  } finally {
    await releaseBackendLease(session, options.backend, connected);
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
    throwIfCancellationRequested(options.signal, "read_only");
    const sanitizedPath = join(session.dir, "inputs", "analysis.jpg");
    await createSanitizedPreview(source.preview_path, sanitizedPath);
    throwIfCancellationRequested(options.signal, "read_only");
    await session.writeJson("inputs.json", {
      sanitized_preview: sanitizedPath,
      raw_uploaded: false,
      exif_sent: false,
    });
    await session.transition("ANALYZING");
    throwIfCancellationRequested(options.signal, "read_only");

    let providerResult: ProviderResult;
    try {
      providerResult = await options.provider.analyze(sanitizedPath);
      throwIfCancellationRequested(options.signal, "read_only");
    } catch (error) {
      if (options.signal?.aborted) {
        throw new WorkflowCancellationError("read_only", false, options.signal.reason);
      }
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
    throwIfCancellationRequested(options.signal, "read_only");
    normalizedPlan = translateIntent(providerResult.intent);
    await session.writeJson("normalized-edit-plan.json", normalizedPlan);
    await session.transition("PLAN_READY", { operation_count: normalizedPlan.operations.length });
    throwIfCancellationRequested(options.signal, "read_only");
    return await executePlan(session, source, photoId, normalizedPlan, {
      backend: options.backend,
      sessionRoot: options.sessionRoot,
      apply: options.apply,
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancellation = cancellationFrom(error, options.signal, "read_only", false);
    if (cancellation) {
      await finalizeCancellation(session, cancellation);
      return resultFor(session, normalizedPlan);
    }
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
  budget?: WorkflowBudgetOptions;
  signal?: AbortSignal;
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
    throwIfCancellationRequested(options.signal, "read_only");
    const providerResult = await new CodexProvider(options.intentFile).analyze();
    throwIfCancellationRequested(options.signal, "read_only");
    await writeProviderArtifacts(session, providerResult);
    normalizedPlan = translateIntent(providerResult.intent);
    await session.writeJson("normalized-edit-plan.json", normalizedPlan);
    await session.transition("PLAN_READY", { operation_count: normalizedPlan.operations.length });
    throwIfCancellationRequested(options.signal, "read_only");
    return await executePlan(session, source, photoId, normalizedPlan, {
      backend: options.backend,
      sessionRoot,
      apply: options.apply,
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.budget ? { budget: options.budget } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancellation = cancellationFrom(error, options.signal, "read_only", false);
    if (cancellation) {
      await finalizeCancellation(session, cancellation);
      return resultFor(session, normalizedPlan);
    }
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
  const evidenceBase = {
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
    await releaseBackendLease(session, options.backend, connected);
    if (unlock) await unlock();
  }
}
