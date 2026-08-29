import { readFile } from "node:fs/promises";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { ShootAnalysisSchema } from "./schemas.js";
import type {
  CullingDecision,
  LightingClassification,
  ShootAnalyzer,
  ShootAsset,
} from "./types.js";

const SHOOT_PROMPT = `Inspect one sanitized preview for conservative photography culling and scene-lighting classification. Return select only for a strong delivery candidate, keep for a usable alternate, reject only for a clear technical/compositional failure, and review whenever expression, focus, duplication, or value is uncertain. Do not infer RAW color fidelity from the preview. Lighting labels should be concise, such as daylight, shade, tungsten, mixed, stage, backlight, high_iso, flash, or unknown. Explain both decisions and keep confidence calibrated.`;

export class OpenAIShootAnalyzer implements ShootAnalyzer {
  readonly requiresCloudPreview = true;
  private readonly client: OpenAI;
  private readonly pending = new Map<
    string,
    Promise<{ culling: CullingDecision; lighting: LightingClassification }>
  >();

  constructor(
    private readonly model = process.env.PHOTO_AGENT_OPENAI_MODEL ?? "gpt-5.6-terra",
    apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI shoot analyzer");
    this.client = new OpenAI({ apiKey });
  }

  private analyze(asset: ShootAsset) {
    const existing = this.pending.get(asset.id);
    if (existing) return existing;
    const pending = (async () => {
      if (!asset.preview_path)
        throw new Error(`No sanitized preview for ${asset.relative_raw_path}`);
      const base64 = (await readFile(asset.preview_path)).toString("base64");
      const response = await this.client.responses.parse({
        model: this.model,
        store: false,
        input: [
          { role: "developer", content: SHOOT_PROMPT },
          {
            role: "user",
            content: [
              { type: "input_text", text: `Review asset ${asset.id}.` },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${base64}`,
                detail: "high",
              },
            ],
          },
        ],
        text: { format: zodTextFormat(ShootAnalysisSchema, "shoot_analysis") },
      });
      if (!response.output_parsed) throw new Error("OpenAI shoot analyzer returned no result");
      return ShootAnalysisSchema.parse(response.output_parsed);
    })();
    this.pending.set(asset.id, pending);
    return pending;
  }

  async cull(asset: ShootAsset): Promise<CullingDecision> {
    return (await this.analyze(asset)).culling;
  }

  async classify(asset: ShootAsset): Promise<LightingClassification> {
    return (await this.analyze(asset)).lighting;
  }
}
