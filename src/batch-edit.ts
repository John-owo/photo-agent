import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { acquireMutationLock } from "./runtime.js";
import { PROPAGATION_OPERATIONS, requireBackendHandshake } from "./backend-handshake.js";
import {
  assertBackendSupportsPlan,
  PARAMETER_REGISTRY_VERSION,
  selectPropagatableOperations,
} from "./parameter-registry.js";
import { LIGHTROOM_CHECKPOINT_KEYS, resolveLightroomSettings } from "./translator.js";
import { PropagationPlanSchema, RepresentativeJobSchema } from "./schemas.js";
import type {
  AnalysisProvider,
  BackendPhotoIdentity,
  BackendPhotoState,
  BackendAdapter,
  EditEvaluator,
  PropagationPlan,
  ShootAsset,
  ShootManifest,
  WorkflowBudgetOptions,
  WorkflowCopyResult,
  WorkflowResult,
  NormalizedOperation,
} from "./types.js";
import { recoverSession, runSinglePhoto } from "./workflow.js";

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function sameIdentity(
  left: BackendPhotoIdentity | undefined,
  right: BackendPhotoIdentity,
): boolean {
  return (
    left?.catalog_id === right.catalog_id &&
    left.uuid === right.uuid &&
    left.master_id === right.master_id &&
    left.master_uuid === right.master_uuid &&
    left.is_virtual_copy === right.is_virtual_copy
  );
}

function isMasterState(state: BackendPhotoState): state is BackendPhotoState & {
  identity: BackendPhotoIdentity;
} {
  const identity = state.identity;
  return Boolean(
    identity &&
    !identity.is_virtual_copy &&
    identity.catalog_id === state.photo_id &&
    identity.master_id === identity.catalog_id &&
    identity.master_uuid === identity.uuid,
  );
}

function sameDevelopSettings(
  left: Record<string, number | string | boolean>,
  right: Record<string, number | string | boolean>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

function isVerifiedWorkflowCopy(
  result: WorkflowCopyResult,
  master: BackendPhotoIdentity,
  operationId: string,
): boolean {
  return Boolean(
    result.operation_id === operationId &&
    (result.result === "created" || result.result === "reconciled") &&
    !result.partial &&
    result.master &&
    sameIdentity(result.master, master) &&
    result.copy &&
    result.copy.is_virtual_copy &&
    result.copy.master_id === master.catalog_id &&
    result.copy.master_uuid === master.uuid,
  );
}

function sameNormalizedOperation(left: NormalizedOperation, right: NormalizedOperation): boolean {
  return (
    left.parameter === right.parameter &&
    left.mode === right.mode &&
    left.value === right.value &&
    left.confidence === right.confidence &&
    left.rationale === right.rationale
  );
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function validatePropagationPlanForApply(
  manifest: ShootManifest,
  candidate: PropagationPlan,
): PropagationPlan {
  const plan = PropagationPlanSchema.parse(candidate);
  if (plan.parameter_registry_version !== PARAMETER_REGISTRY_VERSION) {
    throw new Error(
      `Unsupported propagation parameter registry version: ${plan.parameter_registry_version ?? "missing"}`,
    );
  }
  const cluster = manifest.clusters.find((item) => item.cluster_id === plan.cluster_id);
  if (!cluster) throw new Error(`Propagation plan references unknown cluster: ${plan.cluster_id}`);
  if (cluster.representative_id !== plan.representative_id) {
    throw new Error("Propagation plan representative does not match the manifest cluster");
  }
  const memberIds = new Set(cluster.member_ids);
  const outlierIds = new Set(cluster.outlier_ids);
  const excludedIds = new Set(plan.excluded.map((item) => item.asset_id));
  const seenTargetIds = new Set<string>();
  const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));

  for (const target of plan.targets) {
    if (seenTargetIds.has(target.asset_id)) {
      throw new Error(`Propagation plan contains duplicate target: ${target.asset_id}`);
    }
    seenTargetIds.add(target.asset_id);
    if (
      target.asset_id === plan.representative_id ||
      !memberIds.has(target.asset_id) ||
      outlierIds.has(target.asset_id) ||
      excludedIds.has(target.asset_id)
    ) {
      throw new Error(
        `Propagation plan target is outside the eligible cluster scope: ${target.asset_id}`,
      );
    }
    const asset = assetsById.get(target.asset_id);
    if (
      !asset ||
      normalizeRelativePath(asset.relative_raw_path) !==
        normalizeRelativePath(target.relative_raw_path)
    ) {
      throw new Error(
        `Propagation plan target path does not match asset identity: ${target.asset_id}`,
      );
    }
    const targetParameters = target.operations.map((operation) => operation.parameter);
    if (
      targetParameters.length !== plan.operation_parameters.length ||
      targetParameters.some((parameter, index) => parameter !== plan.operation_parameters[index])
    ) {
      throw new Error(
        `Propagation plan target operations do not match its parameter allowlist: ${target.asset_id}`,
      );
    }
    const allowedOperations = selectPropagatableOperations(
      {
        schema_version: "0.1.0",
        parameter_registry_version: PARAMETER_REGISTRY_VERSION,
        operations: target.operations,
        warnings: [],
      },
      plan.operation_parameters,
    );
    if (
      allowedOperations.length !== target.operations.length ||
      allowedOperations.some(
        (operation, index) => !sameNormalizedOperation(operation, target.operations[index]!),
      )
    ) {
      throw new Error(
        `Propagation plan contains operations not authorized by the parameter registry: ${target.asset_id}`,
      );
    }
  }
  return plan;
}

