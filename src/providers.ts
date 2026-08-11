import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { SemanticIntentPlanSchema } from "./schemas.js";
import type { AnalysisProvider, ProviderResult } from "./types.js";

export const PROMPT_VERSION = "semantic-intent-v0.1.0";
export const PROMPT = `You are a photography editing assistant. Inspect the supplied sanitized preview and return a conservative semantic edit intent.

Return only the schema. Use no more than one adjustment per parameter. Choose unchanged when no correction is justified. Do not invent local masks, crops, presets, ratings, or delivery actions. Confidence below 0.65 will be ignored by the deterministic translator.`;

const promptHash = createHash("sha256").update(PROMPT).digest("hex");

export const CODEX_PROMPT_VERSION = "codex-local-v0.1.0";
export const CODEX_PROMPT = `Use the raw-photo-lightroom-preset skill to inspect one explicit RAW/preview pair and return a conservative SemanticIntentPlan JSON object.

Use the sanitized preview only for composition, focus, and expression triage. For color and tonal decisions, prefer a Lightroom or Camera Raw render of the RAW when the local Lightroom workflow is available. Do not mutate Lightroom during analysis. Never invent masks, crops, ratings, presets, delivery actions, or metadata changes. Keep confidence honest; the deterministic translator ignores confidence below 0.65.`;
export const CODEX_PROMPT_HASH = createHash("sha256").update(CODEX_PROMPT).digest("hex");

export class CodexInputRequiredError extends Error {
  constructor() {
    super("Codex review is required; provide a validated codex-intent.json and resume the session");
    this.name = "CodexInputRequiredError";
  }
}

export type CodexAnalysisRequest = {
  rawPath: string;
  previewPath: string;
  sanitizedPreviewPath: string;
  sessionDir: string;
  intentFilePath: string;
};

export async function writeCodexAnalysisRequest(
  requestPath: string,
  request: CodexAnalysisRequest,
): Promise<void> {
  const content = [
    "# Codex local photo analysis request",
    "",
    "This handoff intentionally does not call a visual-model API. Use the current Codex session and the `raw-photo-lightroom-preset` skill, then write the validated JSON to the intent file below.",
    "",
    "## Local inputs",
    `- RAW (never upload): \`${request.rawPath}\``,
    `- Source preview: \`${request.previewPath}\``,
    `- Sanitized preview for Codex inspection: \`${request.sanitizedPreviewPath}\``,
    `- Session directory: \`${request.sessionDir}\``,
    `- Intent output: \`${request.intentFilePath}\``,
    "",
    "## Required review route",
    "1. Read the skill instructions and relevant workflow/style-library references.",
    "2. Inspect the sanitized preview with the current Codex session's local image viewer (`view_image`). Do not send it to an external vision API.",
    "3. If Lightroom/MCP is actually connected, inspect the RAW metadata and a Lightroom/Camera Raw baseline render for color decisions. If it is not connected, state that limitation in the rationale and stay conservative.",
    "4. Write only a `SemanticIntentPlan` JSON object to the intent output path. Do not change Lightroom or any source photo in this review step.",
    "",
    "## JSON contract",
    'The object must contain `schema_version: "0.1.0"`, a non-empty `creative_goal`, an `adjustments` array with at most one entry per parameter, and `overall_confidence` from 0 to 1. Each adjustment uses `parameter`, `direction`, `strength`, `rationale`, and `confidence`.',
    "",
    "## Resume",
    `After writing the file, run: \`node dist/src/cli.js resume --session "${request.sessionDir}" --intent-file "${request.intentFilePath}" --backend mock --apply\``,
    "Use `--backend lightroom` only after confirming the local Lightroom/MCP connection and use a non-critical test photo.",
    "",
  ].join("\n");
  await mkdir(dirname(requestPath), { recursive: true });
  await writeFile(requestPath, content, "utf8");
}

export class MockProvider implements AnalysisProvider {
  readonly requiresCloudPreview = false;

  async analyze(): Promise<ProviderResult> {
    return {
      intent: SemanticIntentPlanSchema.parse({
        schema_version: "0.1.0",
        creative_goal: "neutral documentary correction",
        adjustments: [
          {
            parameter: "exposure",
            direction: "increase",
            strength: "slight",
            rationale: "Deterministic fixture adjustment",
            confidence: 0.9,
          },
          {
            parameter: "contrast",
            direction: "increase",
            strength: "slight",
            rationale: "Deterministic fixture adjustment",
            confidence: 0.9,
          },
        ],
        overall_confidence: 0.9,
      }),
      metadata: {
        provider: "mock",
        model: "fixture-v0.1",
        promptVersion: PROMPT_VERSION,
        promptHash,
        cloudPreview: false,
      },
    };
  }
}

export class CodexProvider implements AnalysisProvider {
  readonly requiresCloudPreview = false;

  constructor(private readonly intentFile?: string) {}

  async analyze(): Promise<ProviderResult> {
    if (!this.intentFile) throw new CodexInputRequiredError();
    const intent = SemanticIntentPlanSchema.parse(
      JSON.parse(await readFile(resolve(this.intentFile), "utf8")),
    );
    return {
      intent,
      metadata: {
        provider: "codex",
        model: "codex-local-session",
        promptVersion: CODEX_PROMPT_VERSION,
        promptHash: CODEX_PROMPT_HASH,
        cloudPreview: false,
      },
    };
  }
}

export class OpenAIProvider implements AnalysisProvider {
  readonly requiresCloudPreview = true;
  private readonly client: OpenAI;

  constructor(
    private readonly model = process.env.PHOTO_AGENT_OPENAI_MODEL ?? "gpt-5.6-terra",
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI provider");
    this.client = new OpenAI({ apiKey });
  }

  async analyze(previewPath: string): Promise<ProviderResult> {
    const base64 = (await readFile(previewPath)).toString("base64");
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      input: [
        {
          role: "developer",
          content: PROMPT,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Create the semantic edit intent for this preview." },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${base64}`,
              detail: "high",
            },
          ],
        },
      ],
      text: { format: zodTextFormat(SemanticIntentPlanSchema, "semantic_intent") },
    });

    const parsed = response.output_parsed;
    if (!parsed) throw new Error("OpenAI returned no structured semantic intent");
    const usage = response.usage;
    return {
      intent: SemanticIntentPlanSchema.parse(parsed),
      metadata: {
        provider: "openai",
        model: this.model,
        ...(response.id ? { responseId: response.id } : {}),
        promptVersion: PROMPT_VERSION,
        promptHash,
        ...(usage
          ? {
              usage: {
                ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
                ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
                ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
              },
            }
          : {}),
        cloudPreview: true,
      },
    };
  }
}
