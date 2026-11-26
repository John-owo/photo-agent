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

/**
 * Local (masked) adjustments. Lightroom has no local Vibrance, so it is not
 * offered. Values stay semantic (direction + strength); the deterministic
 * translator owns every Lightroom number.
 */
export const MASK_PARAMETERS = [
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
  "saturation",
] as const;

export const MAX_MASKS_PER_PHOTO = 3;
export const MAX_ADJUSTMENTS_PER_MASK = 4;
export const MASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const unitCoordinate = z.number().min(0).max(1);
const extendedCoordinate = z.number().min(-0.5).max(1.5);

/**
 * Radial (Lightroom `Mask/CircularGradient`) region. Coordinates are fractions
 * of the full preview frame: x grows to the right, y grows downward. `invert`
 * false means the adjustment applies inside the ellipse.
 */
export const RadialMaskRegionSchema = z
  .object({
    type: z.literal("radial"),
    center_x: unitCoordinate,
    center_y: unitCoordinate,
    width: z.number().min(0.05).max(1.5),
    height: z.number().min(0.05).max(1.5),
    angle_deg: z.number().min(-90).max(90),
    feather: z.number().min(0).max(100),
    invert: z.boolean(),
  })
  .strict();

/**
 * Linear (Lightroom `Mask/Gradient`) region. The effect is 100% at `full_*`
 * and fades to 0% at `zero_*`; points may sit slightly outside the frame.
 */
export const LinearMaskRegionSchema = z
  .object({
    type: z.literal("linear"),
    full_x: extendedCoordinate,
    full_y: extendedCoordinate,
    zero_x: extendedCoordinate,
    zero_y: extendedCoordinate,
  })
  .strict();

export const MaskRegionSchema = z.discriminatedUnion("type", [
  RadialMaskRegionSchema,
  LinearMaskRegionSchema,
]);

export const SemanticMaskAdjustmentSchema = z
  .object({
    parameter: z.enum(MASK_PARAMETERS),
    direction: z.enum(["increase", "decrease"]),
    strength,
  })
  .strict();

