#!/usr/bin/env node
import { parseArgs } from "node:util";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LightroomMcpAdapter, MockBackend } from "./backends.js";
import { CodexProvider, MockProvider, OpenAIProvider } from "./providers.js";
import { SessionStore } from "./runtime.js";
import { SemanticIntentPlanSchema } from "./schemas.js";
import { resolveLightroomSettings, translateIntent } from "./translator.js";
import { recoverSession, resumeCodexSession, runSinglePhoto } from "./workflow.js";
import { writeXmpSidecar } from "./xmp.js";

const DEFAULT_LIGHTROOM_ENTRY = "D:\\photo\\lightroom-mcp-john\\server\\dist\\index.js";

function usage(): string {
  return [
    "photo-agent edit-one --raw <RAW> --preview <JPEG> --backend <mock|lightroom> --provider <codex|mock|openai> [--intent-file <JSON>] [--apply] [--allow-cloud-preview]",
    "photo-agent resume --session <SESSION_DIR> --intent-file <JSON> --backend <mock|lightroom> [--apply]",
    "photo-agent recover --session <SESSION_DIR> --backend <mock|lightroom> [--photo-id <ID>]",
    "photo-agent export-xmp --raw <RAW> --intent-file <JSON> --current-settings <JSON> --output <XMP>",
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
        : providerName === "mock"
          ? new MockProvider()
          : undefined;
  if (!provider) throw new Error(`Unsupported provider: ${providerName}`);
  const backend = createBackend(parsed.values.backend, raw, parsed.values["lightroom-mcp-entry"]);
  if (!backend) throw new Error(`Unsupported backend: ${parsed.values.backend}`);
  const result = await runSinglePhoto({
    rawPath: raw,
    previewPath: preview,
    ...(parsed.values["photo-id"] ? { photoId: parsed.values["photo-id"] } : {}),
    provider,
    backend,
    sessionRoot: parsed.values["session-root"],
    apply: parsed.values.apply,
    allowCloudPreview: parsed.values["allow-cloud-preview"],
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
  const result = await resumeCodexSession({
    sessionDir,
    intentFile,
    ...(parsed.values["photo-id"] ? { photoId: parsed.values["photo-id"] } : {}),
    backend,
    ...(parsed.values["session-root"] ? { sessionRoot: parsed.values["session-root"] } : {}),
    apply: parsed.values.apply,
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "edit-one") return editOne(argv.slice(1));
  if (argv[0] === "resume") return resume(argv.slice(1));
  if (argv[0] === "recover") return recover(argv.slice(1));
  if (argv[0] === "export-xmp") return exportXmp(argv.slice(1));
  console.error(usage());
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
