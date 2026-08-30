import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { MIN_EVALUATION_CONFIDENCE, planFingerprint, renderFingerprint } from "./evaluation.js";
import {
  RECOVERY_OPERATIONS,
  requireBackendHandshake,
  SINGLE_PHOTO_OPERATIONS,
} from "./backend-handshake.js";
import { ingestPair } from "./ingest.js";
import { createSanitizedPreview } from "./preview.js";
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
import { acquireMutationLock, SessionStore } from "./runtime.js";
import {
  DevelopIterationIntentSchema,
  EvaluationResultSchema,
  RecoveryEvidenceSchema,
  WorkflowCopyIntentSchema,
  WorkflowCopyResultSchema,
  WorkflowCopyVerificationSchema,
} from "./schemas.js";
import type {
  BackendAdapter,
  EditEvaluator,
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

function sameDevelopSettings(
  left: Record<string, number | string | boolean>,
  right: Record<string, number | string | boolean>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
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
};

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
    const master = await options.backend.readCurrentEdit(photoId);
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
      workflowCopy.operation_id === operationId &&
      workflowCopy.source?.catalog_id === master.identity.catalog_id &&
      workflowCopy.source.uuid === master.identity.uuid &&
      workflowCopy.source.master_id === master.identity.catalog_id &&
      workflowCopy.source.master_uuid === master.identity.uuid &&
      workflowCopy.source.is_virtual_copy === false &&
      workflowCopy.master?.catalog_id === master.identity.catalog_id &&
      workflowCopy.master.uuid === master.identity.uuid &&
      workflowCopy.master.master_id === master.identity.catalog_id &&
      workflowCopy.master.master_uuid === master.identity.uuid &&
      workflowCopy.master.is_virtual_copy === false &&
      workflowCopy.copy?.catalog_id !== master.identity.catalog_id &&
      workflowCopy.copy?.master_id === master.identity.catalog_id &&
      workflowCopy.copy.master_uuid === master.identity.uuid &&
      workflowCopy.copy.is_virtual_copy === true &&
      workflowCopy.copy.uuid !== master.identity.uuid &&
      workflowCopy.selection_restoration.status !== "failed" &&
      workflowCopy.selection_restoration.verified;
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
      copyIdentity?.is_virtual_copy === true &&
      copyState.photo_id === workflowCopy.copy.catalog_id &&
      copyIdentity.catalog_id === workflowCopy.copy.catalog_id &&
      copyIdentity.uuid === workflowCopy.copy.uuid &&
      copyIdentity.master_id === master.identity.catalog_id &&
      copyIdentity.master_uuid === master.identity.uuid &&
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
    const startedAt = Date.now();
    let activePlan = normalizedPlan;
    let previousRenderHash: string | undefined;
    let previousPlanHash: string | undefined;
    let evaluatorCalls = 0;
    let totalTokens = 0;
    let estimatedCostUsd = 0;

    const finishReport = async (iterations: number, reason: string): Promise<void> => {
      await session.writeJson("iteration-report.json", {
        evaluator: options.evaluator?.name ?? null,
        iterations,
        evaluator_calls: evaluatorCalls,
        total_tokens: totalTokens,
        estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
        elapsed_ms: Date.now() - startedAt,
        terminal_state: session.currentState,
        reason,
      });
    };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const settings =
        iteration === 1
          ? initialSettings
          : resolveLightroomSettings(current.develop_settings, activePlan);
      const checkpointName = `PhotoAgent_${session.currentManifest.session_id}_iteration_${iteration}_before`;
      const iterationOperationId = `photoagent-iteration-${session.currentManifest.session_id}-${iteration}`;
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
      const checkpointEvidence = {
        operation_id: iterationOperationId,
        target: copyIdentity,
        checkpoint_name: checkpointName,
        checkpoint,
      };
      await session.writeJson(
        `checkpoints/iteration-${iteration}-before.json`,
        checkpointEvidence,
      );
      if (iteration === 1) await session.writeJson("checkpoints/before.json", checkpointEvidence);
      sideEffectStarted = true;
      await options.backend.applyGlobalAdjustment(activePhotoId, settings);
      const readBack = await options.backend.readCurrentEdit(activePhotoId);
      await session.writeJson(`backend-readback-iteration-${iteration}.json`, {
        operation_id: iterationOperationId,
        target: copyIdentity,
        checkpoint_name: checkpointName,
        requested: settings,
        read_back: readBack.develop_settings,
      });
      if (iteration === 1) {
        await session.writeJson("backend-readback.json", {
          operation_id: iterationOperationId,
          target: copyIdentity,
          checkpoint_name: checkpointName,
          requested: settings,
          read_back: readBack.develop_settings,
        });
      }
      for (const [key, value] of Object.entries(settings)) {
        if (readBack.develop_settings[key] !== value) {
          await session.transition("REVIEW_REQUIRED", {
            reason: "backend_readback_mismatch",
            key,
            iteration,
            rollback_checkpoint: checkpointName,
          });
          await finishReport(iteration, "backend_readback_mismatch");
          return resultFor(session, normalizedPlan, { iterations: iteration });
        }
      }
      current = readBack;
      await session.transition("RENDERING", { iteration });
      const render = await options.backend.renderPreview(
        activePhotoId,
        join(session.dir, "renders", `iteration-${iteration}`),
      );
      await session.writeJson(`render-iteration-${iteration}.json`, render);
      if (iteration === 1) await session.writeJson("render.json", render);
      if (!options.evaluator) {
        await session.transition("REVIEW_REQUIRED", {
          reason: "visual_evaluator_not_configured",
          render: render.path,
          rollback_checkpoint: checkpointName,
        });
        await finishReport(iteration, "visual_evaluator_not_configured");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }

      await session.transition("EVALUATING", { iteration, render: render.path });
      const evaluationPath = options.evaluator.requiresCloudPreview
        ? join(session.dir, "evaluations", `iteration-${iteration}-analysis.jpg`)
        : render.path;
      if (options.evaluator.requiresCloudPreview) {
        await createSanitizedPreview(render.path, evaluationPath);
      }
      const evaluation = EvaluationResultSchema.parse(
        await options.evaluator.evaluate({
          renderPath: evaluationPath,
          iteration,
          normalizedPlan: activePlan,
          readBack,
        }),
      );
      evaluatorCalls += evaluation.usage?.evaluator_calls ?? 1;
      totalTokens += evaluation.usage?.total_tokens ?? 0;
      estimatedCostUsd += evaluation.usage?.estimated_cost_usd ?? 0;
      await session.writeJson(`evaluations/iteration-${iteration}.json`, evaluation);

      if (evaluation.confidence < MIN_EVALUATION_CONFIDENCE || evaluation.verdict === "review") {
        await session.transition("REVIEW_REQUIRED", {
          reason:
            evaluation.confidence < MIN_EVALUATION_CONFIDENCE
              ? "low_evaluator_confidence"
              : "evaluator_requested_review",
          iteration,
          rollback_checkpoint: checkpointName,
        });
        await finishReport(iteration, "human_review_escalation");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }
      if (evaluation.verdict === "accept") {
        await session.transition("ACCEPTED", { iteration, render: render.path });
        await finishReport(iteration, "accepted");
        return resultFor(session, normalizedPlan, {
          renderPath: render.path,
          iterations: iteration,
        });
      }

      const nextPlan = evaluation.refinement_plan!;
      const renderHash = await renderFingerprint(render.path);
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
    }
    throw new Error("Closed-loop controller exited without a terminal state");
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
    result = WorkflowCopyResultSchema.parse(
      await session.readJson<unknown>("workflow-copy.json"),
    );
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
 * Reconcile a session left behind by a process crash. This function never
 * retries a mutation. If the backend may have been touched, it only reads
 * the current state and moves the session to REVIEW_REQUIRED.
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

  const checkpointArtifacts = await listJsonArtifacts(session, "checkpoints");
  const operationArtifacts = await listJsonArtifacts(session, "operations");
  const evidenceBase = {
    schema_version: "0.1.0" as const,
    interrupted_state: state,
    workflow_copy_intent: copyEvidence.intent ?? null,
    workflow_copy: copyEvidence.result ?? null,
    workflow_copy_verification: copyEvidence.verification ?? null,
    checkpoint_artifacts: checkpointArtifacts,
    operation_artifacts: operationArtifacts,
    invalid_artifacts: copyEvidence.invalidArtifacts,
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
  if (
    intent &&
    recordedResult &&
    (recordedResult.operation_id !== intent.operation_id ||
      (recordedResult.source !== undefined &&
        (recordedResult.source.catalog_id !== intent.source.catalog_id ||
          recordedResult.source.uuid !== intent.source.uuid ||
          recordedResult.source.is_virtual_copy)) ||
      (recordedResult.master !== undefined &&
        (recordedResult.master.catalog_id !== intent.source.catalog_id ||
          recordedResult.master.uuid !== intent.source.uuid ||
          recordedResult.master.is_virtual_copy)) ||
      (recordedCopy !== undefined &&
        (recordedCopy.master_id !== intent.source.catalog_id ||
          recordedCopy.master_uuid !== intent.source.uuid ||
          !recordedCopy.is_virtual_copy)) ||
      (recordedVerification !== undefined &&
        (recordedVerification.operation_id !== intent.operation_id ||
          recordedVerification.master.catalog_id !== intent.source.catalog_id ||
          recordedVerification.master.uuid !== intent.source.uuid ||
          recordedVerification.master.is_virtual_copy ||
          !recordedVerification.copy ||
          recordedVerification.copy.catalog_id !== recordedCopy?.catalog_id ||
          recordedVerification.copy.uuid !== recordedCopy?.uuid)))
  ) {
    return await recordWithoutReadback(
      "contradictory",
      "workflow_copy_artifacts_contradict_each_other",
    );
  }

  const targetPhotoId = recordedCopy?.catalog_id ?? intent?.source.catalog_id ?? options.photoId ??
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
    const current = await options.backend.readCurrentEdit(targetPhotoId);
    let evidenceStatus: RecoveryEvidence["evidence_status"] = "insufficient";
    let reason = "legacy_recovery_without_workflow_copy_evidence";
    if (recordedCopy && intent) {
      const identity = current.identity;
      const copyMatches =
        current.photo_id === recordedCopy.catalog_id &&
        identity?.catalog_id === recordedCopy.catalog_id &&
        identity.uuid === recordedCopy.uuid &&
        identity.master_id === intent.source.catalog_id &&
        identity.master_uuid === intent.source.uuid &&
        identity.is_virtual_copy &&
        samePath(current.path, session.currentManifest.source.raw_path);
      const completeResult =
        recordedResult?.result !== "REVIEW_REQUIRED" &&
        recordedResult?.partial === false &&
        recordedResult.source !== undefined &&
        recordedResult.master !== undefined &&
        recordedResult.selection_restoration.status !== "failed" &&
        recordedResult.selection_restoration.verified &&
        (recordedVerification === undefined ||
          (recordedVerification.verified &&
            recordedVerification.inherited_develop_state));
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
    } else if (intent) {
      const identity = current.identity;
      const sourceMatches =
        current.photo_id === intent.source.catalog_id &&
        identity?.catalog_id === intent.source.catalog_id &&
        identity.uuid === intent.source.uuid &&
        identity.master_id === intent.source.catalog_id &&
        identity.master_uuid === intent.source.uuid &&
        !identity.is_virtual_copy &&
        samePath(current.path, session.currentManifest.source.raw_path);
      evidenceStatus = sourceMatches ? "insufficient" : "contradictory";
      reason = sourceMatches
        ? "workflow_copy_creation_outcome_uncertain"
        : "workflow_copy_intent_source_contradicts_backend";
    } else if (!samePath(current.path, session.currentManifest.source.raw_path)) {
      evidenceStatus = "contradictory";
      reason = "legacy_recovery_path_mismatch";
    }
    const recoveryPath = await writeRecoveryEvidence(session, {
      ...evidenceBase,
      recovered_at: new Date().toISOString(),
      evidence_status: evidenceStatus,
      reason,
      target_photo_id: targetPhotoId,
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
