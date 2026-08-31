#!/usr/bin/env node
import { parseArgs } from "node:util";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LightroomMcpAdapter, MockBackend } from "./backends.js";
import {
  ConservativeShootAnalyzer,
  loadReviewedShootAnalyzer,
  resumeShootDryRun,
  runShootDryRun,
} from "./batch.js";
import { AcceptingMockEvaluator, OpenAIEditEvaluator } from "./evaluation.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { CodexProvider, MockProvider, OpenAIProvider } from "./providers.js";
import { SessionStore } from "./runtime.js";
import { SemanticIntentPlanSchema } from "./schemas.js";
import { OpenAIShootAnalyzer } from "./shoot-analyzers.js";
import { translateIntent } from "./translator.js";
import type { WorkflowBudgetOptions } from "./types.js";
import { recoverSession, resumeCodexSession, runSinglePhoto } from "./workflow.js";
import { XmpSidecarBackend } from "./xmp-backend.js";

const DEFAULT_LIGHTROOM_ENTRY = "D:\\photo\\lightroom-mcp-john\\server\\dist\\index.js";

function usage(): string {
  return [
    "photo-agent edit-one --raw <RAW> --preview <JPEG> --backend <mock|lightroom> --provider <codex|mock|openai|anthropic> [--evaluator <none|mock|openai>] [--intent-file <JSON>] [--apply] [--allow-cloud-preview] [budget flags]",
    "photo-agent resume --session <SESSION_DIR> --intent-file <JSON> --backend <mock|lightroom> [--apply] [--evaluator <none|mock|openai>] [--allow-cloud-preview] [--max-iterations <1-10>] [budget flags]",
    "budget flags: --max-elapsed-ms <ms> --max-renders <n> --max-evaluator-calls <n> --max-total-tokens <n> --max-cost-usd <usd>",
    "photo-agent recover --session <SESSION_DIR> --backend <mock|lightroom> [--photo-id <ID>]",
    "photo-agent export-xmp --raw <RAW> --intent-file <JSON> --current-settings <JSON> --output <XMP>",
    "photo-agent shoot --root <SHOOT_DIR> [--session-root <DIR>] [--high-value-asset-id <ID> ...] [--analysis-file <REVIEW_JSON> | --analyzer openai --allow-cloud-preview]",
    "photo-agent shoot --resume <SESSION_DIR> [--analysis-file <REVIEW_JSON> | --analyzer openai --allow-cloud-preview]",
  ].join("\n");
}

function createBackend(
  backendName: string | undefined,
  rawPath: string,
  lightroomMcpEntry: string | undefined,
) {
  return backendName === "mock"
    ? new MockBackend(rawPath)
    : backendName === "lightroom"
      ? new LightroomMcpAdapter(lightroomMcpEntry ?? DEFAULT_LIGHTROOM_ENTRY)
      : undefined;
}

function createEvaluator(name: string | undefined) {
  if (name === undefined || name === "none") return undefined;
  if (name === "mock") return new AcceptingMockEvaluator();
  if (name === "openai") return new OpenAIEditEvaluator();
  throw new Error(`Unsupported evaluator: ${name}`);
}

function optionalBudgetNumber(value: string | undefined, option: string): number | undefined {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`--${option} must be a finite number`);
  return numeric;
}

function readWorkflowBudget(values: {
  "max-elapsed-ms"?: string;
  "max-renders"?: string;
  "max-evaluator-calls"?: string;
  "max-total-tokens"?: string;
  "max-cost-usd"?: string;
}): WorkflowBudgetOptions | undefined {
  const budget: WorkflowBudgetOptions = {};
  const maxElapsedMs = optionalBudgetNumber(values["max-elapsed-ms"], "max-elapsed-ms");
  const maxRenders = optionalBudgetNumber(values["max-renders"], "max-renders");
  const maxEvaluatorCalls = optionalBudgetNumber(
    values["max-evaluator-calls"],
    "max-evaluator-calls",
  );
  const maxTotalTokens = optionalBudgetNumber(values["max-total-tokens"], "max-total-tokens");
  const maxCostUsd = optionalBudgetNumber(values["max-cost-usd"], "max-cost-usd");
  if (maxElapsedMs !== undefined) budget.maxElapsedMs = maxElapsedMs;
  if (maxRenders !== undefined) budget.maxRenders = maxRenders;
  if (maxEvaluatorCalls !== undefined) budget.maxEvaluatorCalls = maxEvaluatorCalls;
  if (maxTotalTokens !== undefined) budget.maxTotalTokens = maxTotalTokens;
  if (maxCostUsd !== undefined) budget.maxCostUsd = maxCostUsd;
  return Object.keys(budget).length > 0 ? budget : undefined;
}

