import { createHash } from "node:crypto";

import {
  LOCAL_PROVIDER_ID,
  PROVIDER_CONTRACT_VERSION,
  LocalProviderExperimentReportSchema,
  ProviderCapabilityManifestSchema,
  ProviderResultSchema,
  SCHEMA_VERSION,
  SemanticIntentPlanSchema,
} from "./schemas.js";
import type { AnalysisProvider, LocalProviderExperimentReport, ProviderResult } from "./types.js";

export const LOCAL_PROMPT_VERSION = "local-vlm-experiment-v0.1.0";
const LOCAL_PROMPT_HASH = createHash("sha256").update(LOCAL_PROMPT_VERSION).digest("hex");

export const LOCAL_PROVIDER_CAPABILITIES = ProviderCapabilityManifestSchema.parse({
  schema_version: SCHEMA_VERSION,
  provider_contract_version: PROVIDER_CONTRACT_VERSION,
  provider_id: LOCAL_PROVIDER_ID,
  adapter_version: "0.1.0",
  capabilities: ["analysis"],
  requires_cloud_preview: false,
  data_boundary: {
    raw: "local_only",
    exif: "local_only",
    gps: "local_only",
    preview: "local_only",
  },
});

export type LocalVisionLanguageRunner = (request: {
  sanitizedPreviewPath: string;
  model: string;
}) => Promise<unknown>;

/**
 * Prototype adapter for a caller-owned local VLM runtime. The runner receives
 * only the sanitized preview path supplied by the workflow and no cloud API
 * client is created here.
 */
export class LocalVisionLanguageProvider implements AnalysisProvider {
  readonly requiresCloudPreview = false;
  readonly capabilities = LOCAL_PROVIDER_CAPABILITIES;

  constructor(
    private readonly runner: LocalVisionLanguageRunner,
    private readonly model = "local-vlm-experimental",
  ) {}

  async analyze(sanitizedPreviewPath: string): Promise<ProviderResult> {
    const rawIntent = await this.runner({
      sanitizedPreviewPath,
      model: this.model,
    });
    return ProviderResultSchema.parse({
      intent: SemanticIntentPlanSchema.parse(rawIntent),
      metadata: {
        provider: LOCAL_PROVIDER_ID,
        model: this.model,
        promptVersion: LOCAL_PROMPT_VERSION,
        promptHash: LOCAL_PROMPT_HASH,
        cloudPreview: false,
      },
    });
  }
}

/** Validate explicit local experiment evidence without filling unknown metrics. */
export function buildLocalProviderExperimentReport(report: unknown): LocalProviderExperimentReport {
  return LocalProviderExperimentReportSchema.parse(report);
}

export function validateLocalProviderExperimentReport(
  report: unknown,
): LocalProviderExperimentReport {
  return LocalProviderExperimentReportSchema.parse(report);
}
