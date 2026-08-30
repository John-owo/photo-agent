import type { z } from "zod";

import type { BackendHandshakeRequirements } from "./backend-handshake.js";
import type {
  BackendCapabilityManifestSchema,
  BackendPhotoIdentitySchema,
  BackendPhotoStateSchema,
  CheckpointEvidenceSchema,
  CullingDecisionSchema,
  EvaluationResultSchema,
  LightingClassificationSchema,
  NormalizedEditPlanSchema,
  SemanticIntentPlanSchema,
  SessionManifestSchema,
  ShootAssetSchema,
  ShootDecisionSchema,
  ShootManifestSchema,
  ShootPlanSchema,
  ShootReviewFileSchema,
  PropagationPlanSchema,
  SourceAssetPairSchema,
  DevelopIterationIntentSchema,
  DevelopReadbackEvidenceSchema,
  RecoveryEvidenceSchema,
  WorkflowCopyIntentSchema,
  WorkflowCopyResultSchema,
  WorkflowCopyVerificationSchema,
} from "./schemas.js";

export type SourceAssetPair = z.infer<typeof SourceAssetPairSchema>;
export type SemanticIntentPlan = z.infer<typeof SemanticIntentPlanSchema>;
export type NormalizedEditPlan = z.infer<typeof NormalizedEditPlanSchema>;
export type SessionManifest = z.infer<typeof SessionManifestSchema>;
export type BackendCapabilityManifest = z.infer<typeof BackendCapabilityManifestSchema>;
export type BackendPhotoState = z.infer<typeof BackendPhotoStateSchema>;
export type BackendPhotoIdentity = z.infer<typeof BackendPhotoIdentitySchema>;
export type CheckpointEvidence = z.infer<typeof CheckpointEvidenceSchema>;
export type DevelopIterationIntent = z.infer<typeof DevelopIterationIntentSchema>;
export type DevelopReadbackEvidence = z.infer<typeof DevelopReadbackEvidenceSchema>;
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
export type WorkflowCopyIntent = z.infer<typeof WorkflowCopyIntentSchema>;
export type WorkflowCopyResult = z.infer<typeof WorkflowCopyResultSchema>;
export type WorkflowCopyVerification = z.infer<typeof WorkflowCopyVerificationSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type CullingDecision = z.infer<typeof CullingDecisionSchema>;
export type LightingClassification = z.infer<typeof LightingClassificationSchema>;
export type ShootAsset = z.infer<typeof ShootAssetSchema>;
export type ShootDecision = z.infer<typeof ShootDecisionSchema>;
export type ShootManifest = z.infer<typeof ShootManifestSchema>;
export type ShootPlan = z.infer<typeof ShootPlanSchema>;
export type ShootReviewFile = z.infer<typeof ShootReviewFileSchema>;
export type PropagationPlan = z.infer<typeof PropagationPlanSchema>;

export type JobState =
  | "PENDING"
  | "ANALYZING"
  | "CODEX_INPUT_REQUIRED"
  | "PLAN_READY"
  | "APPLYING"
  | "RENDERING"
  | "EVALUATING"
  | "REFINING"
  | "ACCEPTED"
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
  readonly handshakeRequirements: BackendHandshakeRequirements;
  readonly capabilities: BackendCapabilityManifest;
  connect(): Promise<void>;
  handshake(): Promise<BackendCapabilityManifest>;
  close(): Promise<void>;
  readCurrentEdit(photoId: string): Promise<BackendPhotoState>;
  reconcileWorkflowCopy(
    sourcePhotoId: string,
    expectedSourceUuid: string,
    operationId: string,
  ): Promise<WorkflowCopyResult>;
  createWorkflowCopy(
    sourcePhotoId: string,
    expectedSourceUuid: string,
    operationId: string,
  ): Promise<WorkflowCopyResult>;
  createCheckpoint(photoId: string, name: string, settings: string[]): Promise<CheckpointResult>;
  applyGlobalAdjustment(
    photoId: string,
    settings: Record<string, number | string | boolean>,
  ): Promise<unknown>;
  renderPreview(photoId: string, destination: string): Promise<RenderResult>;
};

export type EvaluationInput = {
  renderPath: string;
  iteration: number;
  normalizedPlan: NormalizedEditPlan;
  readBack: BackendPhotoState;
};

export type EditEvaluator = {
  readonly name: string;
  readonly requiresCloudPreview: boolean;
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
};

export type ShootAnalyzer = {
  readonly requiresCloudPreview?: boolean;
  cull(asset: ShootAsset): Promise<CullingDecision>;
  classify(asset: ShootAsset): Promise<LightingClassification>;
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
  evaluator?: EditEvaluator;
  maxIterations?: number;
};

export type WorkflowResult = {
  sessionDir: string;
  state: JobState;
  manifest: SessionManifest;
  normalizedPlan: NormalizedEditPlan;
  renderPath?: string;
  handoffPath?: string;
  iterations?: number;
};
