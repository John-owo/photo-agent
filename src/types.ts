import type { z } from "zod";

import type { BackendHandshakeRequirements } from "./backend-handshake.js";
import type {
  BackendCapabilityManifestSchema,
  BackendPhotoIdentitySchema,
  BackendPhotoStateSchema,
  CheckpointEvidenceSchema,
  CancellationEvidenceSchema,
  CullingDecisionSchema,
  EvaluationArtifactSchema,
  EvaluationResultSchema,
  FinalExportSettingsSchema,
  IterationReportRecordSchema,
  IterationReportSchema,
  LightingClassificationSchema,
  ParameterRegistryMigrationSchema,
  ParameterRegistrySnapshotSchema,
  NormalizedEditPlanSchema,
  NormalizedParameter,
  NormalizedOperationSchema,
  PreviewArtifactSchema,
  PreviewPolicySchema,
  SemanticIntentPlanSchema,
  SessionManifestSchema,
  ShootIngestionErrorSchema,
  ShootAssetSchema,
  ShootCancellationEvidenceSchema,
  ShootDecisionSchema,
  ShootManifestSchema,
  ShootPlanSchema,
  ShootReviewFileSchema,
  PropagationPlanSchema,
  SourceAssetPairSchema,
  TranslatorGoldenVectorSchema,
  WorkflowBudgetSchema,
  DevelopIterationIntentSchema,
  DevelopReadbackEvidenceSchema,
  RecoveryEvidenceSchema,
  StoredNormalizedEditPlanSchema,
  RepresentativeJobSchema,
  WorkflowCopyIntentSchema,
  WorkflowCopyResultSchema,
  WorkflowCopyVerificationSchema,
  WorkflowResultSchema,
  ToneCurveGoldenVectorSchema,
  ToneCurveIntentSchema,
  ToneCurveOperationSchema,
  ToneCurvePayloadSchema,
  ToneCurvePointPayloadSchema,
  ToneCurveParametricValuesSchema,
  ToneCurvePlanSchema,
  ToneCurveReadbackSchema,
  DetailGoldenVectorSchema,
  DetailIntentSchema,
  DetailOperationSchema,
  DetailPayloadSchema,
  DetailPlanSchema,
  DetailPlanningContextSchema,
  DetailReadbackSchema,
  OpticsGoldenVectorSchema,
  OpticsIntentSchema,
  OpticsOperationSchema,
  OpticsPayloadSchema,
  OpticsPlanSchema,
  OpticsReadbackSchema,
  FinishingGoldenVectorSchema,
  FinishingIntentSchema,
  FinishingOperationSchema,
  FinishingPayloadSchema,
  FinishingPlanSchema,
  FinishingReadbackSchema,
  ColorGradingGoldenVectorSchema,
  ColorGradingIntentSchema,
  ColorGradingOperationSchema,
  ColorGradingPayloadSchema,
  ColorGradingPlanSchema,
  ColorGradingReadbackSchema,
  ExistingMaskSnapshotSchema,
  ExistingMaskSummarySchema,
  MaskAdjustmentIntentSchema,
  MaskAdjustmentPlanSchema,
  MaskGoldenVectorSchema,
  MaskParameterSettingsSchema,
  MaskReadbackSchema,
  MaskSelectorSchema,
  PreferenceContextSchema,
  PreferenceRuleSchema,
  StylePriorGoldenVectorSchema,
  StylePriorPlanSchema,
  StylePriorRequestSchema,
  StylePriorSchema,
  StyleHistoryExampleSchema,
  StyleHistoryEvaluationCaseSchema,
  StyleHistoryEvaluationGoldenVectorSchema,
  StyleHistoryEvaluationReportSchema,
  StyleHistoryEvaluationRequestSchema,
  StyleHistoryEvaluationSplitSchema,
  StyleHistoryGoldenVectorSchema,
  StyleHistoryMatchSchema,
  StyleHistoryQuerySchema,
  StyleHistoryRetrievalSchema,
  StyleHistorySnapshotSchema,
  StylePerceptualProfileSchema,
  PhotoAgentBenchCaseOutcomeSchema,
  PhotoAgentBenchCaseResultSchema,
  PhotoAgentBenchCaseSchema,
  PhotoAgentBenchDatasetSchema,
  PhotoAgentBenchGoldenVectorSchema,
  PhotoAgentBenchReportSchema,
  PhotoAgentBenchSplitSchema,
  BackendCompatibilityCaseSchema,
  BackendCompatibilityResultSchema,
  ControlGroupSuiteDiscoverySchema,
  RegressionGateReportSchema,
  WorkflowRegressionEvidenceSchema,
} from "./schemas.js";

