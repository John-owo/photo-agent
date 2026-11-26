import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { requireBackendHandshake } from "./backend-handshake.js";
import { indexShoot } from "./batch.js";
import { SessionStore } from "./runtime.js";
import type {
  AnalysisProvider,
  BackendAdapter,
  EditEvaluator,
  JobState,
  MaskPolicy,
  ShootAsset,
} from "./types.js";
import { continueSession, recoverSession, resumeCodexSession, runSinglePhoto } from "./workflow.js";

/**
 * Unattended ("overnight") batch editing.
 *
 * Every photo goes through the normal single-photo controller, so each one
 * gets its own verified Workflow Copy (the Master is never edited), durable
 * intent/readback evidence, and recover support. The batch adds:
 * - per-photo isolation: one failure never stops the rest;
 * - a circuit breaker: stop after N consecutive failures (Lightroom gone,
 *   API key rejected) instead of burning through the whole folder;
 * - resume: finished photos are skipped; a photo interrupted mid-mutation is
 *   only read back through `recover`, never re-applied;
 * - a morning report (Traditional Chinese Markdown + JSON).
 */

export type BatchItemState = JobState | "SKIPPED" | "STARTED";

export type BatchItemRecord = {
  asset_id: string;
  relative_raw_path: string;
  state: BatchItemState;
  started_at?: string;
  finished_at?: string;
  session_dir?: string;
  render_path?: string;
  iterations?: number;
  reason?: string;
  error?: string;
  preview_source?: "camera_jpeg" | "lightroom_baseline";
  masks?: {
    mode?: string;
    requested?: string[];
    final_applied?: string[];
    pending_review?: string[];
    degrade_reason?: string;
    notes?: string[];
  };
  evaluator_calls?: number;
  total_tokens?: number;
};

export type BatchManifest = {
  schema_version: "0.4.0";
  batch_id: string;
  root: string;
  created_at: string;
  mode: "unattended" | "interactive";
  options: {
    provider: string;
    evaluator: string | null;
    backend: string;
    max_iterations: number;
    max_consecutive_failures: number;
    limit: number | null;
  };
  assets: ShootAsset[];
};

export type UnattendedBatchOptions = {
  root?: string;
  batchRoot: string;
  resumeDir?: string;
  providerFactory: () => AnalysisProvider;
  evaluatorFactory: () => EditEvaluator | undefined;
  backendFactory: (rawPath: string) => BackendAdapter;
  allowCloudPreview: boolean;
  maxIterations: number;
  maskPolicy: MaskPolicy;
  mode: "unattended" | "interactive";
  labels: { provider: string; evaluator: string | null; backend: string };
  limit?: number;
  maxConsecutiveFailures?: number;
  /** Called after every photo; the CLI prints progress. */
  onProgress?: (record: BatchItemRecord, index: number, total: number) => void;
};

export type UnattendedBatchResult = {
  batchDir: string;
  records: BatchItemRecord[];
  stoppedEarly?: string;
  reportPath: string;
  worklistPath: string;
  /** Photos waiting for an agent-written JSON file. */
  waiting: number;
};

const TERMINAL: ReadonlySet<BatchItemState> = new Set([
  "ACCEPTED",
  "REVIEW_REQUIRED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
]);

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function itemPath(batchDir: string, assetId: string): string {
  return join(batchDir, "items", `${assetId}.json`);
}

async function lastSessionReason(sessionDir: string): Promise<string | undefined> {
  try {
    // Only the latest event describes the current state; older reasons are stale.
    const lines = (await readFile(join(sessionDir, "session.log"), "utf8")).trim().split("\n");
    const event = JSON.parse(lines.at(-1) ?? "{}") as { reason?: unknown; error?: unknown };
    if (typeof event.reason === "string") return event.reason;
    if (typeof event.error === "string") return event.error;
  } catch {
    return undefined;
  }
  return undefined;
}

