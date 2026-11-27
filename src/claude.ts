import { readFile } from "node:fs/promises";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import {
  EvaluationResultSchema,
  ProviderSemanticIntentPlanSchema,
  SemanticIntentPlanSchema,
} from "./schemas.js";
import {
  EVALUATION_PROMPT,
  PROMPT,
  PROMPT_VERSION,
  PROMPT_HASH,
  REFERENCE_RESEARCH_PROMPT,
} from "./prompts.js";
import type {
  AnalysisProvider,
  EditEvaluator,
  EvaluationInput,
  EvaluationResult,
  ProviderResult,
} from "./types.js";

/**
 * Claude (Anthropic API) provider and evaluator for unattended runs.
 *
 * Privacy: only the sanitized JPEG preview / render (EXIF stripped, created by
 * photo-agent) is sent. RAW files and metadata never leave the machine.
 * Callers must pass --allow-cloud-preview, exactly like the OpenAI path.
 */

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const MAX_PAUSE_RESUMES = 4;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ClaudeOptions = {
  model?: string;
  /** Let the model search the web for colour-grading references (text only). */
  webReferences?: boolean;
  client?: Anthropic;
};

type Usage = { input_tokens?: number; output_tokens?: number };

function jsonFromResponse(content: readonly { type: string }[]): unknown {
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned no JSON text block");
  return JSON.parse(text);
}

/**
 * One structured call with an image, optional server-side web search, and
 * server-side refusal fallback. Handles pause_turn by re-sending the
 * assistant turn so the server resumes its own tool loop.
 */
async function structuredImageCall<T extends z.ZodType>(
  client: Anthropic,
  options: {
    model: string;
    system: string;
    imagePath: string;
    instruction: string;
    schema: T;
    webSearch: boolean;
  },
): Promise<{ value: unknown; usage: Usage; responseId: string; searches: number }> {
  const image = (await readFile(options.imagePath)).toString("base64");
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: options.instruction },
      ],
    },
  ];
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let searches = 0;
  for (let attempt = 0; attempt <= MAX_PAUSE_RESUMES; attempt += 1) {
    const response = await client.beta.messages.create({
      model: options.model,
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      system: options.system,
      output_config: { effort: "medium", format: zodOutputFormat(options.schema) },
      ...(options.webSearch
        ? {
            tools: [
              { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 3 },
            ],
          }
        : {}),
      messages,
    });
    usage.input_tokens! += response.usage.input_tokens;
    usage.output_tokens! += response.usage.output_tokens;
    searches += response.content.filter((block) => block.type === "web_search_tool_result").length;
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal") {
      throw new Error(
        `Claude declined the request (${response.stop_details?.category ?? "unknown category"})`,
      );
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("Claude response hit max_tokens before completing the JSON");
    }
    return { value: jsonFromResponse(response.content), usage, responseId: response.id, searches };
  }
  throw new Error("Claude server tool loop did not finish after repeated pause_turn resumes");
}

export class ClaudeProvider implements AnalysisProvider {
  readonly requiresCloudPreview = true;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly webReferences: boolean;

  constructor(options: ClaudeOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env.PHOTO_AGENT_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
    this.webReferences = options.webReferences ?? false;
  }

  async analyze(previewPath: string): Promise<ProviderResult> {
    const result = await structuredImageCall(this.client, {
      model: this.model,
      system: this.webReferences ? `${PROMPT}\n\n${REFERENCE_RESEARCH_PROMPT}` : PROMPT,
      imagePath: previewPath,
      instruction: "Create the semantic edit intent for this preview.",
      schema: ProviderSemanticIntentPlanSchema,
      webSearch: this.webReferences,
    });
    const intent = SemanticIntentPlanSchema.parse(result.value);
    return {
      intent,
      metadata: {
        provider: "claude",
        model: this.model,
        responseId: result.responseId,
        promptVersion: PROMPT_VERSION,
        promptHash: PROMPT_HASH,
        usage: {
          inputTokens: result.usage.input_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          totalTokens: (result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0),
        },
        cloudPreview: true,
      },
    };
  }
}

export class ClaudeEditEvaluator implements EditEvaluator {
  readonly name = "claude-visual";
  readonly requiresCloudPreview = true;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: ClaudeOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? process.env.PHOTO_AGENT_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const result = await structuredImageCall(this.client, {
      model: this.model,
      system: EVALUATION_PROMPT,
      imagePath: input.renderPath,
      instruction: describeEvaluationInput(input),
      schema: EvaluationResultSchema,
      webSearch: false,
    });
    const parsed = EvaluationResultSchema.parse(result.value);
    const inputTokens = result.usage.input_tokens ?? 0;
    const outputTokens = result.usage.output_tokens ?? 0;
    return EvaluationResultSchema.parse({
      ...parsed,
      usage: {
        evaluator_calls: 1,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    });
  }
}

/** Text that tells a visual evaluator what was applied, including masks. */
export function describeEvaluationInput(input: EvaluationInput): string {
  const lines = [`Evaluate closed-loop iteration ${input.iteration}.`];
  const operations = input.normalizedPlan.operations
    .map(
      (operation) => `${operation.parameter} ${operation.value > 0 ? "+" : ""}${operation.value}`,
    )
    .join(", ");
  if (operations) lines.push(`Global deltas applied: ${operations}.`);
  for (const mask of input.masks ?? []) {
    const region =
      mask.region.type === "radial"
        ? `radial ellipse centred at (${mask.region.center_x}, ${mask.region.center_y}), size ${mask.region.width} x ${mask.region.height} of the frame${mask.region.invert ? ", inverted (outside)" : ""}`
        : `linear gradient from full effect at (${mask.region.full_x}, ${mask.region.full_y}) to none at (${mask.region.zero_x}, ${mask.region.zero_y})`;
    const adjustments = mask.adjustments
      .map((adjustment) =>
        adjustment.parameter === "exposure"
          ? `exposure ${adjustment.value * 4 > 0 ? "+" : ""}${(adjustment.value * 4).toFixed(2)} EV`
          : `${adjustment.parameter} ${adjustment.value > 0 ? "+" : ""}${adjustment.value}`,
      )
      .join(", ");
    lines.push(
      `Mask "${mask.id}" (target: ${mask.target}; ${region}; coordinates are fractions of the frame, x right, y down): ${adjustments}.`,
    );
  }
  if ((input.masks ?? []).length > 0) {
    lines.push("Return mask_feedback with one entry per mask id listed above.");
  }
  return lines.join("\n");
}
