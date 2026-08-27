import { join, resolve } from "node:path";

import { acquireMutationLock } from "./runtime.js";
import { PROPAGATION_OPERATIONS, requireBackendHandshake } from "./backend-handshake.js";
import { LIGHTROOM_CHECKPOINT_KEYS, resolveLightroomSettings } from "./translator.js";
import type {
  AnalysisProvider,
  BackendAdapter,
  EditEvaluator,
  PropagationPlan,
  ShootAsset,
  ShootManifest,
  WorkflowResult,
} from "./types.js";
import { runSinglePhoto } from "./workflow.js";

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

export type RepresentativeEditRecord = {
  cluster_id: string;
  representative_id: string | null;
  state: "ACCEPTED" | "REVIEW_REQUIRED" | "FAILED";
  result?: WorkflowResult;
  reason?: string;
};

export async function runRepresentativeEdits(options: {
  manifest: ShootManifest;
  sessionRoot: string;
  providerFactory: (asset: ShootAsset) => AnalysisProvider;
  backendFactory: (asset: ShootAsset) => BackendAdapter;
  evaluatorFactory?: (asset: ShootAsset) => EditEvaluator;
  apply: boolean;
  allowCloudPreview: boolean;
  maxIterations?: number;
}): Promise<RepresentativeEditRecord[]> {
  const assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]));
  const records: RepresentativeEditRecord[] = [];
  for (const cluster of options.manifest.clusters) {
    if (!cluster.representative_id) {
      records.push({
        cluster_id: cluster.cluster_id,
        representative_id: null,
        state: "REVIEW_REQUIRED",
        reason: "cluster_has_no_shortlisted_representative",
      });
      continue;
    }
    const asset = assets.get(cluster.representative_id);
    if (!asset || !asset.preview_path || asset.source_confidence !== "high") {
      records.push({
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: "REVIEW_REQUIRED",
        reason: "representative_source_is_not_unambiguous",
      });
      continue;
    }
    try {
      const evaluator = options.evaluatorFactory?.(asset);
      const result = await runSinglePhoto({
        rawPath: asset.raw_path,
        previewPath: asset.preview_path,
        photoId: asset.raw_path,
        provider: options.providerFactory(asset),
        backend: options.backendFactory(asset),
        sessionRoot: join(resolve(options.sessionRoot), cluster.cluster_id),
        apply: options.apply,
        allowCloudPreview: options.allowCloudPreview,
        ...(evaluator ? { evaluator } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      });
      records.push({
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: result.state === "ACCEPTED" ? "ACCEPTED" : "REVIEW_REQUIRED",
        result,
      });
    } catch (error) {
      records.push({
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: "FAILED",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return records;
}

export type PropagationApplyRecord = {
  asset_id: string;
  state: "APPLIED" | "REVIEW_REQUIRED" | "FAILED";
  checkpoint?: string;
  reason?: string;
};

export async function applyPropagationPlan(options: {
  manifest: ShootManifest;
  plan: PropagationPlan;
  sessionDir: string;
  backendFactory: (asset: ShootAsset) => BackendAdapter;
  confirmApply: boolean;
}): Promise<PropagationApplyRecord[]> {
  if (!options.confirmApply) {
    throw new Error("Propagation requires confirmApply=true; no backend was mutated");
  }
  const assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]));
  const records: PropagationApplyRecord[] = [];
  const unlock = await acquireMutationLock(join(resolve(options.sessionDir), "propagation.lock"), {
    sessionId: options.manifest.session_id,
    backend: "batch-propagation",
  });
  try {
    for (const target of options.plan.targets) {
      const asset = assets.get(target.asset_id);
      if (!asset || asset.source_confidence !== "high") {
        records.push({
          asset_id: target.asset_id,
          state: "REVIEW_REQUIRED",
          reason: "target_source_is_not_unambiguous",
        });
        continue;
      }
      const backend = options.backendFactory(asset);
      let connected = false;
      let mutationStarted = false;
      const checkpoint = `PhotoAgent_${options.manifest.session_id}_${target.asset_id}_before_propagation`;
      try {
        await backend.connect();
        connected = true;
        await requireBackendHandshake(backend, PROPAGATION_OPERATIONS);
        const current = await backend.readCurrentEdit(asset.raw_path);
        if (!samePath(current.path, asset.raw_path)) {
          throw new Error("Propagation target path mismatch; refusing mutation");
        }
        const settings = resolveLightroomSettings(current.develop_settings, {
          schema_version: "0.1.0",
          operations: target.operations,
          warnings: [],
        });
        await backend.createCheckpoint(asset.raw_path, checkpoint, LIGHTROOM_CHECKPOINT_KEYS);
        mutationStarted = true;
        await backend.applyGlobalAdjustment(asset.raw_path, settings);
        const readBack = await backend.readCurrentEdit(asset.raw_path);
        const mismatch = Object.entries(settings).find(
          ([key, value]) => readBack.develop_settings[key] !== value,
        );
        records.push(
          mismatch
            ? {
                asset_id: target.asset_id,
                state: "REVIEW_REQUIRED",
                checkpoint,
                reason: `backend_readback_mismatch:${mismatch[0]}`,
              }
            : { asset_id: target.asset_id, state: "APPLIED", checkpoint },
        );
      } catch (error) {
        records.push({
          asset_id: target.asset_id,
          state: mutationStarted ? "REVIEW_REQUIRED" : "FAILED",
          ...(mutationStarted ? { checkpoint } : {}),
          reason: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (connected) await backend.close();
      }
    }
  } finally {
    await unlock();
  }
  return records;
}