export const SemanticMaskIntentSchema = z
  .object({
    id: z.string().regex(MASK_ID_PATTERN),
    target: z.string().min(1).max(200),
    region: MaskRegionSchema,
    adjustments: z.array(SemanticMaskAdjustmentSchema).min(1).max(MAX_ADJUSTMENTS_PER_MASK),
    placement_certainty: z.enum(["clear", "subjective"]),
    rationale: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((mask, context) => {
    const seen = new Set<string>();
    for (const adjustment of mask.adjustments) {
      if (seen.has(adjustment.parameter)) {
        context.addIssue({
          code: "custom",
          path: ["adjustments"],
          message: `Duplicate mask parameter: ${adjustment.parameter}`,
        });
      }
      seen.add(adjustment.parameter);
    }
    if (mask.region.type === "linear") {
      const distance = Math.hypot(
        mask.region.full_x - mask.region.zero_x,
        mask.region.full_y - mask.region.zero_y,
      );
      if (distance < 0.02) {
        context.addIssue({
          code: "custom",
          path: ["region"],
          message: "Linear mask full and zero points must be at least 0.02 apart",
        });
      }
    }
  });

function refineUniqueMaskIds(
  masks: readonly { id: string }[] | undefined,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const mask of masks ?? []) {
    if (seen.has(mask.id)) {
      context.addIssue({ code: "custom", path: ["masks"], message: `Duplicate mask id: ${mask.id}` });
    }
    seen.add(mask.id);
  }
}

const semanticIntentShape = {
  schema_version: z.literal(SCHEMA_VERSION),
  creative_goal: z.string().min(1).max(500),
  adjustments: z.array(SemanticAdjustmentSchema).max(32),
  overall_confidence: z.number().min(0).max(1),
};

/**
 * `masks` is optional so intent files written before mask support stay valid.
 */
export const SemanticIntentPlanSchema = z
  .object({
    ...semanticIntentShape,
    masks: z.array(SemanticMaskIntentSchema).max(MAX_MASKS_PER_PHOTO).optional(),
  })
  .superRefine((plan, context) => refineUniqueMaskIds(plan.masks, context));

/**
 * Structured-output variant for visual-model providers: every field is
 * required (an empty `masks` array means "no local adjustment").
 */
export const ProviderSemanticIntentPlanSchema = z
  .object({
    ...semanticIntentShape,
    masks: z.array(SemanticMaskIntentSchema).max(MAX_MASKS_PER_PHOTO),
  })
  .superRefine((plan, context) => refineUniqueMaskIds(plan.masks, context));

export const NormalizedOperationSchema = z.object({
  parameter: z.enum(NORMALIZED_PARAMETERS),
  mode: z.literal("delta"),
  value: z.number().finite(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
});

export const LOCAL_LIGHTROOM_KEYS = [
  "LocalExposure2012",
  "LocalTemperature",
  "LocalTint",
  "LocalContrast2012",
  "LocalHighlights2012",
  "LocalShadows2012",
  "LocalWhites2012",
  "LocalBlacks2012",
  "LocalTexture",
  "LocalClarity2012",
  "LocalDehaze",
  "LocalSaturation",
] as const;

export const NormalizedMaskAdjustmentSchema = z
  .object({
    parameter: z.enum(MASK_PARAMETERS),
    lightroom_key: z.enum(LOCAL_LIGHTROOM_KEYS),
    /** Lightroom local value (-1..1). For exposure this is EV / 4. */
    value: z.number().min(-1).max(1),
  })
  .strict();

export const NormalizedMaskSchema = z
  .object({
    id: z.string().regex(MASK_ID_PATTERN),
    target: z.string().min(1).max(200),
    region: MaskRegionSchema,
    adjustments: z.array(NormalizedMaskAdjustmentSchema).min(1).max(MAX_ADJUSTMENTS_PER_MASK),
    placement_certainty: z.enum(["clear", "subjective"]),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const NormalizedEditPlanSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  operations: z.array(NormalizedOperationSchema).max(NORMALIZED_PARAMETERS.length),
  warnings: z.array(z.string().min(1).max(500)),
  masks: z.array(NormalizedMaskSchema).max(MAX_MASKS_PER_PHOTO).optional(),
});

/** Evaluator verdict on one applied mask. */
export const MaskFeedbackSchema = z
  .object({
    mask_id: z.string().regex(MASK_ID_PATTERN),
    assessment: z.enum(["ok", "too_strong", "misplaced", "unnecessary"]),
    note: z.string().min(1).max(500),
  })
  .strict();

export const EvaluationResultSchema = z
  .object({
    schema_version: z.literal("0.2.0"),
    verdict: z.enum(["accept", "refine", "review"]),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2000),
    issues: z.array(z.string().min(1).max(500)),
    refinement_plan: NormalizedEditPlanSchema.optional(),
    mask_feedback: z.array(MaskFeedbackSchema).max(MAX_MASKS_PER_PHOTO).optional(),
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
    if (value.refinement_plan?.masks && value.refinement_plan.masks.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["refinement_plan", "masks"],
        message: "Evaluators adjust masks only through mask_feedback, never new mask geometry",
      });
    }
    if (
      value.verdict === "accept" &&
      value.mask_feedback?.some((feedback) => feedback.assessment !== "ok")
    ) {
      context.addIssue({
        code: "custom",
        path: ["mask_feedback"],
        message: "accept verdict requires every mask_feedback assessment to be ok",
      });
    }
  });

/** Raw Lightroom `MaskGroupBasedCorrections` entry (kept opaque on purpose). */
export const LightroomMaskCorrectionSchema = z.record(z.string(), z.unknown());

export const MaskDecisionSchema = z
  .object({
    requested_mask_ids: z.array(z.string()),
    applied_mask_ids: z.array(z.string()),
    pending_review_mask_ids: z.array(z.string()),
    mode: z.enum(["none", "merge_readback", "replace_unverified", "degraded_to_global"]),
    backend_support: z.enum(["read_write", "write_only", "unsupported"]),
    reason: z.string().min(1).optional(),
    preserved_foreign_corrections: z.number().int().nonnegative(),
  })
  .strict();