export type SourceAssetPair = z.infer<typeof SourceAssetPairSchema>;
export type SemanticIntentPlan = z.infer<typeof SemanticIntentPlanSchema>;
export type NormalizedEditPlan = z.infer<typeof NormalizedEditPlanSchema>;
export type StoredNormalizedEditPlan = z.infer<typeof StoredNormalizedEditPlanSchema>;
export type { NormalizedParameter };
export type NormalizedOperation = z.infer<typeof NormalizedOperationSchema>;
export type ParameterRegistryMigration = z.infer<typeof ParameterRegistryMigrationSchema>;
export type ParameterRegistrySnapshot = z.infer<typeof ParameterRegistrySnapshotSchema>;
export type TranslatorGoldenVector = z.infer<typeof TranslatorGoldenVectorSchema>;
export type ToneCurveOperation = z.infer<typeof ToneCurveOperationSchema>;
export type ToneCurvePayload = z.infer<typeof ToneCurvePayloadSchema>;
export type ToneCurvePointPayload = z.infer<typeof ToneCurvePointPayloadSchema>;
export type ToneCurveParametricValues = z.infer<typeof ToneCurveParametricValuesSchema>;
export type ToneCurveIntent = z.infer<typeof ToneCurveIntentSchema>;
export type ToneCurvePlan = z.infer<typeof ToneCurvePlanSchema>;
export type ToneCurveReadback = z.infer<typeof ToneCurveReadbackSchema>;
export type ToneCurveGoldenVector = z.infer<typeof ToneCurveGoldenVectorSchema>;
export type DetailPlanningContext = z.infer<typeof DetailPlanningContextSchema>;
export type DetailOperation = z.infer<typeof DetailOperationSchema>;
export type DetailPayload = z.infer<typeof DetailPayloadSchema>;
export type DetailIntent = z.infer<typeof DetailIntentSchema>;
export type DetailPlan = z.infer<typeof DetailPlanSchema>;
export type DetailReadback = z.infer<typeof DetailReadbackSchema>;
export type DetailGoldenVector = z.infer<typeof DetailGoldenVectorSchema>;
export type OpticsOperation = z.infer<typeof OpticsOperationSchema>;
export type OpticsPayload = z.infer<typeof OpticsPayloadSchema>;
export type OpticsIntent = z.infer<typeof OpticsIntentSchema>;
export type OpticsPlan = z.infer<typeof OpticsPlanSchema>;
export type OpticsReadback = z.infer<typeof OpticsReadbackSchema>;
export type OpticsGoldenVector = z.infer<typeof OpticsGoldenVectorSchema>;
export type FinishingOperation = z.infer<typeof FinishingOperationSchema>;
export type FinishingPayload = z.infer<typeof FinishingPayloadSchema>;
export type FinishingIntent = z.infer<typeof FinishingIntentSchema>;
export type FinishingPlan = z.infer<typeof FinishingPlanSchema>;
export type FinishingReadback = z.infer<typeof FinishingReadbackSchema>;
export type FinishingGoldenVector = z.infer<typeof FinishingGoldenVectorSchema>;
export type ColorGradingOperation = z.infer<typeof ColorGradingOperationSchema>;
export type ColorGradingPayload = z.infer<typeof ColorGradingPayloadSchema>;
export type ColorGradingIntent = z.infer<typeof ColorGradingIntentSchema>;
export type ColorGradingPlan = z.infer<typeof ColorGradingPlanSchema>;
export type ColorGradingReadback = z.infer<typeof ColorGradingReadbackSchema>;
export type ColorGradingGoldenVector = z.infer<typeof ColorGradingGoldenVectorSchema>;
export type ExistingMaskSummary = z.infer<typeof ExistingMaskSummarySchema>;
export type ExistingMaskSnapshot = z.infer<typeof ExistingMaskSnapshotSchema>;
export type MaskSelector = z.infer<typeof MaskSelectorSchema>;
export type MaskParameterSettings = z.infer<typeof MaskParameterSettingsSchema>;
export type MaskReadback = z.infer<typeof MaskReadbackSchema>;
export type MaskAdjustmentIntent = z.infer<typeof MaskAdjustmentIntentSchema>;
export type MaskAdjustmentPlan = z.infer<typeof MaskAdjustmentPlanSchema>;
export type MaskGoldenVector = z.infer<typeof MaskGoldenVectorSchema>;
export type PreferenceContext = z.infer<typeof PreferenceContextSchema>;
export type PreferenceRule = z.infer<typeof PreferenceRuleSchema>;
export type StylePrior = z.infer<typeof StylePriorSchema>;
export type StylePriorRequest = z.infer<typeof StylePriorRequestSchema>;
export type StylePriorPlan = z.infer<typeof StylePriorPlanSchema>;
export type StylePriorGoldenVector = z.infer<typeof StylePriorGoldenVectorSchema>;
export type StylePerceptualProfile = z.infer<typeof StylePerceptualProfileSchema>;
export type StyleHistoryExample = z.infer<typeof StyleHistoryExampleSchema>;
export type StyleHistorySnapshot = z.infer<typeof StyleHistorySnapshotSchema>;
export type StyleHistoryQuery = z.infer<typeof StyleHistoryQuerySchema>;
export type StyleHistoryMatch = z.infer<typeof StyleHistoryMatchSchema>;
export type StyleHistoryRetrieval = z.infer<typeof StyleHistoryRetrievalSchema>;
export type StyleHistoryGoldenVector = z.infer<typeof StyleHistoryGoldenVectorSchema>;
export type StyleHistoryEvaluationSplit = z.infer<typeof StyleHistoryEvaluationSplitSchema>;
export type StyleHistoryEvaluationRequest = z.infer<typeof StyleHistoryEvaluationRequestSchema>;
export type StyleHistoryEvaluationCase = z.infer<typeof StyleHistoryEvaluationCaseSchema>;
export type StyleHistoryEvaluationReport = z.infer<typeof StyleHistoryEvaluationReportSchema>;
export type StyleHistoryEvaluationGoldenVector = z.infer<
  typeof StyleHistoryEvaluationGoldenVectorSchema