async function sessionDirsForRaw(sessionsRoot: string, rawPath: string): Promise<string[]> {
  const names = await readdir(sessionsRoot).catch(() => [] as string[]);
  const matches: string[] = [];
  for (const name of names) {
    const dir = join(sessionsRoot, name);
    try {
      const session = await SessionStore.open(dir);
      if (
        resolve(session.currentManifest.source.raw_path).toLowerCase() ===
        resolve(rawPath).toLowerCase()
      ) {
        matches.push(dir);
      }
    } catch {
      continue;
    }
  }
  return matches.sort();
}

/**
 * RAW-only folders have no camera JPEG. Export a baseline render of the
 * Master (a new file in the batch directory; nothing in the catalog changes)
 * and name it after the RAW so the normal pairing rules still hold.
 */
async function renderBaselinePreview(
  backend: BackendAdapter,
  asset: ShootAsset,
  batchDir: string,
): Promise<string> {
  const directory = join(batchDir, "previews", asset.id);
  await backend.connect();
  try {
    await requireBackendHandshake(backend, ["read_current_edit", "render_preview"]);
    const photoId = (await backend.resolvePhotoId?.(asset.raw_path)) ?? asset.raw_path;
    const render = await backend.renderPreview(photoId, join(directory, "export"));
    const target = join(
      directory,
      `${basename(asset.raw_path, extname(asset.raw_path))}${extname(render.path).toLowerCase()}`,
    );
    await copyFile(render.path, target, constants.COPYFILE_EXCL);
    return target;
  } finally {
    await backend.close();
  }
}

async function summarizeSession(sessionDir: string): Promise<Partial<BatchItemRecord>> {
  const report = await readJsonFile<{
    reason?: string;
    evaluator_calls?: number;
    total_tokens?: number;
    masks?: BatchItemRecord["masks"];
  }>(join(sessionDir, "iteration-report.json"));
  const reason = (await lastSessionReason(sessionDir)) ?? report?.reason;
  return {
    ...(reason ? { reason } : {}),
    ...(report?.masks ? { masks: report.masks } : {}),
    ...(report?.evaluator_calls !== undefined ? { evaluator_calls: report.evaluator_calls } : {}),
    ...(report?.total_tokens !== undefined ? { total_tokens: report.total_tokens } : {}),
  };
}

