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
import { AcceptingMockEvaluator, HandoffEvaluator, OpenAIEditEvaluator } from "./evaluation.js";
import { CodexProvider, MockProvider, OpenAIProvider } from "./providers.js";
import { SessionStore } from "./runtime.js";
import { SemanticIntentPlanSchema } from "./schemas.js";
import { OpenAIShootAnalyzer } from "./shoot-analyzers.js";
import { resolveLightroomSettings, translateIntent } from "./translator.js";
import { ClaudeEditEvaluator, ClaudeProvider } from "./claude.js";
import type { MaskPolicy } from "./types.js";
import { runUnattendedBatch } from "./unattended.js";
import {
  continueSession,
  recoverSession,
  restoreMasks,
  resumeCodexSession,
  runSinglePhoto,
} from "./workflow.js";
import { writeXmpSidecar } from "./xmp.js";

const DEFAULT_LIGHTROOM_ENTRY = "D:\\photo\\lightroom-mcp-john\\server\\dist\\index.js";

function usage(): string {
  return [
    "photo-agent edit-one --raw <RAW> --preview <JPEG> --backend <mock|lightroom> --provider <codex|mock|openai|claude> [--evaluator <none|mock|openai|claude>] [--intent-file <JSON>] [--apply] [--allow-cloud-preview] [--mode <interactive|unattended>] [--approve-masks <ids|all>] [--allow-mask-replace] [--web-references]",
    "photo-agent resume --session <SESSION_DIR> --intent-file <JSON> --backend <mock|lightroom> [--apply] [--evaluator <none|mock|openai|claude>] [--allow-cloud-preview] [--max-iterations <1-10>] [--mode <interactive|unattended>] [--approve-masks <ids|all>] [--allow-mask-replace]",
    "photo-agent batch --root <SHOOT_DIR> [--backend lightroom] [--provider codex|claude|openai|mock] [--evaluator handoff|claude|openai|mock|none] [--allow-cloud-preview] [--mode unattended|interactive] [--max-iterations <1-10>] [--limit <N>] [--web-references] [--batch-root <DIR>]",
    "photo-agent continue --session <SESSION_DIR> --evaluation-file <JSON> --backend <mock|lightroom> [--evaluator handoff|claude|openai|mock|none]",
    "photo-agent batch --resume <BATCH_DIR> [same provider/evaluator/backend flags]",
    "photo-agent recover --session <SESSION_DIR> --backend <mock|lightroom> [--photo-id <ID>]",
    "photo-agent restore-masks --session <SESSION_DIR> --iteration <N> --backend <mock|lightroom>",
    "photo-agent export-xmp --raw <RAW> --intent-file <JSON> --current-settings <JSON> --output <XMP>",
    "photo-agent shoot --root <SHOOT_DIR> [--session-root <DIR>] [--analysis-file <REVIEW_JSON> | --analyzer openai --allow-cloud-preview]",
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
  if (name === "claude") return new ClaudeEditEvaluator();
  if (name === "handoff") return new HandoffEvaluator();
  throw new Error(`Unsupported evaluator: ${name}`);
}

function createProvider(name: string | undefined, intentFile?: string, webReferences = false) {
  if (name === "codex") return new CodexProvider(intentFile);
  if (name === "openai") return new OpenAIProvider();
  if (name === "mock") return new MockProvider();
  if (name === "claude") return new ClaudeProvider({ webReferences });
  throw new Error(`Unsupported provider: ${name}`);
}

const MASK_OPTIONS = {
  mode: { type: "string", default: "interactive" },
  "approve-masks": { type: "string" },
  "allow-mask-replace": { type: "boolean", default: false },
} as const;

/**
 * interactive: subjective masks wait for --approve-masks; masks are written
 *   only when existing masks can be read back (or --allow-mask-replace).
 * unattended: every capped mask is applied; the evaluator halves or removes
 *   bad ones; a write-only backend may replace the Workflow Copy's inherited
 *   masks when no XMP sidecar shows existing masks (the Master keeps them).
 */
export function maskPolicyFromFlags(values: {
  mode?: string;
  "approve-masks"?: string;
  "allow-mask-replace"?: boolean;
}): MaskPolicy {
  if (values.mode !== "interactive" && values.mode !== "unattended") {
    throw new Error(`Unsupported --mode: ${values.mode}`);
  }
  const unattended = values.mode === "unattended";
  const approved = values["approve-masks"];
  return {
    unattended,
    allowUnverifiedReplace: unattended || values["allow-mask-replace"] === true,
    approvedMaskIds:
      approved === undefined
        ? []
        : approved === "all"
          ? "all"
          : approved
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
  };
}

async function editOne(argv: string[]): Promise<number> {
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
      "web-references": { type: "boolean", default: false },
      ...MASK_OPTIONS,
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
  const provider = createProvider(
    parsed.values.provider,
    parsed.values["intent-file"],
    parsed.values["web-references"],
  );
  const backend = createBackend(parsed.values.backend, raw, parsed.values["lightroom-mcp-entry"]);
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const evaluator = createEvaluator(parsed.values.evaluator);
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
    maskPolicy: maskPolicyFromFlags(parsed.values),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : 0;
}

async function resume(argv: string[]): Promise<number> {
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
      ...MASK_OPTIONS,
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
    maskPolicy: maskPolicyFromFlags(parsed.values),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : 0;
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

async function restoreMasksCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      iteration: { type: "string" },
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
  const iteration = Number(parsed.values.iteration);
  if (!sessionDir || !Number.isInteger(iteration) || iteration < 1) {
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
  const result = await restoreMasks({ sessionDir, backend, iteration });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

async function continueCommand(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      "evaluation-file": { type: "string" },
      backend: { type: "string", default: "mock" },
      evaluator: { type: "string", default: "handoff" },
      "allow-cloud-preview": { type: "boolean", default: false },
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
  const evaluationFile = parsed.values["evaluation-file"];
  if (!sessionDir || !evaluationFile) {
    console.error(usage());
    return 2;
  }
  const evaluator = createEvaluator(parsed.values.evaluator);
  if (evaluator?.requiresCloudPreview && !parsed.values["allow-cloud-preview"]) {
    throw new Error("This evaluator requires --allow-cloud-preview; no render was sent");
  }
  const session = await SessionStore.open(sessionDir);
  const backend = createBackend(
    parsed.values.backend,
    session.currentManifest.source.raw_path,
    parsed.values["lightroom-mcp-entry"],
  );
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const result = await continueSession({
    sessionDir,
    evaluationFile,
    backend,
    ...(parsed.values["session-root"] ? { sessionRoot: parsed.values["session-root"] } : {}),
    ...(evaluator ? { evaluator } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.state === "FAILED" ? 1 : 0;
}

async function batch(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      root: { type: "string" },
      resume: { type: "string" },
      backend: { type: "string", default: "lightroom" },
      // Default: agent-driven. Claude Code / Codex looks at each image and
      // writes the JSON files listed in worklist.md; no model API is called.
      provider: { type: "string", default: "codex" },
      evaluator: { type: "string", default: "handoff" },
      "allow-cloud-preview": { type: "boolean", default: false },
      "max-iterations": { type: "string", default: "3" },
      "max-consecutive-failures": { type: "string", default: "5" },
      limit: { type: "string" },
      "web-references": { type: "boolean", default: false },
      ...MASK_OPTIONS,
      mode: { type: "string", default: "unattended" },
      "batch-root": {
        type: "string",
        default: process.env.PHOTO_AGENT_BATCH_ROOT ?? ".photo-agent/batches",
      },
      "lightroom-mcp-entry": {
        type: "string",
        default: process.env.PHOTO_AGENT_LIGHTROOM_MCP_ENTRY,
      },
    },
    allowPositionals: false,
    strict: true,
  });
  if (Boolean(parsed.values.root) === Boolean(parsed.values.resume)) {
    console.error(usage());
    return 2;
  }
  const providerName = parsed.values.provider;
  const evaluatorName = parsed.values.evaluator;
  // Fail fast on bad names or missing credentials before indexing anything.
  createProvider(providerName, undefined, parsed.values["web-references"]);
  createEvaluator(evaluatorName);
  const limit = parsed.values.limit === undefined ? undefined : Number(parsed.values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const result = await runUnattendedBatch({
    ...(parsed.values.root ? { root: parsed.values.root } : {}),
    ...(parsed.values.resume ? { resumeDir: parsed.values.resume } : {}),
    batchRoot: parsed.values["batch-root"],
    providerFactory: () => createProvider(providerName, undefined, parsed.values["web-references"]),
    evaluatorFactory: () => createEvaluator(evaluatorName),
    backendFactory: (rawPath) => {
      const backend = createBackend(
        parsed.values.backend,
        rawPath,
        parsed.values["lightroom-mcp-entry"],
      );
      if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
      return backend;
    },
    allowCloudPreview: parsed.values["allow-cloud-preview"],
    maxIterations: Number(parsed.values["max-iterations"]),
    maxConsecutiveFailures: Number(parsed.values["max-consecutive-failures"]),
    maskPolicy: maskPolicyFromFlags(parsed.values),
    mode: parsed.values.mode === "interactive" ? "interactive" : "unattended",
    labels: {
      provider: providerName,
      evaluator: evaluatorName === "none" ? null : evaluatorName,
      backend: parsed.values.backend,
    },
    ...(limit !== undefined ? { limit } : {}),
    onProgress: (record, index, total) => {
      console.error(
        `[${index + 1}/${total}] ${record.relative_raw_path}: ${record.state}${record.reason ? ` (${record.reason})` : ""}${record.error ? ` ${record.error}` : ""}`,
      );
    },
  });
  const counts: Record<string, number> = {};
  for (const record of result.records) counts[record.state] = (counts[record.state] ?? 0) + 1;
  console.log(
    JSON.stringify(
      {
        batchDir: result.batchDir,
        report: result.reportPath,
        worklist: result.worklistPath,
        waiting_for_agent: result.waiting,
        stoppedEarly: result.stoppedEarly ?? null,
        counts,
      },
      null,
      2,
    ),
  );
  return result.stoppedEarly ? 1 : 0;
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
  const settings = resolveLightroomSettings(current, plan);
  const output = resolve(outputPath);
  if (output.toLowerCase() === raw.toLowerCase()) {
    throw new Error("XMP output cannot overwrite the RAW source");
  }
  const path = await writeXmpSidecar(output, settings);
  console.log(
    JSON.stringify({ path, operations: plan.operations.length, warnings: plan.warnings }, null, 2),
  );
  return 0;
}

async function shoot(argv: string[]): Promise<number> {
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
      })
    : await runShootDryRun({
        shootRoot: parsed.values.root!,
        sessionRoot: parsed.values["session-root"],
        analyzer,
        allowCloudPreview: parsed.values["allow-cloud-preview"],
      });
  console.log(
    JSON.stringify(
      {
        sessionDir: result.sessionDir,
        summary: result.manifest.summary,
        clusters: result.manifest.clusters.length,
        duplicate_groups: result.manifest.duplicate_groups.length,
        burst_groups: result.manifest.burst_groups.length,
        report: resolve(result.sessionDir, "manifest.json"),
      },
      null,
      2,
    ),
  );
  return result.manifest.summary.failed > 0 ? 1 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "edit-one") return editOne(argv.slice(1));
  if (argv[0] === "resume") return resume(argv.slice(1));
  if (argv[0] === "recover") return recover(argv.slice(1));
  if (argv[0] === "export-xmp") return exportXmp(argv.slice(1));
  if (argv[0] === "shoot") return shoot(argv.slice(1));
  if (argv[0] === "batch") return batch(argv.slice(1));
  if (argv[0] === "continue") return continueCommand(argv.slice(1));
  if (argv[0] === "restore-masks") return restoreMasksCommand(argv.slice(1));
  console.error(usage());
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
