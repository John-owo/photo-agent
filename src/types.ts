import type { z } from "zod";

import type {
  BackendCapabilityManifestSchema,
  BackendPhotoStateSchema,
  NormalizedEditPlanSchema,
  SemanticIntentPlanSchema,
  SessionManifestSchema,
  SourceAssetPairSchema,
} from "./schemas.js";

export type SourceAssetPair = z.infer<typeof SourceAssetPairSchema>;
export type SemanticIntentPlan = z.infer<typeof SemanticIntentPlanSchema>;
export type NormalizedEditPlan = z.infer<typeof NormalizedEditPlanSchema>;
export type SessionManifest = z.infer<typeof SessionManifestSchema>;
export type BackendCapabilityManifest = z.infer<typeof BackendCapabilityManifestSchema>;
export type BackendPhotoState = z.infer<typeof BackendPhotoStateSchema>;

export type JobState =
  | "PENDING"
  | "ANALYZING"
  | "CODEX_INPUT_REQUIRED"
  | "PLAN_READY"
  | "APPLYING"
  | "RENDERING"
  | "REVIEW_REQUIRED"
  | "FAILED"
  | "CANCELLED";

export type ProviderMetadata = {
  provider: "mock" | "codex" | "openai";
  model: string;
  responseId?: string;
  promptVersion: string;
  promptHash: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  cloudPreview: boolean;
};

export type ProviderResult = {
  intent: SemanticIntentPlan;
  metadata: ProviderMetadata;
};

export type AnalysisProvider = {
  readonly requiresCloudPreview: boolean;
  analyze(previewPath: string): Promise<ProviderResult>;
};

export type CheckpointResult = {
  name: string;
  raw: unknown;
};

export type RenderResult = {
  path: string;
  raw: unknown;
};

export type BackendAdapter = {
  readonly name: string;
  readonly capabilities: BackendCapabilityManifest;
  connect(): Promise<void>;
  close(): Promise<void>;
  readCurrentEdit(photoId: string): Promise<BackendPhotoState>;
  createCheckpoint(photoId: string, name: string, settings: string[]): Promise<CheckpointResult>;
  applyGlobalAdjustment(
    photoId: string,
    settings: Record<string, number | string | boolean>,
  ): Promise<unknown>;
  renderPreview(photoId: string, destination: string): Promise<RenderResult>;
};

export type WorkflowOptions = {
  rawPath: string;
  previewPath: string;
  photoId?: string;
  provider: AnalysisProvider;
  backend: BackendAdapter;
  sessionRoot: string;
  apply: boolean;
  allowCloudPreview: boolean;
};

export type WorkflowResult = {
  sessionDir: string;
  state: JobState;
  manifest: SessionManifest;
  normalizedPlan: NormalizedEditPlan;
  renderPath?: string;
  handoffPath?: string;
};
