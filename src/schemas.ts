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

export const EvaluationResultSchema = z
  .object({
    schema_version: z.literal("0.2.0"),
    verdict: z.enum(["accept", "refine", "review"]),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2000),
    issues: z.array(z.string().min(1).max(500)),
    refinement_plan: NormalizedEditPlanSchema.optional(),
    usage: z
      .object({
        evaluator_calls: z.number().int().nonnegative().default(1),
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
        estimated_cost_usd: z.number().nonnegative().optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.verdict === "refine" && !value.refinement_plan) {
      context.addIssue({
        code: "custom",
        path: ["refinement_plan"],
        message: "refine verdict requires a refinement_plan",
      });
    }
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

export const CullingDecisionSchema = z.object({
  selection_status: z.enum(["select", "keep", "reject", "review"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

export const LightingClassificationSchema = z.object({
  lighting_type: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

export const ShootAnalysisSchema = z.object({
  culling: CullingDecisionSchema,
  lighting: LightingClassificationSchema,
});

export const ShootAssetSchema = z.object({
  id: z.string().min(1),
  relative_raw_path: z.string().min(1),
  raw_path: z.string().min(1),
  relative_preview_path: z.string().min(1).optional(),
  preview_path: z.string().min(1).optional(),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preview_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  source_confidence: z.enum(["high", "ambiguous", "missing_preview"]),
});

export const ShootDecisionSchema = z.object({
  asset_id: z.string().min(1),
  culling: CullingDecisionSchema,
  lighting: LightingClassificationSchema,
  state: z.enum(["completed", "failed"]),
  error: z.string().optional(),
});

export const ShootPlanSchema = z.object({
  schema_version: z.literal("0.3.0"),
  session_id: z.string().min(1),
  shoot_root: z.string().min(1),
  created_at: z.string().datetime(),
  mode: z.literal("dry_run"),
  assets: z.array(ShootAssetSchema),
});

export const ShootReviewFileSchema = z.object({
  schema_version: z.literal("0.3.0"),
  decisions: z.array(
    z
      .object({
        asset_id: z.string().min(1).optional(),
        relative_raw_path: z.string().min(1).optional(),
        culling: CullingDecisionSchema,
        lighting: LightingClassificationSchema,
      })
      .refine((value) => value.asset_id !== undefined || value.relative_raw_path !== undefined, {
        message: "Each reviewed decision requires asset_id or relative_raw_path",
      }),
  ),
});

export const ShootManifestSchema = z.object({
  schema_version: z.literal("0.3.0"),
  session_id: z.string().min(1),
  shoot_root: z.string().min(1),
  created_at: z.string().datetime(),
  mode: z.literal("dry_run"),
  assets: z.array(ShootAssetSchema),
  decisions: z.array(ShootDecisionSchema),
  duplicate_groups: z.array(
    z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), asset_ids: z.array(z.string()) }),
  ),
  burst_groups: z.array(
    z.object({
      group_id: z.string().min(1),
      asset_ids: z.array(z.string()).min(2),
      basis: z.literal("filename_sequence"),
    }),
  ),
  clusters: z.array(
    z.object({
      cluster_id: z.string().min(1),
      lighting_type: z.string().min(1),
      member_ids: z.array(z.string()),
      representative_id: z.string().nullable(),
    }),
  ),
  summary: z.object({
    input: z.number().int().nonnegative(),
    select: z.number().int().nonnegative(),
    keep: z.number().int().nonnegative(),
    reject: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    resumed_jobs: z.number().int().nonnegative(),
    analyzed_jobs: z.number().int().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
  }),
});

export const PropagationPlanSchema = z.object({
  schema_version: z.literal("0.3.0"),
  cluster_id: z.string().min(1),
  representative_id: z.string().min(1),
  operation_parameters: z.array(z.enum(NORMALIZED_PARAMETERS)).min(1),
  targets: z.array(
    z.object({
      asset_id: z.string().min(1),
      relative_raw_path: z.string().min(1),
      operations: z.array(NormalizedOperationSchema).min(1),
    }),
  ),
  excluded: z.array(z.object({ asset_id: z.string().min(1), reason: z.string().min(1) })),
  requires_explicit_apply: z.literal(true),
});

export type SemanticIntent = z.infer<typeof SemanticIntentPlanSchema>;
