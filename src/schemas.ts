import { z } from "zod";

export const SCHEMA_VERSION = "0.1.0" as const;

const direction = z.enum(["increase", "decrease", "unchanged"]);
const strength = z.enum(["slight", "medium", "strong"]);

export const SEMANTIC_PARAMETERS = [
  "exposure",
  "temperature",
  "tint",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
] as const;

export const NORMALIZED_PARAMETERS = [
  "exposure_ev",
  "temperature_k",
  "tint",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
] as const;

export const SemanticAdjustmentSchema = z.object({
  parameter: z.enum(SEMANTIC_PARAMETERS),
  direction,
  strength,
  rationale: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export const SemanticIntentPlanSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  creative_goal: z.string().min(1).max(500),
  adjustments: z.array(SemanticAdjustmentSchema).max(32),
  overall_confidence: z.number().min(0).max(1),
});

export const NormalizedOperationSchema = z.object({
  parameter: z.enum(NORMALIZED_PARAMETERS),
  mode: z.literal("delta"),
  value: z.number().finite(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
});

export const NormalizedEditPlanSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  operations: z.array(NormalizedOperationSchema).max(NORMALIZED_PARAMETERS.length),
  warnings: z.array(z.string().min(1).max(500)),
});

export const SourceAssetPairSchema = z.object({
  raw_path: z.string().min(1),
  preview_path: z.string().min(1),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_confidence: z.literal("high"),
});

export const BackendPhotoStateSchema = z.object({
  photo_id: z.string().min(1),
  path: z.string().min(1),
  develop_settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
});

export const OperationSemanticsSchema = z.object({
  supported: z.boolean(),
  side_effect: z.enum(["read_only", "temporary", "mutating", "delivery_export"]),
  idempotent: z.boolean(),
  reversible: z.enum(["true_undo", "checkpoint_only", "new_file", "irreversible"]),
  scope: z.enum(["photo", "selection", "catalog", "filesystem", "session"]),
  concurrency: z.enum(["parallel_safe", "per_photo_serialized", "exclusive_backend"]),
  retry_policy: z.enum(["automatic", "readback_before_retry", "manual_review_only"]),
  safe_to_resume: z.boolean(),
});

export const BackendCapabilityManifestSchema = z.object({
  backend: z.string().min(1),
  version: z.string().min(1),
  trust_boundary: z.object({
    transport: z.string().min(1),
    authentication: z.string().min(1),
    cloud: z.boolean(),
  }),
  capabilities: z.array(z.string().min(1)),
  operations: z.record(z.string(), OperationSemanticsSchema),
});

export const SessionManifestSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: z.string().min(1),
  created_at: z.string().datetime(),
  source: SourceAssetPairSchema,
  provider: z.object({
    name: z.enum(["mock", "codex", "openai"]),
    model: z.string().min(1),
    prompt_version: z.string().min(1),
    prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
    cloud_preview: z.boolean(),
    response_id: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
  backend: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  config_hash: z.string().regex(/^[a-f0-9]{64}$/),
  privacy: z.object({
    raw_uploaded: z.literal(false),
    exif_sent: z.literal(false),
    preview_sanitized: z.literal(true),
  }),
});

export type SemanticIntent = z.infer<typeof SemanticIntentPlanSchema>;