export type RepresentativeEditRecord = {
  cluster_id: string;
  representative_id: string | null;
  state: "ACCEPTED" | "REVIEW_REQUIRED" | "FAILED";
  workflow_session_root?: string;
  result?: WorkflowResult;
  reason?: string;
};

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

async function readRepresentativeJob(path: string) {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Failed to read representative job " +
        path +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    return RepresentativeJobSchema.parse(JSON.parse(contents));
  } catch (error) {
    throw new Error(
      "Invalid representative job artifact " +
        path +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

async function latestWorkflowSession(root: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
  return directories.at(-1);
}

function recordFromJob(
  job: NonNullable<Awaited<ReturnType<typeof readRepresentativeJob>>>,
): RepresentativeEditRecord | undefined {
  if (job.state === "RUNNING") return undefined;
  return {
    cluster_id: job.cluster_id,
    representative_id: job.representative_id,
    state: job.state,
    ...(job.workflow_session_root ? { workflow_session_root: job.workflow_session_root } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.reason ? { reason: job.reason } : {}),
  };
}

async function writeRepresentativeJob(
  path: string,
  record: Omit<RepresentativeEditRecord, "state"> & {
    state: RepresentativeEditRecord["state"] | "RUNNING";
  },
): Promise<void> {
  await writeJsonAtomic(
    path,
    RepresentativeJobSchema.parse({
      schema_version: "0.3.0",
      ...record,
    }),
  );
}

export async function runRepresentativeEdits(options: {
  manifest: ShootManifest;
  sessionRoot: string;
  providerFactory: (asset: ShootAsset) => AnalysisProvider;
  backendFactory: (asset: ShootAsset) => BackendAdapter;
  evaluatorFactory?: (asset: ShootAsset) => EditEvaluator;
  apply: boolean;
  allowCloudPreview: boolean;
  maxIterations?: number;
  budget?: WorkflowBudgetOptions;
}): Promise<RepresentativeEditRecord[]> {
  const assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]));
  const records: RepresentativeEditRecord[] = [];
  const sessionRoot = resolve(options.sessionRoot);
  const jobRoot = join(sessionRoot, "jobs");
  await mkdir(jobRoot, { recursive: true });
  for (const cluster of options.manifest.clusters) {
    const jobPath = join(jobRoot, cluster.cluster_id + ".json");
    const workflowSessionRoot = join(sessionRoot, cluster.cluster_id);
    const existing = await readRepresentativeJob(jobPath);
    if (existing?.state === "RUNNING") {
      const runningAsset = existing.representative_id
        ? assets.get(existing.representative_id)
        : undefined;
      const recoveryRoot = existing.workflow_session_root ?? workflowSessionRoot;
      const sessionDir = await latestWorkflowSession(recoveryRoot);
      if (runningAsset && sessionDir) {
        try {
          const recoveredResult = await recoverSession({
            sessionDir,
            backend: options.backendFactory(runningAsset),
            photoId: runningAsset.raw_path,
          });
          const recoveredRecord: RepresentativeEditRecord = {
            cluster_id: cluster.cluster_id,
            representative_id: existing.representative_id,
            workflow_session_root: recoveryRoot,
            state: recoveredResult.state === "ACCEPTED" ? "ACCEPTED" : "REVIEW_REQUIRED",
            result: recoveredResult,
            ...(recoveredResult.state === "ACCEPTED"
              ? {}
              : { reason: "incomplete_representative_requires_recovery" }),
          };
          await writeRepresentativeJob(jobPath, recoveredRecord);
          records.push(recoveredRecord);
          continue;
        } catch (error) {
          records.push({
            cluster_id: cluster.cluster_id,
            representative_id: existing.representative_id,
            workflow_session_root: recoveryRoot,
            state: "REVIEW_REQUIRED",
            reason:
              "representative_recovery_failed: " +
              (error instanceof Error ? error.message : String(error)),
          });
          continue;
        }
      }
      records.push({
        cluster_id: cluster.cluster_id,
        representative_id: existing.representative_id,
        workflow_session_root: recoveryRoot,
        state: "REVIEW_REQUIRED",
        reason: "incomplete_representative_requires_recovery",
      });
      continue;
    }
    if (existing) {
      const existingRecord = recordFromJob(existing);
      if (existingRecord) {
        records.push(existingRecord);
        continue;
      }
    }
    if (!cluster.representative_id) {
      const record: RepresentativeEditRecord = {
        cluster_id: cluster.cluster_id,
        representative_id: null,
        state: "REVIEW_REQUIRED",
        reason: "cluster_has_no_shortlisted_representative",
      };
      await writeRepresentativeJob(jobPath, record);
      records.push(record);
      continue;
    }
    const asset = assets.get(cluster.representative_id);
    const ingestionErrors = asset?.ingestion_errors ?? [];
    if (
      !asset ||
      !asset.preview_path ||
      asset.source_confidence !== "high" ||
      ingestionErrors.length > 0
    ) {
      const record: RepresentativeEditRecord = {
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: "REVIEW_REQUIRED",
        reason:
          ingestionErrors.length > 0
            ? "representative_source_has_ingestion_errors"
            : "representative_source_is_not_unambiguous",
      };
      await writeRepresentativeJob(jobPath, record);
      records.push(record);
      continue;
    }
    await writeRepresentativeJob(jobPath, {
      cluster_id: cluster.cluster_id,
      representative_id: cluster.representative_id,
      workflow_session_root: workflowSessionRoot,
      state: "RUNNING",
    });
    try {
      const evaluator = options.evaluatorFactory?.(asset);
      const result = await runSinglePhoto({
        rawPath: asset.raw_path,
        previewPath: asset.preview_path,
        photoId: asset.raw_path,
        provider: options.providerFactory(asset),
        backend: options.backendFactory(asset),
        sessionRoot: workflowSessionRoot,
        apply: options.apply,
        allowCloudPreview: options.allowCloudPreview,
        ...(evaluator ? { evaluator } : {}),
        ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
      });
      const record: RepresentativeEditRecord = {
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: result.state === "ACCEPTED" ? "ACCEPTED" : "REVIEW_REQUIRED",
        workflow_session_root: workflowSessionRoot,
        result,
      };
      await writeRepresentativeJob(jobPath, record);
      records.push(record);
    } catch (error) {
      const record: RepresentativeEditRecord = {
        cluster_id: cluster.cluster_id,
        representative_id: cluster.representative_id,
        state: "FAILED",
        workflow_session_root: workflowSessionRoot,
        reason: error instanceof Error ? error.message : String(error),
      };
      await writeRepresentativeJob(jobPath, record);
      records.push(record);
    }
  }
  return records;
}