async function editOne(argv: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      raw: { type: "string" },
      preview: { type: "string" },
      "photo-id": { type: "string" },
      backend: { type: "string", default: "mock" },
      provider: { type: "string", default: "codex" },
      "intent-file": { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-cloud-preview": { type: "boolean", default: false },
      evaluator: { type: "string", default: "none" },
      "max-iterations": { type: "string", default: "3" },
      "max-elapsed-ms": { type: "string" },
      "max-renders": { type: "string" },
      "max-evaluator-calls": { type: "string" },
      "max-total-tokens": { type: "string" },
      "max-cost-usd": { type: "string" },
      "session-root": {
        type: "string",
        default: process.env.PHOTO_AGENT_SESSION_ROOT ?? ".photo-agent/sessions",
      },
      "lightroom-mcp-entry": {
        type: "string",
        default: process.env.PHOTO_AGENT_LIGHTROOM_MCP_ENTRY,
      },
    },
    allowPositionals: false,
    strict: true,
  });
  const raw = parsed.values.raw;
  const preview = parsed.values.preview;
  if (!raw || !preview) {
    console.error(usage());
    return 2;
  }
  const providerName = parsed.values.provider;
  const provider =
    providerName === "codex"
      ? new CodexProvider(parsed.values["intent-file"])
      : providerName === "openai"
        ? new OpenAIProvider()
        : providerName === "anthropic"
          ? new AnthropicProvider()
          : providerName === "mock"
            ? new MockProvider()
            : undefined;
  if (!provider) throw new Error(`Unsupported provider: ${providerName}`);
  const backend = createBackend(parsed.values.backend, raw, parsed.values["lightroom-mcp-entry"]);
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const evaluator = createEvaluator(parsed.values.evaluator);
  const budget = readWorkflowBudget(parsed.values);
  const result = await runSinglePhoto({
    rawPath: raw,
    previewPath: preview,
    ...(parsed.values["photo-id"] ? { photoId: parsed.values["photo-id"] } : {}),
    provider,
    backend,
    sessionRoot: parsed.values["session-root"],
    apply: parsed.values.apply,
    allowCloudPreview: parsed.values["allow-cloud-preview"],
    ...(evaluator ? { evaluator } : {}),
    maxIterations: Number(parsed.values["max-iterations"]),
    ...(budget ? { budget } : {}),
    ...(signal ? { signal } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : result.state === "CANCELLED" ? 130 : 0;
}

async function resume(argv: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      "intent-file": { type: "string" },
      "photo-id": { type: "string" },
      backend: { type: "string", default: "mock" },
      apply: { type: "boolean", default: false },
      "allow-cloud-preview": { type: "boolean", default: false },
      evaluator: { type: "string", default: "none" },
      "max-iterations": { type: "string", default: "3" },
      "max-elapsed-ms": { type: "string" },
      "max-renders": { type: "string" },
      "max-evaluator-calls": { type: "string" },
      "max-total-tokens": { type: "string" },
      "max-cost-usd": { type: "string" },
      "session-root": { type: "string", default: process.env.PHOTO_AGENT_SESSION_ROOT },
      "lightroom-mcp-entry": {
        type: "string",
        default: process.env.PHOTO_AGENT_LIGHTROOM_MCP_ENTRY,
      },
    },
    allowPositionals: false,
    strict: true,
  });
  const sessionDir = parsed.values.session;
  const intentFile = parsed.values["intent-file"];
  if (!sessionDir || !intentFile) {
    console.error(usage());
    return 2;
  }
  const session = await SessionStore.open(sessionDir);
  const rawPath = session.currentManifest.source.raw_path;
  const backend = createBackend(
    parsed.values.backend,
    rawPath,
    parsed.values["lightroom-mcp-entry"],
  );
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const evaluator = createEvaluator(parsed.values.evaluator);
  const budget = readWorkflowBudget(parsed.values);
  const result = await resumeCodexSession({
    sessionDir,
    intentFile,
    ...(parsed.values["photo-id"] ? { photoId: parsed.values["photo-id"] } : {}),
    backend,
    ...(parsed.values["session-root"] ? { sessionRoot: parsed.values["session-root"] } : {}),
    apply: parsed.values.apply,
    allowCloudPreview: parsed.values["allow-cloud-preview"],
    ...(evaluator ? { evaluator } : {}),
    maxIterations: Number(parsed.values["max-iterations"]),
    ...(budget ? { budget } : {}),
    ...(signal ? { signal } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : result.state === "CANCELLED" ? 130 : 0;
}

async function recover(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      "photo-id": { type: "string" },
      backend: { type: "string", default: "mock" },
      "lightroom-mcp-entry": {
        type: "string",
        default: process.env.PHOTO_AGENT_LIGHTROOM_MCP_ENTRY,
      },
    },
    allowPositionals: false,
    strict: true,
  });
  const sessionDir = parsed.values.session;
  if (!sessionDir) {
    console.error(usage());
    return 2;
  }
  const session = await SessionStore.open(sessionDir);
  const backend = createBackend(
    parsed.values.backend,
    session.currentManifest.source.raw_path,
    parsed.values["lightroom-mcp-entry"],
  );
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const result = await recoverSession({
    sessionDir,
    ...(parsed.values["photo-id"] ? { photoId: parsed.values["photo-id"] } : {}),
    backend,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : 0;
}

async function exportXmp(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      raw: { type: "string" },
      "intent-file": { type: "string" },
      "current-settings": { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  const rawPath = parsed.values.raw;
  const intentFile = parsed.values["intent-file"];
  const currentSettingsFile = parsed.values["current-settings"];
  const outputPath = parsed.values.output;
  if (!rawPath || !intentFile || !currentSettingsFile || !outputPath) {
    console.error(usage());
    return 2;
  }
  const raw = resolve(rawPath);
  await access(raw, constants.R_OK);
  const intent = SemanticIntentPlanSchema.parse(
    JSON.parse(await readFile(resolve(intentFile), "utf8")),
  );
  const current = JSON.parse(await readFile(resolve(currentSettingsFile), "utf8")) as Record<
    string,
    number | string | boolean
  >;
  const plan = translateIntent(intent);
  const output = resolve(outputPath);
  const result = await new XmpSidecarBackend().exportXmpSidecar({
    sourcePath: raw,
    destinationPath: output,
    currentSettings: current,
    plan,
  });
  console.log(
    JSON.stringify(
      {
        ...result,
        path: result.sidecar_path,
        operations: plan.operations.length,
        warnings: plan.warnings,
      },
      null,
      2,
    ),
  );
  return 0;
}

async function shoot(argv: string[], signal?: AbortSignal): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      resume: { type: "string" },
      "analysis-file": { type: "string" },
      analyzer: { type: "string", default: "conservative" },
      "allow-cloud-preview": { type: "boolean", default: false },
      "session-root": {
        type: "string",
        default: process.env.PHOTO_AGENT_SESSION_ROOT ?? ".photo-agent/shoots",
      },
      "high-value-asset-id": { type: "string", multiple: true },
    },
    allowPositionals: false,
    strict: true,
  });
  if (
    (!parsed.values.root && !parsed.values.resume) ||
    (parsed.values.root && parsed.values.resume)
  ) {
    console.error(usage());
    return 2;
  }
  if (parsed.values["analysis-file"] && parsed.values.analyzer !== "conservative") {
    throw new Error("Choose either --analysis-file or --analyzer, not both");
  }
  const analyzer = parsed.values["analysis-file"]
    ? await loadReviewedShootAnalyzer(parsed.values["analysis-file"])
    : parsed.values.analyzer === "openai"
      ? new OpenAIShootAnalyzer()
      : parsed.values.analyzer === "conservative"
        ? new ConservativeShootAnalyzer()
        : (() => {
            throw new Error(`Unsupported shoot analyzer: ${parsed.values.analyzer}`);
          })();
  const result = parsed.values.resume
    ? await resumeShootDryRun({
        sessionDir: parsed.values.resume,
        analyzer,
        allowCloudPreview: parsed.values["allow-cloud-preview"],
        ...(signal ? { signal } : {}),
      })
    : await runShootDryRun({
        shootRoot: parsed.values.root!,
        sessionRoot: parsed.values["session-root"],
        analyzer,
        allowCloudPreview: parsed.values["allow-cloud-preview"],
        ...(parsed.values["high-value-asset-id"]
          ? { highValueAssetIds: parsed.values["high-value-asset-id"] }
          : {}),
        ...(signal ? { signal } : {}),
      });
  console.log(
    JSON.stringify(
      {
        sessionDir: result.sessionDir,
        status: result.manifest.status,
        pending_assets: result.manifest.pending_asset_ids.length,
        summary: result.manifest.summary,
        clusters: result.manifest.clusters.length,
        duplicate_groups: result.manifest.duplicate_groups.length,
        burst_groups: result.manifest.burst_groups.length,
        near_duplicate_groups: result.manifest.near_duplicate_groups.length,
        report: resolve(result.sessionDir, "manifest.json"),
      },
      null,
      2,
    ),
  );
  return result.manifest.status === "CANCELLED" ? 130 : result.manifest.summary.failed > 0 ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort("process signal");
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (argv[0] === "edit-one") return await editOne(argv.slice(1), controller.signal);
    if (argv[0] === "resume") return await resume(argv.slice(1), controller.signal);
    if (argv[0] === "recover") return await recover(argv.slice(1));
    if (argv[0] === "export-xmp") return await exportXmp(argv.slice(1));
    if (argv[0] === "shoot") return await shoot(argv.slice(1), controller.signal);
    console.error(usage());
    return 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