export const SourceAssetPairSchema = z.object({
  raw_path: z.string().min(1),
  preview_path: z.string().min(1),
  raw_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_confidence: z.literal("high"),
});

export const BackendPhotoIdentitySchema = z
  .object({
    catalog_id: z.string().min(1),
    uuid: z.string().min(1),
    master_id: z.string().min(1),
    master_uuid: z.string().min(1),
    is_virtual_copy: z.boolean(),
  })
  .strict();

export const BackendPhotoStateSchema = z.object({
  photo_id: z.string().min(1),
  path: z.string().min(1),
  develop_settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  identity: BackendPhotoIdentitySchema.optional(),
});

/** Durable record written before every mask write; enables recover and restore-masks. */
export const MaskWriteIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    operation_id: z.string().min(1),
    kind: z.literal("mask_write"),
    phase: z.literal("started"),
    iteration: z.number().int().positive(),
    target: BackendPhotoIdentitySchema,
    mode: z.enum(["merge_readback", "replace_unverified"]),
    owner_prefix: z.string().min(1),
    /** Full mask set on the target before this write, when known. */
    before: z.array(LightroomMaskCorrectionSchema).nullable(),
    before_status: z.enum(["read_back", "written_by_this_session", "unverified_assumed_empty"]),
    requested: z.array(LightroomMaskCorrectionSchema),
    applied_mask_ids: z.array(z.string().regex(MASK_ID_PATTERN)),
  })
  .strict();

export const MaskWriteResultSchema = z
  .object({
    operation_id: z.string().min(1),
    iteration: z.number().int().positive(),
    readback_status: z.enum(["verified", "mismatch", "unavailable"]),
    read_back: z.array(LightroomMaskCorrectionSchema).nullable(),
  })
  .strict();

export const MaskRestoreEvidenceSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    restored_at: z.string().datetime(),
    source_operation_id: z.string().min(1),
    iteration: z.number().int().positive(),
    target: BackendPhotoIdentitySchema,
    written: z.array(LightroomMaskCorrectionSchema),
    before_status: z.enum(["read_back", "written_by_this_session", "unverified_assumed_empty"]),
    readback_status: z.enum(["verified", "mismatch", "unavailable"]),
    note: z.string().min(1),
  })
  .strict();

export const WorkflowCopyCandidateSchema = z
  .object({
    catalog_id: z.string().min(1),
    uuid: z.string().min(1),
    master_id: z.string().min(1).optional(),
    master_uuid: z.string().min(1).optional(),
    is_virtual_copy: z.boolean(),
  })
  .strict();

export const WorkflowCopyResultSchema = z
  .object({
    operation_id: z.string().min(1),
    result: z.enum(["created", "reconciled", "REVIEW_REQUIRED"]),
    partial: z.boolean(),
    marker: z.string().min(1).optional(),
    source: BackendPhotoIdentitySchema.optional(),
    master: BackendPhotoIdentitySchema.optional(),
    copy: BackendPhotoIdentitySchema.optional(),
    candidates: z.array(WorkflowCopyCandidateSchema).optional(),
    candidate_count: z.number().int().nonnegative().optional(),
    selection_restoration: z
      .object({
        status: z.enum(["not_needed", "restored", "not_attempted", "failed"]),
        verified: z.boolean(),
      })
      .strict(),
    reason: z.string().optional(),
  })
  .strict();

export const WorkflowCopyIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    operation_id: z.string().min(1),
    phase: z.literal("started"),
    source: BackendPhotoIdentitySchema,
  })
  .strict();

export const WorkflowCopyVerificationSchema = z
  .object({
    operation_id: z.string().min(1),
    verified: z.boolean(),
    master: BackendPhotoIdentitySchema,
    copy: BackendPhotoIdentitySchema.nullable(),
    inherited_develop_state: z.boolean(),
  })
  .strict();

export const DevelopIterationIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    operation_id: z.string().min(1),
    kind: z.literal("develop_iteration"),
    phase: z.literal("started"),
    iteration: z.number().int().positive(),
    target: BackendPhotoIdentitySchema,
    checkpoint_name: z.string().min(1),
    requested_settings: z.record(
      z.string(),
      z.union([z.number(), z.string(), z.boolean()]),
    ),
  })
  .strict();