export type PropagationApplyRecord = {
  asset_id: string;
  state: "APPLIED" | "REVIEW_REQUIRED" | "FAILED";
  checkpoint?: string;
  workflow_copy_id?: string;
  workflow_copy_verified?: true;
  reason?: string;
};

export async function applyPropagationPlan(options: {
  manifest: ShootManifest;
  plan: PropagationPlan;
  sessionDir: string;
  backendFactory: (asset: ShootAsset) => BackendAdapter;
  confirmApply: boolean;
  representativeResults: RepresentativeEditRecord[];
}): Promise<PropagationApplyRecord[]> {
  if (!options.confirmApply) {
    throw new Error("Propagation requires confirmApply=true; no backend was mutated");
  }
  const representative = options.representativeResults.find(
    (record) =>
      record.cluster_id === options.plan.cluster_id &&
      record.representative_id === options.plan.representative_id,
  );
  if (
    !representative ||
    representative.state !== "ACCEPTED" ||
    !representative.result ||
    representative.result.state !== "ACCEPTED" ||
    !representative.result.renderPath
  ) {
    throw new Error(
      "Propagation requires an ACCEPTED representative result with persisted evidence",
    );
  }
  const plan = validatePropagationPlanForApply(options.manifest, options.plan);
  const assets = new Map(options.manifest.assets.map((asset) => [asset.id, asset]));
  const records: PropagationApplyRecord[] = [];
  let sharedFailure: string | undefined;
  const unlock = await acquireMutationLock(join(resolve(options.sessionDir), "propagation.lock"), {
    sessionId: options.manifest.session_id,
    backend: "batch-propagation",
  });
  try {
    for (const target of plan.targets) {
      if (sharedFailure) {
        records.push({
          asset_id: target.asset_id,
          state: "REVIEW_REQUIRED",
          reason: "shared_backend_uncertainty:" + sharedFailure,
        });
        continue;
      }
      const asset = assets.get(target.asset_id);
      if (
        !asset ||
        asset.source_confidence !== "high" ||
        (asset.ingestion_errors ?? []).length > 0
      ) {
        records.push({
          asset_id: target.asset_id,
          state: "REVIEW_REQUIRED",
          reason: "target_source_is_not_unambiguous",
        });
        continue;
      }
      const backend = options.backendFactory(asset);
      let connected = false;
      let handshakeComplete = false;
      let workflowCopyAttempted = false;
      let workflowCopyId: string | undefined;
      let workflowCopyVerified = false;
      let mutationStarted = false;
      const checkpoint = `PhotoAgent_${options.manifest.session_id}_${target.asset_id}_before_propagation`;
      try {
        await backend.connect();
        connected = true;
        const backendManifest = await requireBackendHandshake(backend, PROPAGATION_OPERATIONS);
        handshakeComplete = true;
        assertBackendSupportsPlan(backendManifest, {
          schema_version: "0.1.0",
          parameter_registry_version: PARAMETER_REGISTRY_VERSION,
          operations: target.operations,
          warnings: [],
        });
        const current = await backend.readCurrentEdit(asset.raw_path);
        if (!samePath(current.path, asset.raw_path)) {
          records.push({
            asset_id: target.asset_id,
            state: "REVIEW_REQUIRED",
            reason: "Propagation target path mismatch; refusing mutation",
          });
          continue;
        }
        if (!isMasterState(current)) {
          records.push({
            asset_id: target.asset_id,
            state: "REVIEW_REQUIRED",
            reason: "Propagation source identity is not a verified Master",
          });
          continue;
        }
        const copyOperationId =
          "photoagent-propagation-" + options.manifest.session_id + "-" + target.asset_id;
        workflowCopyAttempted = true;
        const workflowCopy = await backend.createWorkflowCopy(
          current.identity.catalog_id,
          current.identity.uuid,
          copyOperationId,
        );
        if (
          !workflowCopy.copy ||
          !isVerifiedWorkflowCopy(workflowCopy, current.identity, copyOperationId)
        ) {
          throw new Error(
            workflowCopy.reason ?? "Workflow Copy verification failed; propagation stopped",
          );
        }
        workflowCopyId = workflowCopy.copy.catalog_id;
        const copyState = await backend.readCurrentEdit(workflowCopyId);
        if (
          !copyState.identity ||
          !sameIdentity(copyState.identity, workflowCopy.copy) ||
          !copyState.identity.is_virtual_copy ||
          copyState.identity.master_id !== current.identity.catalog_id ||
          copyState.identity.master_uuid !== current.identity.uuid ||
          !samePath(copyState.path, current.path) ||
          !sameDevelopSettings(copyState.develop_settings, current.develop_settings)
        ) {
          throw new Error("Workflow Copy readback did not verify identity and inherited state");
        }
        workflowCopyVerified = true;
        const settings = resolveLightroomSettings(copyState.develop_settings, {
          schema_version: "0.1.0",
          operations: target.operations,
          warnings: [],
        });
        await backend.createCheckpoint(workflowCopyId, checkpoint, LIGHTROOM_CHECKPOINT_KEYS);
        mutationStarted = true;
        await backend.applyGlobalAdjustment(workflowCopyId, settings);
        const readBack = await backend.readCurrentEdit(workflowCopyId);
        const mismatch = Object.entries(settings).find(
          ([key, value]) => readBack.develop_settings[key] !== value,
        );
        records.push(
          mismatch
            ? {
                asset_id: target.asset_id,
                state: "REVIEW_REQUIRED",
                checkpoint,
                workflow_copy_id: workflowCopyId,
                ...(workflowCopyVerified ? { workflow_copy_verified: true as const } : {}),
                reason: `backend_readback_mismatch:${mismatch[0]}`,
              }
            : {
                asset_id: target.asset_id,
                state: "APPLIED",
                checkpoint,
                workflow_copy_id: workflowCopyId,
                workflow_copy_verified: true,
              },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const uncertain = !handshakeComplete || workflowCopyAttempted || mutationStarted;
        records.push({
          asset_id: target.asset_id,
          state: uncertain ? "REVIEW_REQUIRED" : "FAILED",
          ...(mutationStarted ? { checkpoint } : {}),
          ...(workflowCopyId ? { workflow_copy_id: workflowCopyId } : {}),
          ...(workflowCopyVerified ? { workflow_copy_verified: true as const } : {}),
          reason,
        });
        if (uncertain) sharedFailure = reason;
      } finally {
        if (connected) {
          try {
            await backend.close();
          } catch (error) {
            const closeReason =
              "backend_close_failed:" + (error instanceof Error ? error.message : String(error));
            const last = records.at(-1);
            if (last?.asset_id === target.asset_id) {
              records[records.length - 1] = {
                ...last,
                state: "REVIEW_REQUIRED",
                reason: last.reason ? `${last.reason}; ${closeReason}` : closeReason,
              };
            } else {
              records.push({
                asset_id: target.asset_id,
                state: "REVIEW_REQUIRED",
                reason: closeReason,
              });
            }
            sharedFailure = sharedFailure ? `${sharedFailure}; ${closeReason}` : closeReason;
          }
        }
      }
    }
  } finally {
    await unlock();
  }
  return records;
}
