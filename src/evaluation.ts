import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { describeEvaluationInput } from "./claude.js";
import { EVALUATION_PROMPT } from "./prompts.js";
import { EvaluationResultSchema } from "./schemas.js";
import type { EditEvaluator, EvaluationInput, EvaluationResult } from "./types.js";

export const MIN_EVALUATION_CONFIDENCE = 0.65;

export function planFingerprint(result: EvaluationResult): string | undefined {
  if (!result.refinement_plan) return undefined;
  return createHash("sha256")
    .update(JSON.stringify(result.refinement_plan.operations))
    .digest("hex");
}

export async function renderFingerprint(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export class EvaluationInputRequiredError extends Error {
  constructor() {
    super(
      "An agent-written evaluation is required; write the evaluation JSON and continue the session",
    );
    this.name = "EvaluationInputRequiredError";
  }
}

/**
 * Evaluator for agent-driven runs (Claude Code / Codex): the loop pauses after
 * every render in EVALUATION_INPUT_REQUIRED; the agent inspects the render
 * locally, writes an EvaluationResult JSON, and runs `continue`.
 */
export class HandoffEvaluator implements EditEvaluator {
  readonly name = "handoff";
  readonly requiresCloudPreview = false;

  async evaluate(): Promise<EvaluationResult> {
    throw new EvaluationInputRequiredError();
  }
}

export class ScriptedEvaluator implements EditEvaluator {
  readonly name = "scripted";
  readonly requiresCloudPreview = false;
  private index = 0;

  constructor(private readonly results: readonly EvaluationResult[]) {
    if (results.length === 0) throw new Error("ScriptedEvaluator requires at least one result");
  }

  async evaluate(_input: EvaluationInput): Promise<EvaluationResult> {
    void _input;
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    return EvaluationResultSchema.parse(result);
  }
}

export class AcceptingMockEvaluator implements EditEvaluator {
  readonly name = "mock-accept";
  readonly requiresCloudPreview = false;

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    return EvaluationResultSchema.parse({
      schema_version: "0.2.0",
      verdict: "accept",
      confidence: 0.95,
      rationale: `Deterministic mock acceptance for iteration ${input.iteration}`,
      issues: [],
      usage: { evaluator_calls: 1 },
    });
  }
}

export class OpenAIEditEvaluator implements EditEvaluator {
  readonly name = "openai-visual";
  readonly requiresCloudPreview = true;
  private readonly client: OpenAI;

  constructor(
    private readonly model = process.env.PHOTO_AGENT_OPENAI_MODEL ?? "gpt-5.6-terra",
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI evaluator");
    this.client = new OpenAI({ apiKey });
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const base64 = (await readFile(input.renderPath)).toString("base64");
    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      input: [
        { role: "developer", content: EVALUATION_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: describeEvaluationInput(input),
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${base64}`,
              detail: "high",
            },
          ],
        },
      ],
      text: { format: zodTextFormat(EvaluationResultSchema, "edit_evaluation") },
    });
    if (!response.output_parsed) throw new Error("OpenAI evaluator returned no structured result");
    const parsed = EvaluationResultSchema.parse(response.output_parsed);
    return EvaluationResultSchema.parse({
      ...parsed,
      usage: {
        evaluator_calls: 1,
        ...(response.usage?.input_tokens !== undefined
          ? { input_tokens: response.usage.input_tokens }
          : {}),
        ...(response.usage?.output_tokens !== undefined
          ? { output_tokens: response.usage.output_tokens }
          : {}),
        ...(response.usage?.total_tokens !== undefined
          ? { total_tokens: response.usage.total_tokens }
          : {}),
      },
    });
  }
}
