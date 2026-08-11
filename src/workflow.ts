import { join, resolve } from "node:path";

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
import type {
  BackendAdapter,
  NormalizedEditPlan,
  ProviderResult,
  SourceAssetPair,
  WorkflowOptions,
  WorkflowResult,
} from "./types.js";

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
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
  extra: { renderPath?: string; handoffPath?: string } = {},
): WorkflowResult {
  return {
    sessionDir: session.dir,
    state: session.currentState,
    manifest: session.currentManifest,
    normalizedPlan,
    ...(extra.renderPath ? { renderPath: extra.renderPath } : {}),
    ...(extra.handoffPath ? { handoffPath: extra.handoffPath } : {}),
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

  let sideEffectStarted = false;
  let unlock: (() => Promise<void>) | undefined;
  let connected = false;
  try {
    unlock = await acquireMutationLock(join(options.sessionRoot, "lightroom.mutation.lock"));
    await options.backend.connect();
    connected = true;
    await session.updateManifest({
      backend: { name: options.backend.name, version: options.backend.capabilities.version },
    });
    const current = await options.backend.readCurrentEdit(photoId);
    if (!samePath(current.path, source.raw_path)) {
      throw new Error(
        `Lightroom photo path mismatch; refusing mutation: ${current.path} <> ${source.raw_path}`,
      );
    }
    const settings = resolveLightroomSettings(current.develop_settings, normalizedPlan);
    const checkpointName = `PhotoAgent_${session.currentManifest.session_id}_before`;
    await session.transition("APPLYING", { checkpoint: checkpointName });
    const checkpoint = await options.backend.createCheckpoint(
      photoId,
      checkpointName,
      LIGHTROOM_CHECKPOINT_KEYS,
    );
    await session.writeJson("checkpoints/before.json", checkpoint);
    sideEffectStarted = true;
    await options.backend.applyGlobalAdjustment(photoId, settings);
    const readBack = await options.backend.readCurrentEdit(photoId);
    await session.writeJson("backend-readback.json", {
      requested: settings,
      read_back: readBack.develop_settings,
    });
    for (const [key, value] of Object.entries(settings)) {
      if (readBack.develop_settings[key] !== value) {
        await session.transition("REVIEW_REQUIRED", { reason: "backend_readback_mismatch", key });
        return resultFor(session, normalizedPlan);
      }
    }
    await session.transition("RENDERING");
    const render = await options.backend.renderPreview(photoId, join(session.dir, "renders"));
    await session.writeJson("render.json", render);
    await session.transition("REVIEW_REQUIRED", {
      reason: "visual_evaluator_not_in_alpha",
      render: render.path,
    });
    return resultFor(session, normalizedPlan, { renderPath: render.path });
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
};

export async function resumeCodexSession(options: ResumeCodexOptions): Promise<WorkflowResult> {
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