export async function runUnattendedBatch(
  options: UnattendedBatchOptions,
): Promise<UnattendedBatchResult> {
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
  let batchDir: string;
  let manifest: BatchManifest;
  if (options.resumeDir) {
    batchDir = resolve(options.resumeDir);
    const loaded = await readJsonFile<BatchManifest>(join(batchDir, "batch.json"));
    if (!loaded) throw new Error(`No batch.json in ${batchDir}`);
    manifest = loaded;
  } else {
    if (!options.root) throw new Error("A batch needs --root or --resume");
    const batchId = `batch-${new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "")}-${randomUUID().slice(0, 6)}`;
    batchDir = resolve(options.batchRoot, batchId);
    await mkdir(batchDir, { recursive: true });
    const assets = await indexShoot(options.root);
    manifest = {
      schema_version: "0.4.0",
      batch_id: batchId,
      root: resolve(options.root),
      created_at: new Date().toISOString(),
      mode: options.mode,
      options: {
        provider: options.labels.provider,
        evaluator: options.labels.evaluator,
        backend: options.labels.backend,
        max_iterations: options.maxIterations,
        max_consecutive_failures: maxConsecutiveFailures,
        limit: options.limit ?? null,
      },
      assets: options.limit !== undefined ? assets.slice(0, options.limit) : assets,
    };
    await writeJson(join(batchDir, "batch.json"), manifest);
  }

  const sessionsRoot = join(batchDir, "sessions");
  const records: BatchItemRecord[] = [];
  let consecutiveFailures = 0;
  let stoppedEarly: string | undefined;

  for (const [index, asset] of manifest.assets.entries()) {
    const path = itemPath(batchDir, asset.id);
    const previous = await readJsonFile<BatchItemRecord>(path);
    if (previous && TERMINAL.has(previous.state)) {
      records.push(previous);
      continue;
    }
    if (stoppedEarly) {
      records.push(
        previous ?? {
          asset_id: asset.id,
          relative_raw_path: asset.relative_raw_path,
          state: "PENDING",
        },
      );
      continue;
    }

    // Agent-driven photos wait for a JSON file written by Claude Code / Codex.
    // When the file exists, advance the photo; otherwise keep it waiting.
    if (previous && WAITING.has(previous.state) && previous.session_dir) {
      const pending = await pendingInput(previous.session_dir, previous.state);
      if (!pending.ready) {
        records.push(previous);
        continue;
      }
      await writeJson(path, {
        ...previous,
        state: "STARTED",
        started_at: new Date().toISOString(),
      });
      let record: BatchItemRecord;
      try {
        const evaluator = options.evaluatorFactory();
        const result =
          previous.state === "CODEX_INPUT_REQUIRED"
            ? await resumeCodexSession({
                sessionDir: previous.session_dir,
                intentFile: pending.inputPath,
                backend: options.backendFactory(asset.raw_path),
                apply: true,
                allowCloudPreview: options.allowCloudPreview,
                ...(evaluator ? { evaluator } : {}),
                maxIterations: options.maxIterations,
                maskPolicy: options.maskPolicy,
              })
            : await continueSession({
                sessionDir: previous.session_dir,
                evaluationFile: pending.inputPath,
                backend: options.backendFactory(asset.raw_path),
                ...(evaluator ? { evaluator } : {}),
              });
        record = await recordFromResult(previous, result);
      } catch (error) {
        // continue/resume left the session untouched; keep it waiting.
        const session = await SessionStore.open(previous.session_dir);
        record = {
          ...previous,
          state: session.currentState,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await writeJson(path, record);
      records.push(record);
      options.onProgress?.(record, index, manifest.assets.length);
      consecutiveFailures = record.state === "FAILED" ? consecutiveFailures + 1 : 0;
      continue;
    }

    // A photo that was STARTED but never finished may have been mutated.
    // Never re-apply it: read back through recover and leave it for review.
    if (previous?.state === "STARTED") {
      const dirs = previous.session_dir
        ? [previous.session_dir]
        : await sessionDirsForRaw(sessionsRoot, asset.raw_path);
      const record: BatchItemRecord = {
        ...previous,
        state: "REVIEW_REQUIRED",
        reason: "interrupted_before_finish",
      };
      const last = dirs.at(-1);
      if (last) {
        try {
          const recovered = await recoverSession({
            sessionDir: last,
            backend: options.backendFactory(asset.raw_path),
          });
          record.session_dir = recovered.sessionDir;
          record.reason = `interrupted_then_recovered: ${(await lastSessionReason(last)) ?? recovered.state}`;
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
        }
      }
      record.finished_at = new Date().toISOString();
      await writeJson(path, record);
      records.push(record);
      options.onProgress?.(record, index, manifest.assets.length);
      continue;
    }

    const base: BatchItemRecord = {
      asset_id: asset.id,
      relative_raw_path: asset.relative_raw_path,
      state: "STARTED",
      started_at: new Date().toISOString(),
    };
    if (asset.source_confidence === "ambiguous") {
      const record: BatchItemRecord = {
        ...base,
        state: "SKIPPED",
        reason: "ambiguous_raw_preview_pairing",
        finished_at: new Date().toISOString(),
      };
      await writeJson(path, record);
      records.push(record);
      options.onProgress?.(record, index, manifest.assets.length);
      continue;
    }
    await writeJson(path, base);
    let record: BatchItemRecord;
    try {
      let previewPath = asset.preview_path;
      let previewSource: BatchItemRecord["preview_source"] = "camera_jpeg";
      if (!previewPath) {
        previewPath = await renderBaselinePreview(
          options.backendFactory(asset.raw_path),
          asset,
          batchDir,
        );
        previewSource = "lightroom_baseline";
      }
      const evaluator = options.evaluatorFactory();
      const result = await runSinglePhoto({
        rawPath: asset.raw_path,
        previewPath,
        provider: options.providerFactory(),
        backend: options.backendFactory(asset.raw_path),
        sessionRoot: sessionsRoot,
        apply: true,
        allowCloudPreview: options.allowCloudPreview,
        ...(evaluator ? { evaluator } : {}),
        maxIterations: options.maxIterations,
        maskPolicy: options.maskPolicy,
      });
      record = await recordFromResult({ ...base, preview_source: previewSource }, result);
    } catch (error) {
      record = {
        ...base,
        state: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      };
    }
    await writeJson(path, record);
    records.push(record);
    options.onProgress?.(record, index, manifest.assets.length);
    consecutiveFailures = record.state === "FAILED" ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      stoppedEarly = `${consecutiveFailures} consecutive failures; last error: ${record.error ?? record.reason ?? "unknown"}`;
    }
  }

  const reportPath = await writeMorningReport(batchDir, manifest, records, stoppedEarly);
  const worklist = await writeWorklist(batchDir, records);
  return {
    batchDir,
    records,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    reportPath,
    worklistPath: worklist.path,
    waiting: worklist.items.length,
  };
}

const WAITING: ReadonlySet<BatchItemState> = new Set([
  "CODEX_INPUT_REQUIRED",
  "EVALUATION_INPUT_REQUIRED",
]);

export type WorkItem = {
  asset_id: string;
  relative_raw_path: string;
  kind: "analyze" | "evaluate";
  /** Image the agent must look at. */
  image: string;
  /** For evaluate: the unedited preview to compare against. */
  before?: string;
  /** Markdown with the rules and the JSON contract. */
  request: string;
  /** Where the agent writes its JSON. */
  output: string;
  ready: boolean;
};

async function pendingInput(
  sessionDir: string,
  state: BatchItemState,
): Promise<{
  kind: WorkItem["kind"];
  inputPath: string;
  requestPath: string;
  image: string;
  before?: string;
  ready: boolean;
}> {
  const exists = async (path: string) =>
    readFile(path).then(
      () => true,
      () => false,
    );
  if (state === "CODEX_INPUT_REQUIRED") {
    const inputPath = join(sessionDir, "codex-intent.json");
    return {
      kind: "analyze",
      inputPath,
      requestPath: join(sessionDir, "codex-analysis-request.md"),
      image: join(sessionDir, "inputs", "analysis.jpg"),
      ready: await exists(inputPath),
    };
  }
  const loopState = await readJsonFile<{ paused?: { iteration: number; renderPath: string } }>(
    join(sessionDir, "loop-state.json"),
  );
  const iteration = loopState?.paused?.iteration ?? 1;
  const inputPath = join(sessionDir, "evaluations", `iteration-${iteration}-input.json`);
  const session = await SessionStore.open(sessionDir);
  return {
    kind: "evaluate",
    inputPath,
    requestPath: join(sessionDir, "evaluations", `iteration-${iteration}-request.md`),
    image: loopState?.paused?.renderPath ?? "",
    before: session.currentManifest.source.preview_path,
    ready: await exists(inputPath),
  };
}

async function recordFromResult(
  base: BatchItemRecord,
  result: Awaited<ReturnType<typeof runSinglePhoto>>,
): Promise<BatchItemRecord> {
  const { error: _error, reason: _reason, ...rest } = base;
  void _error;
  void _reason;
  return {
    ...rest,
    state: result.state,
    session_dir: result.sessionDir,
    ...(result.renderPath ? { render_path: result.renderPath } : {}),
    ...(result.iterations !== undefined ? { iterations: result.iterations } : {}),
    ...(await summarizeSession(result.sessionDir)),
    ...(WAITING.has(result.state) ? {} : { finished_at: new Date().toISOString() }),
  };
}

async function writeWorklist(
  batchDir: string,
  records: BatchItemRecord[],
): Promise<{ path: string; items: WorkItem[] }> {
  const items: WorkItem[] = [];
  for (const record of records) {
    if (!WAITING.has(record.state) || !record.session_dir) continue;
    const pending = await pendingInput(record.session_dir, record.state);
    items.push({
      asset_id: record.asset_id,
      relative_raw_path: record.relative_raw_path,
      kind: pending.kind,
      image: pending.image,
      ...(pending.before ? { before: pending.before } : {}),
      request: pending.requestPath,
      output: pending.inputPath,
      ready: pending.ready,
    });
  }
  const lines = [
    "# photo-agent batch worklist",
    "",
    items.length === 0
      ? "Nothing is waiting for the agent. Read report.md."
      : `${items.length} photo(s) wait for the agent. For each item: open the request, look at the image (and the before preview for evaluate), write exactly one JSON object to the output path, then run \`photo-agent batch --resume "${batchDir}"\` again.`,
    "",
  ];
  for (const item of items) {
    lines.push(
      `## ${item.relative_raw_path} (${item.kind === "analyze" ? "analyze: write SemanticIntentPlan" : "evaluate: write EvaluationResult"})`,
      "",
      `- request: \`${item.request}\``,
      `- image: \`${item.image}\``,
      ...(item.before ? [`- before: \`${item.before}\``] : []),
      `- output: \`${item.output}\`${item.ready ? " (already written; will be applied on the next resume)" : ""}`,
      "",
    );
  }
  const path = join(batchDir, "worklist.md");
  await writeFile(path, lines.join("\n"), "utf8");
  await writeJson(join(batchDir, "worklist.json"), { batch_dir: batchDir, items });
  return { path, items };
}

const STATE_LABEL: Record<string, string> = {
  ACCEPTED: "完成",
  REVIEW_REQUIRED: "需要你看",
  FAILED: "失敗",
  SKIPPED: "略過",
  PENDING: "未處理",
  STARTED: "中斷",
  CODEX_INPUT_REQUIRED: "等 agent 分析",
  EVALUATION_INPUT_REQUIRED: "等 agent 評估",
};

const REASON_LABEL: Record<string, string> = {
  visual_evaluator_not_configured: "沒有設定評估器，套用一次後就停下",
  evaluator_requested_review: "評估器認為需要人工判斷",
  low_evaluator_confidence: "評估器信心不足",
  closed_loop_stalled: "反覆修正沒有進展",
  iteration_budget_exhausted: "用完迭代次數",
  mask_placement_questioned: "評估器質疑遮罩位置",
  mask_placement_requires_user_confirmation: "遮罩位置較主觀，等你確認",
  mask_readback_mismatch: "遮罩寫入後讀回不一致",
  backend_does_not_support_geometric_masks: "後端不支援遮罩，只做全域調整",
  no_effective_adjustments: "沒有需要調整的地方",
  no_executable_operations: "沒有可執行的調整",
  uncertain_backend_state: "Lightroom 狀態不確定，請用 recover 檢查",
  ambiguous_raw_preview_pairing: "RAW 與預覽配對不明確",
  interrupted_before_finish: "上次執行中斷",
};

function describeReason(reason: string | undefined): string {
  if (!reason) return "";
  const key = reason.split(":")[0]!.trim();
  return REASON_LABEL[key] ? `${REASON_LABEL[key]}（${reason}）` : reason;
}

function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export async function writeMorningReport(
  batchDir: string,
  manifest: BatchManifest,
  records: BatchItemRecord[],
  stoppedEarly?: string,
): Promise<string> {
  const count = (state: string) => records.filter((record) => record.state === state).length;
  const tokens = records.reduce((sum, record) => sum + (record.total_tokens ?? 0), 0);
  const withMaskNotes = records.filter(
    (record) =>
      (record.masks?.notes?.length ?? 0) > 0 ||
      (record.masks?.pending_review?.length ?? 0) > 0 ||
      record.masks?.degrade_reason !== undefined,
  );
  const lines: string[] = [
    `# 晨間修圖報告：${manifest.batch_id}`,
    "",
    `- 來源資料夾：\`${manifest.root}\``,
    `- 模式：${manifest.mode === "unattended" ? "無人值守" : "互動"}；provider：${manifest.options.provider}；評估器：${manifest.options.evaluator ?? "無"}；後端：${manifest.options.backend}`,
    `- 共 ${manifest.assets.length} 張：完成 ${count("ACCEPTED")}、需要你看 ${count("REVIEW_REQUIRED")}、失敗 ${count("FAILED")}、略過 ${count("SKIPPED")}、等 agent ${count("CODEX_INPUT_REQUIRED") + count("EVALUATION_INPUT_REQUIRED")}、未處理 ${count("PENDING") + count("STARTED")}`,
    `- 評估器 token 用量（不含分析）：${tokens}`,
    "",
    "所有修改都只寫在 photo-agent 建立的虛擬複本（Workflow Copy）上，原始照片（Master）沒有被改動。不滿意的照片直接刪掉那張虛擬複本即可。",
    "",
  ];
  if (stoppedEarly) {
    lines.push(
      `> **批次提前停止**：${stoppedEarly}。修好原因後用 \`photo-agent batch --resume "${batchDir}"\` 接著跑，已完成的照片會略過。`,
      "",
    );
  }
  const attention = records.filter(
    (record) => record.state === "REVIEW_REQUIRED" || record.state === "FAILED",
  );
  if (attention.length > 0) {
    lines.push("## 需要你看的照片", "", "| 照片 | 狀態 | 原因 | 渲染 |", "|---|---|---|---|");
    for (const record of attention) {
      lines.push(
        `| ${cell(record.relative_raw_path)} | ${STATE_LABEL[record.state] ?? record.state} | ${cell(describeReason(record.reason) || record.error || "")} | ${record.render_path ? `\`${cell(record.render_path)}\`` : ""} |`,
      );
    }
    lines.push("");
  }
  if (withMaskNotes.length > 0) {
    lines.push("## 遮罩紀錄", "");
    for (const record of withMaskNotes) {
      lines.push(
        `- **${record.relative_raw_path}**：模式 ${record.masks?.mode ?? "?"}，最後套用 ${record.masks?.final_applied?.join(", ") || "無"}`,
      );
      if (record.masks?.degrade_reason)
        lines.push(`  - 降級原因：${describeReason(record.masks.degrade_reason)}`);
      if (record.masks?.pending_review?.length)
        lines.push(`  - 等你確認：${record.masks.pending_review.join(", ")}`);
      for (const note of record.masks?.notes ?? []) lines.push(`  - ${note}`);
    }
    lines.push("");
  }
  lines.push("## 全部照片", "", "| 照片 | 狀態 | 迭代 | 遮罩 | 說明 |", "|---|---|---|---|---|");
  for (const record of records) {
    lines.push(
      `| ${cell(record.relative_raw_path)} | ${STATE_LABEL[record.state] ?? record.state} | ${record.iterations ?? ""} | ${cell(record.masks?.final_applied?.join(", ") ?? "")} | ${cell(describeReason(record.reason) || record.error || "")} |`,
    );
  }
  lines.push("");
  const reportPath = join(batchDir, "report.md");
  await writeFile(reportPath, lines.join("\n"), "utf8");
  await writeJson(join(batchDir, "report.json"), {
    batch_id: manifest.batch_id,
    generated_at: new Date().toISOString(),
    stopped_early: stoppedEarly ?? null,
    records,
  });
  return reportPath;
}