export const CheckpointEvidenceSchema = z
  .object({
    iteration: z.number().int().positive(),
    operation_id: z.string().min(1),
    target: BackendPhotoIdentitySchema,
    checkpoint_name: z.string().min(1),
    checkpoint: z
      .object({
        name: z.string().min(1),
        raw: z.unknown(),
      })
      .strict(),
  })
  .strict();

export const DevelopReadbackEvidenceSchema = z
  .object({
    iteration: z.number().int().positive(),
    operation_id: z.string().min(1),
    target: BackendPhotoIdentitySchema,
    checkpoint_name: z.string().min(1),
    requested: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    read_back: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  })
  .strict();

export const RecoveryEvidenceSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    recovered_at: z.string().datetime(),
    interrupted_state: z.string().min(1),
    evidence_status: z.enum([
      "consistent",
      "contradictory",
      "insufficient",
      "readback_failed",
    ]),
    reason: z.string().min(1),
    requested_photo_id: z.string().min(1).optional(),
    target_photo_id: z.string().min(1).optional(),
    workflow_copy_intent: WorkflowCopyIntentSchema.nullable(),
    workflow_copy: WorkflowCopyResultSchema.nullable(),
    workflow_copy_verification: WorkflowCopyVerificationSchema.nullable(),
    checkpoint_artifacts: z.array(z.string().min(1)),
    operation_artifacts: z.array(z.string().min(1)),
    readback_artifacts: z.array(z.string().min(1)),
    operation_evidence_status: z.enum([
      "none",
      "consistent",
      "insufficient",
      "contradictory",
    ]),
    invalid_artifacts: z.array(z.string().min(1)),
    mask_artifacts: z.array(z.string().min(1)).optional(),
    mask_evidence_status: z
      .enum(["none", "consistent", "insufficient", "contradictory"])
      .optional(),
    read_back: BackendPhotoStateSchema.nullable(),
    copy_creation_reconciled: z.boolean(),
    copy_creation_retried: z.literal(false),
    mutation_retried: z.literal(false),
  })
  .strict();

export const OperationSemanticsSchema = z.object({
  supported: z.boolean(),
  side_effect: z.enum(["read_only", "temporary", "mutating", "delivery_export"]),
  idempotent: z.boolean(),
  reversible: z.enum(["true_undo", "checkpoint_only", "new_file", "irreversible"]),
  scope: z.enum(["photo", "selection", "catalog", "filesystem", "session"]),
  requires_active_selection: z.boolean(),
  requires_editor_foreground: z.boolean(),
  concurrency: z.enum(["parallel_safe", "per_photo_serialized", "exclusive_backend"]),
  retry_policy: z.enum(["automatic", "readback_before_retry", "manual_review_only"]),
  safe_to_resume: z.boolean(),
}).strict();

export const SemverSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a semantic version",
  );

export const BackendCapabilityManifestSchema = z
  .object({
    backend: z.string().min(1),
    version: SemverSchema,
    trust_boundary: z
      .object({
        transport: z.string().min(1),
        authentication: z.string().min(1),
        cloud: z.boolean(),
      })
      .strict(),
    capabilities: z.array(z.string().min(1)),
    operations: z.record(z.string(), OperationSemanticsSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const capability of manifest.capabilities) {
      if (seen.has(capability)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: `Duplicate capability: ${capability}`,
        });
      }
      seen.add(capability);
      const semantics = manifest.operations[capability];
      if (!semantics) {
        context.addIssue({
          code: "custom",
          path: ["operations", capability],
          message: `Missing operation semantics for capability: ${capability}`,
        });
      } else if (!semantics.supported) {
        context.addIssue({
          code: "custom",
          path: ["operations", capability, "supported"],
          message: `Unsupported operation cannot be advertised as a capability: ${capability}`,
        });
      }
    }
  });

export const SessionManifestSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  session_id: z.string().min(1),
  created_at: z.string().datetime(),
  source: SourceAssetPairSchema,
  provider: z.object({
    name: z.enum(["mock", "codex", "openai", "claude"]),
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
