import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  PROVIDER_CONTRACT_VERSION,
  ProviderCapabilityManifestSchema,
  ProviderResultSchema,
  SCHEMA_VERSION,
  SemanticIntentPlanSchema,
} from "./schemas.js";
import type { AnalysisProvider, ProviderResult } from "./types.js";

export const ANTHROPIC_PROMPT_VERSION = "anthropic-visual-v0.1.0";
export const ANTHROPIC_PROMPT = `You are a photography editing assistant. Inspect the supplied sanitized preview and return a conservative semantic edit intent.

Return only a JSON object matching the SemanticIntentPlan schema. Use no more than one adjustment per parameter. Choose unchanged when no correction is justified. Do not invent local masks, crops, presets, ratings, or delivery actions. Confidence below 0.65 will be ignored by the deterministic translator.`;
export const ANTHROPIC_PROMPT_HASH = createHash("sha256").update(ANTHROPIC_PROMPT).digest("hex");

export const ANTHROPIC_PROVIDER_CAPABILITIES = ProviderCapabilityManifestSchema.parse({
  schema_version: SCHEMA_VERSION,
  provider_contract_version: PROVIDER_CONTRACT_VERSION,
  provider_id: "anthropic",
  adapter_version: "0.1.0",
  capabilities: ["analysis"],
  requires_cloud_preview: true,
  data_boundary: {
    raw: "local_only",
    exif: "local_only",
    gps: "local_only",
    preview: "sanitized_preview_to_cloud",
  },
});

export type AnthropicRunnerResult = {
  intent: unknown;
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type AnthropicVisionRunner = (request: {
  sanitizedPreviewPath: string;
  model: string;
  prompt: string;
}) => Promise<AnthropicRunnerResult>;

type AnthropicMessageResponse = {
  id?: unknown;
  content?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
};

function responseText(content: unknown): string {
  if (!Array.isArray(content)) throw new Error("Anthropic returned no message content");
  const text = content.find(
    (block): block is { type: "text"; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  if (!text) throw new Error("Anthropic returned no structured text content");
  return text.text;
}

function parseIntentJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new Error(
      `Anthropic structured intent was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runAnthropicMessage(request: {
  sanitizedPreviewPath: string;
  model: string;
  prompt: string;
}): Promise<AnthropicRunnerResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required for the Anthropic provider");
  const base64 = (await readFile(request.sanitizedPreviewPath)).toString("base64");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: 2048,
      system: request.prompt,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Create the semantic edit intent for this preview." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64 },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic request failed with HTTP ${response.status}`);
  const body = (await response.json()) as AnthropicMessageResponse;
  const inputTokens =
    typeof body.usage?.input_tokens === "number" ? body.usage.input_tokens : undefined;
  const outputTokens =
    typeof body.usage?.output_tokens === "number" ? body.usage.output_tokens : undefined;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  return {
    intent: parseIntentJson(responseText(body.content)),
    ...(typeof body.id === "string" ? { responseId: body.id } : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
            ...(totalTokens !== undefined ? { totalTokens } : {}),
          },
        }
      : {}),
  };
}

export class AnthropicProvider implements AnalysisProvider {
  readonly requiresCloudPreview = true;
  readonly capabilities = ANTHROPIC_PROVIDER_CAPABILITIES;

  constructor(
    private readonly runner: AnthropicVisionRunner = runAnthropicMessage,
    private readonly model = process.env.PHOTO_AGENT_ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
  ) {}

  async analyze(sanitizedPreviewPath: string): Promise<ProviderResult> {
    const result = await this.runner({
      sanitizedPreviewPath,
      model: this.model,
      prompt: ANTHROPIC_PROMPT,
    });
    return ProviderResultSchema.parse({
      intent: SemanticIntentPlanSchema.parse(result.intent),
      metadata: {
        provider: "anthropic",
        model: this.model,
        ...(result.responseId ? { responseId: result.responseId } : {}),
        promptVersion: ANTHROPIC_PROMPT_VERSION,
        promptHash: ANTHROPIC_PROMPT_HASH,
        ...(result.usage ? { usage: result.usage } : {}),
        cloudPreview: true,
      },
    });
  }
}