>;
export type PhotoAgentBenchCase = z.infer<typeof PhotoAgentBenchCaseSchema>;
export type PhotoAgentBenchDataset = z.infer<typeof PhotoAgentBenchDatasetSchema>;
export type PhotoAgentBenchSplit = z.infer<typeof PhotoAgentBenchSplitSchema>;
export type PhotoAgentBenchCaseOutcome = z.infer<typeof PhotoAgentBenchCaseOutcomeSchema>;
export type PhotoAgentBenchCaseResult = z.infer<typeof PhotoAgentBenchCaseResultSchema>;
export type PhotoAgentBenchReport = z.infer<typeof PhotoAgentBenchReportSchema>;
export type PhotoAgentBenchGoldenVector = z.infer<typeof PhotoAgentBenchGoldenVectorSchema>;
export type ControlGroupSuiteDiscovery = z.infer<typeof ControlGroupSuiteDiscoverySchema>;
export type BackendCompatibilityCase = z.infer<typeof BackendCompatibilityCaseSchema>;
export type BackendCompatibilityResult = z.infer<typeof BackendCompatibilityResultSchema>;
export type WorkflowRegressionEvidence = z.infer<typeof WorkflowRegressionEvidenceSchema>;
export type RegressionGateReport = z.infer<typeof RegressionGateReportSchema>;
export type SessionManifest = z.infer<typeof SessionManifestSchema>;
export type BackendCapabilityManifest = z.infer<typeof BackendCapabilityManifestSchema>;
export type BackendPhotoState = z.infer<typeof BackendPhotoStateSchema>;
export type BackendPhotoIdentity = z.infer<typeof BackendPhotoIdentitySchema>;
export type CheckpointEvidence = z.infer<typeof CheckpointEvidenceSchema>;
export type CancellationEvidence = z.infer<typeof CancellationEvidenceSchema>;
export type DevelopIterationIntent = z.infer<typeof DevelopIterationIntentSchema>;
export type DevelopReadbackEvidence = z.infer<typeof DevelopReadbackEvidenceSchema>;
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
export type RepresentativeJob = z.infer<typeof RepresentativeJobSchema>;
export type WorkflowCopyIntent = z.infer<typeof WorkflowCopyIntentSchema>;
export type WorkflowCopyResult = z.infer<typeof WorkflowCopyResultSchema>;
export type WorkflowCopyVerification = z.infer<typeof WorkflowCopyVerificationSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type EvaluationArtifact = z.infer<typeof EvaluationArtifactSchema>;
export type PreviewArtifact = z.infer<typeof PreviewArtifactSchema>;
export type PreviewPolicy = z.infer<typeof PreviewPolicySchema>;
export type FinalExportSettings = z.infer<typeof FinalExportSettingsSchema>;
export type IterationReportRecord = z.infer<typeof IterationReportRecordSchema>;
export type IterationReport = z.infer<typeof IterationReportSchema>;
export type WorkflowBudget = z.infer<typeof WorkflowBudgetSchema>;
export type CullingDecision = z.infer<typeof CullingDecisionSchema>;
export type LightingClassification = z.infer<typeof LightingClassificationSchema>;
export type ShootAsset = z.infer<typeof ShootAssetSchema>;
export type ShootCancellationEvidence = z.infer<typeof ShootCancellationEvidenceSchema>;
export type ShootIngestionError = z.infer<typeof ShootIngestionErrorSchema>;
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
  exportFinal?(
    photoId: string,
    destination: string,
    settings: FinalExportSettings,
  ): Promise<RenderResult>;
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

export type WorkflowBudgetOptions = {
  maxElapsedMs?: number;
  maxRenders?: number;
  maxEvaluatorCalls?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
};

export type ShootAnalyzer = {
  readonly requiresCloudPreview?: boolean;
  cull(asset: ShootAsset): Promise<CullingDecision>;
  classify(asset: ShootAsset): Promise<LightingClassification>;
  validateAssets?(assets: ShootAsset[]): void;
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
  budget?: WorkflowBudgetOptions;
  signal?: AbortSignal;
};

export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
