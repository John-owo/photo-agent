import { z } from "zod";

export const SCHEMA_VERSION = "0.1.0" as const;

const direction = z.enum(["increase", "decrease", "unchanged"]);
const strength = z.enum(["slight", "medium", "strong"]);

const BASELINE_SEMANTIC_PARAMETERS = [
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

export const COLOR_MIXER_SEMANTIC_PARAMETERS = [
  "hue_red",
  "hue_orange",
  "hue_yellow",
  "hue_green",
  "hue_aqua",
  "hue_blue",
  "hue_purple",
  "hue_magenta",
  "saturation_red",
  "saturation_orange",
  "saturation_yellow",
  "saturation_green",
  "saturation_aqua",
  "saturation_blue",
  "saturation_purple",
  "saturation_magenta",
  "luminance_red",
  "luminance_orange",
  "luminance_yellow",
  "luminance_green",
  "luminance_aqua",
  "luminance_blue",
  "luminance_purple",
  "luminance_magenta",
] as const;

export const SEMANTIC_PARAMETERS = [
  ...BASELINE_SEMANTIC_PARAMETERS,
  ...COLOR_MIXER_SEMANTIC_PARAMETERS,
] as const;

export const BASELINE_NORMALIZED_PARAMETERS = [
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

export const COLOR_MIXER_PARAMETERS = [
  "hue_red",
  "hue_orange",
  "hue_yellow",
  "hue_green",
  "hue_aqua",
  "hue_blue",
  "hue_purple",
  "hue_magenta",
  "saturation_red",
  "saturation_orange",
  "saturation_yellow",
  "saturation_green",
  "saturation_aqua",
  "saturation_blue",
  "saturation_purple",
  "saturation_magenta",
  "luminance_red",
  "luminance_orange",
  "luminance_yellow",
  "luminance_green",
  "luminance_aqua",
  "luminance_blue",
  "luminance_purple",
  "luminance_magenta",
] as const;

export const NORMALIZED_PARAMETERS = [
  ...BASELINE_NORMALIZED_PARAMETERS,
  ...COLOR_MIXER_PARAMETERS,
] as const;

export type NormalizedParameter = (typeof NORMALIZED_PARAMETERS)[number];

export const TONE_CURVE_REGISTRY_VERSION = "0.1.0" as const;
export const TONE_CURVE_VARIANTS = ["master", "red", "green", "blue", "parametric"] as const;
export const TONE_CURVE_POINT_VARIANTS = ["master", "red", "green", "blue"] as const;
export const TONE_CURVE_PARAMETRIC_COMPONENTS = [
  "highlights",
  "lights",
  "darks",
  "shadows",
] as const;
export const TONE_CURVE_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason:
    "Structured tone-curve propagation is disabled until per-photo backend readback and rendered proof exist",
} as const;

export const DETAIL_REGISTRY_VERSION = "0.1.0" as const;
export const DETAIL_OPERATION_VARIANTS = ["sharpening", "noise_reduction"] as const;
export const DETAIL_NOISE_REDUCTION_MIN_ISO = 800;
export const DETAIL_HIGH_ISO_THRESHOLD = 6400;
export const DETAIL_PORTRAIT_MIN_SHARPEN_MASKING = 25;
export const DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING = 50;
export const DETAIL_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason:
    "Scene and ISO-conditioned detail adjustments require per-photo review before propagation",
} as const;

export const OPTICS_REGISTRY_VERSION = "0.1.0" as const;
export const OPTICS_LENS_CONTROLS = ["profile_corrections", "chromatic_aberration"] as const;
export const OPTICS_GEOMETRY_VARIANTS = ["crop", "rotation", "perspective"] as const;
export const OPTICS_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason:
    "Optics, profiles, and geometry are photo-specific and require per-photo evidence before propagation",
} as const;

export const FINISHING_REGISTRY_VERSION = "0.1.0" as const;
export const FINISHING_OPERATION_VARIANTS = ["vignette", "grain", "framing"] as const;
export const FINISHING_FRAMING_VARIANTS = ["crop", "rotation"] as const;
export const FINISHING_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason: "Finishing and framing changes require per-photo review before propagation",
} as const;

export const COLOR_GRADING_REGISTRY_VERSION = "0.1.0" as const;
export const COLOR_GRADING_WHEEL_VARIANTS = [
  "shadows",
  "midtones",
  "highlights",
  "global",
] as const;
export const COLOR_GRADING_SHARED_CONTROLS = ["blending", "balance"] as const;
export const COLOR_GRADING_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason:
    "Modern Color Grading is process-version and photo-context sensitive; per-photo proof is required before propagation",
} as const;

export const MASK_REGISTRY_VERSION = "0.1.0" as const;
export const MASK_SELECTOR_VARIANTS = ["id", "name"] as const;
export const MASK_PARAMETER_NAMES = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "texture",
  "clarity",
  "dehaze",
  "saturation",
  "sharpness",
  "luminance_noise_reduction",
  "moire",
  "defringe",
  "hue",
] as const;
export const MASK_PARAMETER_RANGES = {
  exposure: [-5, 5],
  contrast: [-100, 100],
  highlights: [-100, 100],
  shadows: [-100, 100],
  whites: [-100, 100],
  blacks: [-100, 100],
  temperature: [-100, 100],
  tint: [-100, 100],
  texture: [-100, 100],
  clarity: [-100, 100],
  dehaze: [-100, 100],
  saturation: [-100, 100],
  sharpness: [0, 150],
  luminance_noise_reduction: [0, 100],
  moire: [0, 100],
  defringe: [0, 100],
  hue: [-180, 180],
} as const satisfies Record<(typeof MASK_PARAMETER_NAMES)[number], readonly [number, number]>;
export const MASK_PROPAGATION_POLICY = {
  eligible: false,
  blocked_reason:
    "Existing-mask adjustments are Workflow Copy and mask-schema specific; per-photo preservation proof is required before propagation",
} as const;

export const PREFERENCE_REGISTRY_VERSION = "0.1.0" as const;
export const MIN_HISTORICAL_PREFERENCE_SAMPLES = 5;
export const MIN_HISTORICAL_PREFERENCE_CONFIDENCE = 0.65;
export const LOW_DATA_STYLE_PRIOR_CONFIDENCE_CAP = 0.5;

export const STYLE_HISTORY_REGISTRY_VERSION = "0.1.0" as const;
export const STYLE_HISTORY_MATCH_FIELDS = [
  "lighting_type",
  "subject_type",
  "camera",
  "lens",
  "iso",
  "delivery",
] as const;
export const STYLE_HISTORY_PROTECTED_ATTRIBUTES = ["natural_skin_tones"] as const;
export const STYLE_HISTORY_MIN_MATCH_SCORE = 0.55;
export const STYLE_HISTORY_MIN_CONFIDENCE = 0.65;
export const STYLE_HISTORY_DEFAULT_MAX_RESULTS = 8;
export const STYLE_HISTORY_EVALUATION_REGISTRY_VERSION = "0.1.0" as const;
export const STYLE_HISTORY_EVALUATION_MAX_CASES = 100_000;

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
  mode: z.enum(["delta", "absolute"]),
  value: z.number().finite(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
});

export const ParameterRegistryVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Parameter registry version must use MAJOR.MINOR.PATCH");

export const ParameterRangeSchema = z
  .tuple([z.number().finite(), z.number().finite()])
  .refine(([minimum, maximum]) => minimum <= maximum, "Parameter range must be ordered");

export const ParameterDefinitionSchema = z
  .object({
    parameter: z.string().min(1),
    semantic_parameter: z.string().min(1),
    control_group: z.enum(["global", "color_mixer"]).optional(),
    backend_key: z.string().min(1),
    unit: z.enum(["ev", "kelvin", "points"]),
    base_step: z.number().finite().positive(),
    supported: z.boolean(),
    allowed_modes: z.array(z.enum(["delta", "absolute"])).min(1),
    absolute_range: ParameterRangeSchema,
    delta_range: ParameterRangeSchema,
    conflicts_with: z.array(z.string().min(1)),
    depends_on: z.array(z.string().min(1)),
    propagation: z
      .object({
        eligible: z.boolean(),
        required_conditions: z.array(
          z.enum([
            "accepted_representative",
            "same_lighting_cluster",
            "high_confidence_source",
            "shortlisted_target",
          ]),
        ),
        minimum_confidence: z.number().min(0).max(1),
        blocked_reason: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    if (new Set(definition.allowed_modes).size !== definition.allowed_modes.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_modes"],
        message: "Parameter definition contains duplicate modes",
      });
    }
    for (const [field, values] of [
      ["conflicts_with", definition.conflicts_with],
      ["depends_on", definition.depends_on],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Parameter definition contains duplicate ${field} entries`,
        });
      }
      if (values.includes(definition.parameter)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Parameter definition cannot reference itself in ${field}`,
        });
      }
    }
  });

export const ParameterRegistrySnapshotSchema = z
  .object({
    version: ParameterRegistryVersionSchema,
    definitions: z.record(z.string().min(1), ParameterDefinitionSchema),
  })
  .strict();

export const ParameterRegistrySchema = ParameterRegistrySnapshotSchema;

export const ParameterRegistryMigrationSchema = z
  .object({
    from_version: ParameterRegistryVersionSchema,
    to_version: ParameterRegistryVersionSchema,
    strategy: z.string().min(1),
  })
  .strict();

export const NormalizedEditPlanSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  parameter_registry_version: z.string().min(1).optional(),
  parameter_registry_snapshot: ParameterRegistrySnapshotSchema.optional(),
  parameter_registry_migration: ParameterRegistryMigrationSchema.optional(),
  operations: z.array(NormalizedOperationSchema).max(NORMALIZED_PARAMETERS.length),
  warnings: z.array(z.string().min(1).max(500)),
});

export const StoredNormalizedEditPlanSchema = NormalizedEditPlanSchema.extend({
  parameter_registry_version: ParameterRegistryVersionSchema,
  parameter_registry_snapshot: ParameterRegistrySnapshotSchema,
}).strict();

const BackendSettingValueSchema = z.union([z.number().finite(), z.string(), z.boolean()]);

export const TranslatorGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: SemanticIntentPlanSchema,
    expected_plan: NormalizedEditPlanSchema,
    current_settings: z.record(z.string(), BackendSettingValueSchema).optional(),
    expected_settings: z.record(z.string(), BackendSettingValueSchema).optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_settings === undefined) !== (vector.expected_settings === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_settings"],
        message: "current_settings and expected_settings must be provided together",
      });
    }
  });

const ToneCurvePointSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
  })
  .strict();

function validateToneCurvePoints(
  points: readonly { x: number; y: number }[],
  context: z.RefinementCtx,
): void {
  if (points[0]?.x !== 0) {
    context.addIssue({
      code: "custom",
      path: ["points", 0, "x"],
      message: "Tone-curve point coordinates must start at x=0",
    });
  }
  if (points.at(-1)?.x !== 1) {
    context.addIssue({
      code: "custom",
      path: ["points", points.length - 1, "x"],
      message: "Tone-curve point coordinates must end at x=1",
    });
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current && current.x <= previous.x) {
      context.addIssue({
        code: "custom",
        path: ["points", index, "x"],
        message: "Tone-curve point x coordinates must be strictly increasing",
      });
    }
  }
}

export const ToneCurvePointPayloadSchema = z
  .object({
    variant: z.enum(TONE_CURVE_POINT_VARIANTS),
    kind: z.literal("points"),
    points: z.array(ToneCurvePointSchema).min(2).max(17),
  })
  .strict()
  .superRefine((payload, context) => validateToneCurvePoints(payload.points, context));

export const ToneCurveParametricValuesSchema = z
  .object({
    highlights: z.number().finite().min(-100).max(100),
    lights: z.number().finite().min(-100).max(100),
    darks: z.number().finite().min(-100).max(100),
    shadows: z.number().finite().min(-100).max(100),
  })
  .strict();

export const ToneCurveParametricPayloadSchema = z
  .object({
    variant: z.literal("parametric"),
    kind: z.literal("parametric"),
    values: ToneCurveParametricValuesSchema,
  })
  .strict();

export const ToneCurvePayloadSchema = z.discriminatedUnion("kind", [
  ToneCurvePointPayloadSchema,
  ToneCurveParametricPayloadSchema,
]);

export const ToneCurvePointOperationSchema = z
  .object({
    variant: z.enum(TONE_CURVE_POINT_VARIANTS),
    kind: z.literal("points"),
    mode: z.literal("absolute"),
    points: z.array(ToneCurvePointSchema).min(2).max(17),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict()
  .superRefine((operation, context) => validateToneCurvePoints(operation.points, context));

export const ToneCurveParametricOperationSchema = z
  .object({
    variant: z.literal("parametric"),
    kind: z.literal("parametric"),
    mode: z.literal("absolute"),
    values: ToneCurveParametricValuesSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const ToneCurveOperationSchema = z.discriminatedUnion("kind", [
  ToneCurvePointOperationSchema,
  ToneCurveParametricOperationSchema,
]);

function validateToneCurveOperationSet(
  operations: readonly { variant: string }[],
  context: z.RefinementCtx,
): void {
  const variants = operations.map((operation) => operation.variant);
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant)) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Tone-curve variant may only appear once: ${variant}`,
      });
    }
    seen.add(variant);
  }
  if (variants.includes("master") && variants.some((variant) => variant !== "master")) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Tone-curve master conflicts with RGB and parametric variants",
    });
  }
  if (variants.includes("parametric") && variants.some((variant) => variant !== "parametric")) {
    context.addIssue({
      code: "custom",
      path: ["operations"],
      message: "Tone-curve parametric mode conflicts with point-curve variants",
    });
  }
}

export const ToneCurveIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    creative_goal: z.string().min(1).max(500),
    operations: z.array(ToneCurveOperationSchema).max(TONE_CURVE_VARIANTS.length),
    overall_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((intent, context) => validateToneCurveOperationSet(intent.operations, context));

export const ToneCurvePlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    tone_curve_registry_version: z.literal(TONE_CURVE_REGISTRY_VERSION),
    operations: z.array(ToneCurveOperationSchema).max(TONE_CURVE_VARIANTS.length),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => validateToneCurveOperationSet(plan.operations, context));

function validateUniqueToneCurveVariants(
  curves: readonly { variant: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const curve of curves) {
    if (seen.has(curve.variant)) {
      context.addIssue({
        code: "custom",
        path: ["curves"],
        message: `Tone-curve readback contains duplicate variant: ${curve.variant}`,
      });
    }
    seen.add(curve.variant);
  }
}

export const ToneCurveReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    tone_curve_registry_version: z.literal(TONE_CURVE_REGISTRY_VERSION),
    curves: z.array(ToneCurvePayloadSchema).max(TONE_CURVE_VARIANTS.length),
  })
  .strict()
  .superRefine((readback, context) => validateUniqueToneCurveVariants(readback.curves, context));

export const ToneCurveGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: ToneCurveIntentSchema,
    expected_plan: ToneCurvePlanSchema,
    current_readback: ToneCurveReadbackSchema.optional(),
    expected_readback: ToneCurveReadbackSchema.optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_readback === undefined) !== (vector.expected_readback === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_readback"],
        message: "current_readback and expected_readback must be provided together",
      });
    }
  });

export const DetailPlanningContextSchema = z
  .object({
    scene_type: z.string().min(1).max(100),
    iso: z.number().int().min(1).max(1_000_000),
    lighting_type: z.string().min(1).max(100).optional(),
  })
  .strict();

export const DetailSharpeningPayloadSchema = z
  .object({
    kind: z.literal("sharpening"),
    amount: z.number().finite().min(0).max(150),
    radius: z.number().finite().min(0.5).max(3),
    detail: z.number().finite().min(0).max(100),
    masking: z.number().finite().min(0).max(100),
  })
  .strict();

export const DetailNoiseReductionPayloadSchema = z
  .object({
    kind: z.literal("noise_reduction"),
    luminance: z.number().finite().min(0).max(100),
    luminance_detail: z.number().finite().min(0).max(100),
    luminance_contrast: z.number().finite().min(0).max(100),
    color: z.number().finite().min(0).max(100),
    color_detail: z.number().finite().min(0).max(100),
    color_smoothness: z.number().finite().min(0).max(100),
  })
  .strict();

export const DetailPayloadSchema = z.discriminatedUnion("kind", [
  DetailSharpeningPayloadSchema,
  DetailNoiseReductionPayloadSchema,
]);

export const DetailSharpeningOperationSchema = z
  .object({
    kind: z.literal("sharpening"),
    mode: z.literal("absolute"),
    amount: z.number().finite().min(0).max(150),
    radius: z.number().finite().min(0.5).max(3),
    detail: z.number().finite().min(0).max(100),
    masking: z.number().finite().min(0).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const DetailNoiseReductionOperationSchema = z
  .object({
    kind: z.literal("noise_reduction"),
    mode: z.literal("absolute"),
    luminance: z.number().finite().min(0).max(100),
    luminance_detail: z.number().finite().min(0).max(100),
    luminance_contrast: z.number().finite().min(0).max(100),
    color: z.number().finite().min(0).max(100),
    color_detail: z.number().finite().min(0).max(100),
    color_smoothness: z.number().finite().min(0).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const DetailOperationSchema = z.discriminatedUnion("kind", [
  DetailSharpeningOperationSchema,
  DetailNoiseReductionOperationSchema,
]);

function validateUniqueDetailOperations(
  operations: readonly { kind: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.kind)) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Detail operation may only appear once: ${operation.kind}`,
      });
    }
    seen.add(operation.kind);
  }
}

function isPortraitDetailScene(sceneType: string): boolean {
  return /portrait|people|wedding|skin/i.test(sceneType);
}

function validateDetailDependencies(
  contextValue: z.infer<typeof DetailPlanningContextSchema>,
  operations: readonly z.infer<typeof DetailOperationSchema>[],
  context: z.RefinementCtx,
): void {
  for (const [index, operation] of operations.entries()) {
    if (operation.kind === "noise_reduction" && contextValue.iso < DETAIL_NOISE_REDUCTION_MIN_ISO) {
      context.addIssue({
        code: "custom",
        path: ["operations", index],
        message: `Noise reduction requires ISO >= ${DETAIL_NOISE_REDUCTION_MIN_ISO}`,
      });
    }
    if (
      operation.kind === "sharpening" &&
      isPortraitDetailScene(contextValue.scene_type) &&
      operation.masking < DETAIL_PORTRAIT_MIN_SHARPEN_MASKING
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations", index, "masking"],
        message: `Portrait sharpening requires masking >= ${DETAIL_PORTRAIT_MIN_SHARPEN_MASKING}`,
      });
    }
    if (
      operation.kind === "sharpening" &&
      contextValue.iso >= DETAIL_HIGH_ISO_THRESHOLD &&
      operation.masking < DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING
    ) {
      context.addIssue({
        code: "custom",
        path: ["operations", index, "masking"],
        message: `High-ISO sharpening requires masking >= ${DETAIL_HIGH_ISO_MIN_SHARPEN_MASKING}`,
      });
    }
  }
}

export const DetailIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    creative_goal: z.string().min(1).max(500),
    context: DetailPlanningContextSchema,
    operations: z.array(DetailOperationSchema).max(DETAIL_OPERATION_VARIANTS.length),
    overall_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((intent, context) => validateUniqueDetailOperations(intent.operations, context));

export const DetailPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    detail_registry_version: z.literal(DETAIL_REGISTRY_VERSION),
    context: DetailPlanningContextSchema,
    operations: z.array(DetailOperationSchema).max(DETAIL_OPERATION_VARIANTS.length),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    validateUniqueDetailOperations(plan.operations, context);
    validateDetailDependencies(plan.context, plan.operations, context);
  });

export const DetailReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    detail_registry_version: z.literal(DETAIL_REGISTRY_VERSION),
    operations: z.array(DetailPayloadSchema).max(DETAIL_OPERATION_VARIANTS.length),
  })
  .strict()
  .superRefine((readback, context) => validateUniqueDetailOperations(readback.operations, context));

export const DetailGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: DetailIntentSchema,
    expected_plan: DetailPlanSchema,
    current_readback: DetailReadbackSchema.optional(),
    expected_readback: DetailReadbackSchema.optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_readback === undefined) !== (vector.expected_readback === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_readback"],
        message: "current_readback and expected_readback must be provided together",
      });
    }
  });

export const OpticsLensPayloadSchema = z
  .object({
    kind: z.literal("lens_correction"),
    profile_corrections: z.boolean(),
    chromatic_aberration: z.boolean(),
  })
  .strict();

export const OpticsProfilePayloadSchema = z
  .object({
    kind: z.literal("profile"),
    profile_name: z.string().min(1).max(100),
  })
  .strict();

const OpticsCropSettingsSchema = z
  .object({
    variant: z.literal("crop"),
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    bottom: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.left >= settings.right) {
      context.addIssue({
        code: "custom",
        path: ["left", "right"],
        message: "Crop left must be less than right",
      });
    }
    if (settings.top >= settings.bottom) {
      context.addIssue({
        code: "custom",
        path: ["top", "bottom"],
        message: "Crop top must be less than bottom",
      });
    }
  });

const OpticsRotationSettingsSchema = z
  .object({
    variant: z.literal("rotation"),
    angle: z.number().finite().min(-45).max(45),
  })
  .strict();

const OpticsPerspectiveSettingsSchema = z
  .object({
    variant: z.literal("perspective"),
    horizontal: z.number().finite().min(-100).max(100),
    vertical: z.number().finite().min(-100).max(100),
    scale: z.number().finite().min(0.5).max(2),
  })
  .strict();

export const OpticsGeometrySettingsSchema = z.discriminatedUnion("variant", [
  OpticsCropSettingsSchema,
  OpticsRotationSettingsSchema,
  OpticsPerspectiveSettingsSchema,
]);

export const OpticsGeometryPayloadSchema = z
  .object({
    kind: z.literal("geometry"),
    settings: OpticsGeometrySettingsSchema,
  })
  .strict();

export const OpticsPayloadSchema = z.union([
  OpticsLensPayloadSchema,
  OpticsProfilePayloadSchema,
  OpticsGeometryPayloadSchema,
]);

export const OpticsLensOperationSchema = z
  .object({
    kind: z.literal("lens_correction"),
    mode: z.literal("absolute"),
    profile_corrections: z.boolean(),
    chromatic_aberration: z.boolean(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const OpticsProfileOperationSchema = z
  .object({
    kind: z.literal("profile"),
    mode: z.literal("absolute"),
    profile_name: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const OpticsGeometryOperationSchema = z
  .object({
    kind: z.literal("geometry"),
    mode: z.literal("absolute"),
    settings: OpticsGeometrySettingsSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const OpticsOperationSchema = z.union([
  OpticsLensOperationSchema,
  OpticsProfileOperationSchema,
  OpticsGeometryOperationSchema,
]);

function opticsOperationIdentity(operation: {
  kind: string;
  settings?: { variant: string };
}): string {
  return operation.kind === "geometry"
    ? `geometry:${operation.settings?.variant ?? "unknown"}`
    : operation.kind;
}

function validateUniqueOpticsOperations(
  operations: readonly { kind: string; settings?: { variant: string } }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const identity = opticsOperationIdentity(operation);
    if (seen.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Optics operation may only appear once: ${identity}`,
      });
    }
    seen.add(identity);
  }
}

export const OpticsIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    creative_goal: z.string().min(1).max(500),
    operations: z.array(OpticsOperationSchema).max(5),
    overall_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((intent, context) => validateUniqueOpticsOperations(intent.operations, context));

export const OpticsPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    optics_registry_version: z.literal(OPTICS_REGISTRY_VERSION),
    operations: z.array(OpticsOperationSchema).max(5),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => validateUniqueOpticsOperations(plan.operations, context));

export const OpticsReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    optics_registry_version: z.literal(OPTICS_REGISTRY_VERSION),
    operations: z.array(OpticsPayloadSchema).max(5),
  })
  .strict()
  .superRefine((readback, context) =>
    validateUniqueOpticsOperations(
      readback.operations.map((operation) =>
        operation.kind === "geometry"
          ? { kind: operation.kind, settings: operation.settings }
          : operation,
      ),
      context,
    ),
  );

export const OpticsGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: OpticsIntentSchema,
    expected_plan: OpticsPlanSchema,
    current_readback: OpticsReadbackSchema.optional(),
    expected_readback: OpticsReadbackSchema.optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_readback === undefined) !== (vector.expected_readback === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_readback"],
        message: "current_readback and expected_readback must be provided together",
      });
    }
  });

export const FinishingVignettePayloadSchema = z
  .object({
    kind: z.literal("vignette"),
    amount: z.number().finite().min(-100).max(100),
    midpoint: z.number().finite().min(0).max(100),
    roundness: z.number().finite().min(-100).max(100),
    feather: z.number().finite().min(0).max(100),
  })
  .strict();

export const FinishingGrainPayloadSchema = z
  .object({
    kind: z.literal("grain"),
    amount: z.number().finite().min(0).max(100),
    size: z.number().finite().min(0).max(100),
    roughness: z.number().finite().min(0).max(100),
  })
  .strict();

const FinishingCropSettingsSchema = z
  .object({
    variant: z.literal("crop"),
    left: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    bottom: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.left >= settings.right) {
      context.addIssue({
        code: "custom",
        path: ["left", "right"],
        message: "Framing crop left must be less than right",
      });
    }
    if (settings.top >= settings.bottom) {
      context.addIssue({
        code: "custom",
        path: ["top", "bottom"],
        message: "Framing crop top must be less than bottom",
      });
    }
  });

const FinishingRotationSettingsSchema = z
  .object({
    variant: z.literal("rotation"),
    angle: z.number().finite().min(-45).max(45),
  })
  .strict();

export const FinishingFramingSettingsSchema = z.discriminatedUnion("variant", [
  FinishingCropSettingsSchema,
  FinishingRotationSettingsSchema,
]);

export const FinishingFramingPayloadSchema = z
  .object({
    kind: z.literal("framing"),
    settings: FinishingFramingSettingsSchema,
  })
  .strict();

export const FinishingPayloadSchema = z.union([
  FinishingVignettePayloadSchema,
  FinishingGrainPayloadSchema,
  FinishingFramingPayloadSchema,
]);

export const FinishingVignetteOperationSchema = z
  .object({
    kind: z.literal("vignette"),
    mode: z.literal("absolute"),
    amount: z.number().finite().min(-100).max(100),
    midpoint: z.number().finite().min(0).max(100),
    roundness: z.number().finite().min(-100).max(100),
    feather: z.number().finite().min(0).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const FinishingGrainOperationSchema = z
  .object({
    kind: z.literal("grain"),
    mode: z.literal("absolute"),
    amount: z.number().finite().min(0).max(100),
    size: z.number().finite().min(0).max(100),
    roughness: z.number().finite().min(0).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const FinishingFramingOperationSchema = z
  .object({
    kind: z.literal("framing"),
    mode: z.literal("absolute"),
    settings: FinishingFramingSettingsSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const FinishingOperationSchema = z.union([
  FinishingVignetteOperationSchema,
  FinishingGrainOperationSchema,
  FinishingFramingOperationSchema,
]);

function finishingOperationIdentity(operation: {
  kind: string;
  settings?: { variant: string };
}): string {
  return operation.kind === "framing"
    ? `framing:${operation.settings?.variant ?? "unknown"}`
    : operation.kind;
}

function validateUniqueFinishingOperations(
  operations: readonly { kind: string; settings?: { variant: string } }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const identity = finishingOperationIdentity(operation);
    if (seen.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Finishing operation may only appear once: ${identity}`,
      });
    }
    seen.add(identity);
  }
}

export const FinishingIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    creative_goal: z.string().min(1).max(500),
    operations: z.array(FinishingOperationSchema).max(4),
    overall_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((intent, context) => validateUniqueFinishingOperations(intent.operations, context));

export const FinishingPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    finishing_registry_version: z.literal(FINISHING_REGISTRY_VERSION),
    operations: z.array(FinishingOperationSchema).max(4),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    human_review_required: z.boolean(),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    validateUniqueFinishingOperations(plan.operations, context);
    const hasHighRiskFraming = plan.operations.some((operation) => operation.kind === "framing");
    if (plan.human_review_required !== hasHighRiskFraming) {
      context.addIssue({
        code: "custom",
        path: ["human_review_required"],
        message: "Crop and rotation require explicit per-photo human review",
      });
    }
  });

export const FinishingReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    finishing_registry_version: z.literal(FINISHING_REGISTRY_VERSION),
    operations: z.array(FinishingPayloadSchema).max(4),
  })
  .strict()
  .superRefine((readback, context) =>
    validateUniqueFinishingOperations(
      readback.operations.map((operation) =>
        operation.kind === "framing"
          ? { kind: operation.kind, settings: operation.settings }
          : operation,
      ),
      context,
    ),
  );

export const FinishingGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: FinishingIntentSchema,
    expected_plan: FinishingPlanSchema,
    current_readback: FinishingReadbackSchema.optional(),
    expected_readback: FinishingReadbackSchema.optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_readback === undefined) !== (vector.expected_readback === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_readback"],
        message: "current_readback and expected_readback must be provided together",
      });
    }
  });

const ColorGradingHueSchema = z.number().finite().min(0).max(360);
const ColorGradingSaturationSchema = z.number().finite().min(0).max(100);
const ColorGradingLuminanceSchema = z.number().finite().min(-100).max(100);

const ColorGradingWheelValueFieldsSchema = z
  .object({
    hue: ColorGradingHueSchema,
    saturation: ColorGradingSaturationSchema,
    luminance: ColorGradingLuminanceSchema,
  })
  .strict();

export const ColorGradingWheelPayloadSchema = ColorGradingWheelValueFieldsSchema.extend({
  kind: z.literal("wheel"),
  variant: z.enum(COLOR_GRADING_WHEEL_VARIANTS),
}).strict();

const ColorGradingBlendingPayloadSchema = z
  .object({
    kind: z.literal("shared"),
    control: z.literal("blending"),
    value: z.number().finite().min(0).max(100),
  })
  .strict();

const ColorGradingBalancePayloadSchema = z
  .object({
    kind: z.literal("shared"),
    control: z.literal("balance"),
    value: z.number().finite().min(-100).max(100),
  })
  .strict();

export const ColorGradingSharedPayloadSchema = z.discriminatedUnion("control", [
  ColorGradingBlendingPayloadSchema,
  ColorGradingBalancePayloadSchema,
]);

export const ColorGradingPayloadSchema = z.union([
  ColorGradingWheelPayloadSchema,
  ColorGradingSharedPayloadSchema,
]);

export const ColorGradingWheelOperationSchema = ColorGradingWheelValueFieldsSchema.extend({
  kind: z.literal("wheel"),
  variant: z.enum(COLOR_GRADING_WHEEL_VARIANTS),
  mode: z.literal("absolute"),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
}).strict();

const ColorGradingBlendingOperationSchema = z
  .object({
    kind: z.literal("shared"),
    control: z.literal("blending"),
    mode: z.literal("absolute"),
    value: z.number().finite().min(0).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

const ColorGradingBalanceOperationSchema = z
  .object({
    kind: z.literal("shared"),
    control: z.literal("balance"),
    mode: z.literal("absolute"),
    value: z.number().finite().min(-100).max(100),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(500),
  })
  .strict();

export const ColorGradingSharedOperationSchema = z.discriminatedUnion("control", [
  ColorGradingBlendingOperationSchema,
  ColorGradingBalanceOperationSchema,
]);

export const ColorGradingOperationSchema = z.union([
  ColorGradingWheelOperationSchema,
  ColorGradingSharedOperationSchema,
]);

function colorGradingOperationIdentity(operation: {
  kind: string;
  variant?: string;
  control?: string;
}): string {
  return operation.kind === "wheel"
    ? `wheel:${operation.variant ?? "unknown"}`
    : `shared:${operation.control ?? "unknown"}`;
}

function validateUniqueColorGradingOperations(
  operations: readonly { kind: string; variant?: string; control?: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const identity = colorGradingOperationIdentity(operation);
    if (seen.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: `Color Grading operation may only appear once: ${identity}`,
      });
    }
    seen.add(identity);
  }
}

export const ColorGradingIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    color_grading_mode: z.literal("modern"),
    process_version: z.string().min(1).max(100),
    creative_goal: z.string().min(1).max(500),
    operations: z.array(ColorGradingOperationSchema).max(6),
    overall_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((intent, context) =>
    validateUniqueColorGradingOperations(intent.operations, context),
  );

export const ColorGradingPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    color_grading_registry_version: z.literal(COLOR_GRADING_REGISTRY_VERSION),
    color_grading_mode: z.literal("modern"),
    process_version: z.string().min(1).max(100),
    operations: z.array(ColorGradingOperationSchema).max(6),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => validateUniqueColorGradingOperations(plan.operations, context));

export const ColorGradingReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    color_grading_registry_version: z.literal(COLOR_GRADING_REGISTRY_VERSION),
    color_grading_mode: z.literal("modern"),
    process_version: z.string().min(1).max(100),
    operations: z.array(ColorGradingPayloadSchema).max(6),
  })
  .strict()
  .superRefine((readback, context) =>
    validateUniqueColorGradingOperations(readback.operations, context),
  );

export const ColorGradingGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: ColorGradingIntentSchema,
    expected_plan: ColorGradingPlanSchema,
    current_readback: ColorGradingReadbackSchema.optional(),
    expected_readback: ColorGradingReadbackSchema.optional(),
  })
  .strict()
  .superRefine((vector, context) => {
    if ((vector.current_readback === undefined) !== (vector.expected_readback === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_readback"],
        message: "current_readback and expected_readback must be provided together",
      });
    }
  });

export const PreferenceContextSchema = z
  .object({
    scene_type: z.string().min(1).max(100).optional(),
    lighting_type: z.string().min(1).max(100).optional(),
    camera_model: z.string().min(1).max(200).optional(),
    lens: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(100)).max(16).optional(),
  })
  .strict();

const PreferenceRuleSourceSchema = z.enum(["explicit_protected", "historical", "general_guidance"]);

export const PreferenceRuleSchema = z
  .object({
    id: z.string().min(1).max(200),
    source: PreferenceRuleSourceSchema,
    protected: z.boolean(),
    context: PreferenceContextSchema,
    parameter: z.enum(NORMALIZED_PARAMETERS),
    mode: z.enum(["delta", "absolute"]),
    value: z.number().finite(),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(16),
    sample_count: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.source === "explicit_protected" && !rule.protected) {
      context.addIssue({
        code: "custom",
        path: ["protected"],
        message: "Explicit preference rules must be protected",
      });
    }
    if (rule.source !== "explicit_protected" && rule.protected) {
      context.addIssue({
        code: "custom",
        path: ["protected"],
        message: "Only explicit preference rules may be protected",
      });
    }
  });

export const StylePriorSchema = z
  .object({
    parameter: z.enum(NORMALIZED_PARAMETERS),
    mode: z.enum(["delta", "absolute"]),
    value: z.number().finite(),
    basis: z.enum(["explicit_protected", "historical", "general_fallback"]),
    rule_ids: z.array(z.string().min(1).max(200)).min(1).max(16),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(32),
    sample_count: z.number().int().nonnegative(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(1000),
  })
  .strict();

function validateUniquePreferenceRuleIds(
  rules: readonly { id: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (seen.has(rule.id)) {
      context.addIssue({
        code: "custom",
        path: ["rules", index, "id"],
        message: `Preference rule id may only appear once: ${rule.id}`,
      });
    }
    seen.add(rule.id);
  }
}

export const StylePriorRequestSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    context: PreferenceContextSchema,
    rules: z.array(PreferenceRuleSchema).max(128),
    general_guidance: z.array(PreferenceRuleSchema).max(NORMALIZED_PARAMETERS.length),
  })
  .strict()
  .superRefine((request, context) => {
    validateUniquePreferenceRuleIds([...request.rules, ...request.general_guidance], context);
    request.rules.forEach((rule, index) => {
      if (rule.source === "general_guidance") {
        context.addIssue({
          code: "custom",
          path: ["rules", index, "source"],
          message: "General guidance must be supplied in general_guidance",
        });
      }
    });
    request.general_guidance.forEach((rule, index) => {
      if (rule.source !== "general_guidance") {
        context.addIssue({
          code: "custom",
          path: ["general_guidance", index, "source"],
          message: "general_guidance entries must use source general_guidance",
        });
      }
    });
  });

export const StylePriorPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    preference_registry_version: z.literal(PREFERENCE_REGISTRY_VERSION),
    context: PreferenceContextSchema,
    priors: z.array(StylePriorSchema).max(NORMALIZED_PARAMETERS.length),
    warnings: z.array(z.string().min(1).max(500)).max(16),
    review_required: z.boolean(),
  })
  .strict()
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    for (const [index, prior] of plan.priors.entries()) {
      if (seen.has(prior.parameter)) {
        context.addIssue({
          code: "custom",
          path: ["priors", index, "parameter"],
          message: `Style Prior may only appear once per parameter: ${prior.parameter}`,
        });
      }
      seen.add(prior.parameter);
    }
  });

export const StylePriorGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    request: StylePriorRequestSchema,
    expected_plan: StylePriorPlanSchema,
  })
  .strict();

export const StylePerceptualProfileSchema = z
  .object({
    luminance: z.number().finite().min(-1).max(1),
    contrast: z.number().finite().min(-1).max(1),
    colorfulness: z.number().finite().min(-1).max(1),
    warmth: z.number().finite().min(-1).max(1),
    natural_skin_tones: z.boolean(),
  })
  .strict();

export const StyleHistoryContextSchema = z
  .object({
    lighting_type: z.string().min(1).max(100).optional(),
    subject_type: z.string().min(1).max(100).optional(),
    camera: z.string().min(1).max(200).optional(),
    lens: z.string().min(1).max(200).optional(),
    iso: z.number().int().positive().max(1_000_000).optional(),
    delivery: z.string().min(1).max(100).optional(),
  })
  .strict();

export const StyleHistoryExampleSchema = z
  .object({
    example_id: z.string().min(1).max(200),
    shoot_id: z.string().min(1).max(200),
    context: StyleHistoryContextSchema,
    perceptual_profile: StylePerceptualProfileSchema,
    evidence: z.array(z.string().min(1).max(500)).min(1).max(16),
    confidence: z.number().min(0).max(1),
    failures: z.array(z.string().min(1).max(500)).max(8),
  })
  .strict();

export const StyleHistorySnapshotSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    history_registry_version: z.literal(STYLE_HISTORY_REGISTRY_VERSION),
    dataset_id: z.string().min(1).max(200),
    dataset_revision: z.string().min(1).max(200),
    dataset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    examples: z.array(StyleHistoryExampleSchema).max(100_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    for (const [index, example] of snapshot.examples.entries()) {
      if (seen.has(example.example_id)) {
        context.addIssue({
          code: "custom",
          path: ["examples", index, "example_id"],
          message: `Style history example id may only appear once: ${example.example_id}`,
        });
      }
      seen.add(example.example_id);
    }
  });

export const StyleHistoryQuerySchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    query_id: z.string().min(1).max(200),
    context: StyleHistoryContextSchema,
    protected_attributes: z
      .array(z.enum(STYLE_HISTORY_PROTECTED_ATTRIBUTES))
      .max(STYLE_HISTORY_PROTECTED_ATTRIBUTES.length),
    target_profile: StylePerceptualProfileSchema.optional(),
    exclude_shoot_ids: z.array(z.string().min(1).max(200)).max(10_000),
    exclude_example_ids: z.array(z.string().min(1).max(200)).max(10_000),
    max_results: z.number().int().positive().max(32),
    min_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((query, context) => {
    if (new Set(query.protected_attributes).size !== query.protected_attributes.length) {
      context.addIssue({
        code: "custom",
        path: ["protected_attributes"],
        message: "Style history protected attributes may not contain duplicates",
      });
    }
    if (query.context.iso === undefined && Object.keys(query.context).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["context"],
        message: "Scene-conditioned history query requires at least one context field",
      });
    }
  });

const StyleHistoryMatchComponentsSchema = z
  .object({
    lighting_type: z.number().min(0).max(1),
    subject_type: z.number().min(0).max(1),
    camera: z.number().min(0).max(1),
    lens: z.number().min(0).max(1),
    iso: z.number().min(0).max(1),
    delivery: z.number().min(0).max(1),
    perceptual_profile: z.number().min(0).max(1),
  })
  .strict();

const StyleReferenceRelationshipSchema = z
  .object({
    luminance_delta: z.number().finite().min(-2).max(2),
    contrast_delta: z.number().finite().min(-2).max(2),
    colorfulness_delta: z.number().finite().min(-2).max(2),
    warmth_delta: z.number().finite().min(-2).max(2),
    natural_skin_tones_preserved: z.literal(true),
  })
  .strict();

export const StyleHistoryMatchSchema = z
  .object({
    example_id: z.string().min(1).max(200),
    shoot_id: z.string().min(1).max(200),
    rank: z.number().int().positive(),
    score: z.number().min(0).max(1),
    match_components: StyleHistoryMatchComponentsSchema,
    reference_profile: StylePerceptualProfileSchema,
    protected_attributes: z.array(z.enum(STYLE_HISTORY_PROTECTED_ATTRIBUTES)),
    evidence: z.array(z.string().min(1).max(500)).min(1).max(16),
    confidence: z.number().min(0).max(1),
    reference_relationship: StyleReferenceRelationshipSchema.optional(),
  })
  .strict();

export const StyleHistoryRetrievalSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    history_registry_version: z.literal(STYLE_HISTORY_REGISTRY_VERSION),
    dataset_id: z.string().min(1).max(200),
    dataset_revision: z.string().min(1).max(200),
    dataset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    query_id: z.string().min(1).max(200),
    population: z.number().int().nonnegative(),
    sample_size: z.number().int().nonnegative(),
    matches: z.array(StyleHistoryMatchSchema).max(32),
    evidence_confidence: z.number().min(0).max(1),
    failures: z.array(z.string().min(1).max(500)).max(16),
    review_outcomes: z.array(z.string().min(1).max(500)).max(16),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.sample_size !== result.matches.length) {
      context.addIssue({
        code: "custom",
        path: ["sample_size"],
        message: "Style history sample_size must equal matches length",
      });
    }
    const ranks = result.matches.map((match) => match.rank);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      context.addIssue({
        code: "custom",
        path: ["matches"],
        message: "Style history match ranks must be contiguous starting at one",
      });
    }
  });

export const StyleHistoryGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    snapshot: StyleHistorySnapshotSchema,
    query: StyleHistoryQuerySchema,
    expected_result: StyleHistoryRetrievalSchema,
  })
  .strict();

const StyleHistoryShootIdsSchema = z.array(z.string().min(1).max(200)).max(100_000);

export const StyleHistoryEvaluationSplitSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    split_id: z.string().min(1).max(200),
    split_revision: z.string().min(1).max(200),
    split_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    construction_shoot_ids: StyleHistoryShootIdsSchema.min(1),
    held_out_shoot_ids: StyleHistoryShootIdsSchema.min(1),
    excluded_shoot_ids: StyleHistoryShootIdsSchema,
  })
  .strict()
  .superRefine((split, context) => {
    const lists = [
      ["construction_shoot_ids", split.construction_shoot_ids],
      ["held_out_shoot_ids", split.held_out_shoot_ids],
      ["excluded_shoot_ids", split.excluded_shoot_ids],
    ] as const;
    const seen = new Set<string>();
    for (const [field, ids] of lists) {
      for (const [index, id] of ids.entries()) {
        if (seen.has(id)) {
          context.addIssue({
            code: "custom",
            path: [field, index],
            message: `Style history evaluation shoot id may only appear once: ${id}`,
          });
        }
        seen.add(id);
      }
    }
  });

export const StyleHistoryEvaluationRequestSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    evaluation_registry_version: z.literal(STYLE_HISTORY_EVALUATION_REGISTRY_VERSION),
    evaluation_id: z.string().min(1).max(200),
    split: StyleHistoryEvaluationSplitSchema,
    protected_attributes: z
      .array(z.enum(STYLE_HISTORY_PROTECTED_ATTRIBUTES))
      .max(STYLE_HISTORY_PROTECTED_ATTRIBUTES.length),
    max_results: z.number().int().positive().max(32),
    max_examples: z.number().int().positive().max(STYLE_HISTORY_EVALUATION_MAX_CASES),
    min_confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.protected_attributes).size !== request.protected_attributes.length) {
      context.addIssue({
        code: "custom",
        path: ["protected_attributes"],
        message: "Style history evaluation protected attributes may not contain duplicates",
      });
    }
  });

export const StyleHistoryEvaluationCaseSchema = z
  .object({
    held_out_example_id: z.string().min(1).max(200),
    held_out_shoot_id: z.string().min(1).max(200),
    reference_example_ids: z.array(z.string().min(1).max(200)).max(32),
    matched: z.boolean(),
    top_match_score: z.number().min(0).max(1).optional(),
    evidence_confidence: z.number().min(0).max(1),
    failures: z.array(z.string().min(1).max(500)).max(16),
    review_outcomes: z.array(z.string().min(1).max(500)).max(16),
  })
  .strict()
  .superRefine((evaluationCase, context) => {
    const hasReferences = evaluationCase.reference_example_ids.length > 0;
    if (evaluationCase.matched !== hasReferences) {
      context.addIssue({
        code: "custom",
        path: ["matched"],
        message: "Style history evaluation matched must reflect reference_example_ids",
      });
    }
    if (evaluationCase.matched && evaluationCase.top_match_score === undefined) {
      context.addIssue({
        code: "custom",
        path: ["top_match_score"],
        message: "Matched Style history evaluation cases require top_match_score",
      });
    }
    if (!evaluationCase.matched && evaluationCase.top_match_score !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["top_match_score"],
        message: "Unmatched Style history evaluation cases may not report top_match_score",
      });
    }
  });

export const StyleHistoryEvaluationReportSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    evaluation_registry_version: z.literal(STYLE_HISTORY_EVALUATION_REGISTRY_VERSION),
    history_registry_version: z.literal(STYLE_HISTORY_REGISTRY_VERSION),
    evaluation_id: z.string().min(1).max(200),
    dataset_id: z.string().min(1).max(200),
    dataset_revision: z.string().min(1).max(200),
    dataset_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    split_id: z.string().min(1).max(200),
    split_revision: z.string().min(1).max(200),
    split_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    construction_population: z.number().int().nonnegative(),
    population: z.number().int().nonnegative(),
    sample_size: z.number().int().nonnegative(),
    matched_sample_size: z.number().int().nonnegative(),
    evidence_confidence: z.number().min(0).max(1),
    cases: z.array(StyleHistoryEvaluationCaseSchema).max(STYLE_HISTORY_EVALUATION_MAX_CASES),
    failures: z.array(z.string().min(1).max(500)).max(64),
    review_outcomes: z.array(z.string().min(1).max(500)).max(64),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.sample_size !== report.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["sample_size"],
        message: "Style history evaluation sample_size must equal cases length",
      });
    }
    const matchedCount = report.cases.filter((evaluationCase) => evaluationCase.matched).length;
    if (report.matched_sample_size !== matchedCount) {
      context.addIssue({
        code: "custom",
        path: ["matched_sample_size"],
        message: "Style history evaluation matched_sample_size must equal matched cases",
      });
    }
    if (report.sample_size > report.population) {
      context.addIssue({
        code: "custom",
        path: ["sample_size"],
        message: "Style history evaluation sample_size may not exceed population",
      });
    }
    const seen = new Set<string>();
    for (const [index, evaluationCase] of report.cases.entries()) {
      if (seen.has(evaluationCase.held_out_example_id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "held_out_example_id"],
          message: `Style history evaluation example may only appear once: ${evaluationCase.held_out_example_id}`,
        });
      }
      seen.add(evaluationCase.held_out_example_id);
    }
  });

export const StyleHistoryEvaluationGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    snapshot: StyleHistorySnapshotSchema,
    request: StyleHistoryEvaluationRequestSchema,
    expected_report: StyleHistoryEvaluationReportSchema,
  })
  .strict();

const EvaluationResultFieldsSchema = z.object({
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
});

function requireRefinementPlan(
  value: { verdict: "accept" | "refine" | "review"; refinement_plan?: unknown },
  context: z.RefinementCtx,
): void {
  if (value.verdict === "refine" && !value.refinement_plan) {
    context.addIssue({
      code: "custom",
      path: ["refinement_plan"],
      message: "refine verdict requires a refinement_plan",
    });
  }
}

export const EvaluationResultSchema =
  EvaluationResultFieldsSchema.superRefine(requireRefinementPlan);

const EvidenceLinkSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const EvaluationArtifactSchema = EvaluationResultFieldsSchema.extend({
  iteration: z.number().int().positive(),
  operation_id: z.string().min(1),
  evidence: z
    .object({
      render: EvidenceLinkSchema,
      preview: EvidenceLinkSchema,
      backend_render: EvidenceLinkSchema,
      plan: EvidenceLinkSchema,
      readback: EvidenceLinkSchema,
    })
    .strict(),
})
  .strict()
  .superRefine(requireRefinementPlan);

export const PreviewArtifactSchema = z
  .object({
    schema_version: z.literal("0.1.0"),
    artifact_id: z.string().min(1),
    iteration: z.number().int().positive(),
    path: z.string().min(1),
    source_path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mime_type: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    retention: z.literal("session"),
    delivery_export: z.literal(false),
  })
  .strict();

export const PreviewPolicySchema = z
  .object({
    schema_version: z.literal("0.1.0"),
    artifact_kind: z.literal("session_preview_policy"),
    preview: z
      .object({
        storage_root: z.literal("renders"),
        naming: z.literal("renders/iteration-{n}/preview.jpg"),
        format: z.literal("jpeg"),
        max_width: z.literal(2048),
        max_height: z.literal(2048),
        quality: z.literal(85),
        sanitized: z.literal(true),
        retention: z.literal("session"),
        cloud_transfer: z.literal("sanitized_only_with_explicit_opt_in"),
      })
      .strict(),
    final_export: z
      .object({
        capability: z.literal("export_final"),
        availability: z.literal("explicit_only"),
        requires_explicit_destination: z.literal(true),
        requires_delivery_settings: z.literal(true),
        preview_is_not_final: z.literal(true),
      })
      .strict(),
  })
  .strict();

export const FinalExportSettingsSchema = z
  .object({
    format: z.enum(["jpeg", "png", "tiff"]),
    quality: z.number().int().min(1).max(100),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (filename) => filename !== "." && filename !== ".." && !/[\\/]/.test(filename),
        "filename must be a single file name",
      ),
  })
  .strict();

export const IterationReportRecordSchema = z
  .object({
    iteration: z.number().int().positive(),
    operation_id: z.string().min(1),
    state: z.enum(["REFINING", "ACCEPTED", "REVIEW_REQUIRED", "FAILED"]),
    plan: EvidenceLinkSchema,
    checkpoint: EvidenceLinkSchema.optional(),
    readback: EvidenceLinkSchema.optional(),
    backend_render: EvidenceLinkSchema.optional(),
    preview: EvidenceLinkSchema.optional(),
    evaluation: z
      .object({
        path: z.string().min(1),
        verdict: z.enum(["accept", "refine", "review"]),
        confidence: z.number().min(0).max(1),
        rationale: z.string().min(1).max(2000),
        issues: z.array(z.string().min(1).max(500)),
      })
      .strict()
      .optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

export const WorkflowBudgetSchema = z
  .object({
    max_iterations: z.number().int().positive(),
    max_elapsed_ms: z.number().int().nonnegative(),
    max_renders: z.number().int().nonnegative(),
    max_evaluator_calls: z.number().int().nonnegative(),
    max_total_tokens: z.number().int().nonnegative(),
    max_cost_usd: z.number().nonnegative(),
  })
  .strict();

export const IterationReportSchema = z
  .object({
    schema_version: z.literal("0.2.0"),
    evaluator: z.string().nullable(),
    iterations: z.number().int().nonnegative(),
    render_count: z.number().int().nonnegative(),
    evaluator_calls: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    elapsed_ms: z.number().int().nonnegative(),
    budget: WorkflowBudgetSchema,
    terminal_state: z.enum(["REFINING", "ACCEPTED", "REVIEW_REQUIRED", "FAILED", "CANCELLED"]),
    reason: z.string().min(1),
    iteration_records: z.array(IterationReportRecordSchema),
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

const MaskParameterMapSchema = z
  .record(z.string(), z.number().finite())
  .superRefine((settings, context) => {
    for (const [parameter, value] of Object.entries(settings)) {
      const range = MASK_PARAMETER_RANGES[parameter as keyof typeof MASK_PARAMETER_RANGES];
      if (!range) {
        context.addIssue({
          code: "custom",
          path: [parameter],
          message: `Unsupported existing-mask parameter: ${parameter}`,
        });
        continue;
      }
      if (value < range[0] || value > range[1]) {
        context.addIssue({
          code: "custom",
          path: [parameter],
          message: `Existing-mask parameter ${parameter} must be between ${range[0]} and ${range[1]}`,
        });
      }
    }
  });

const ExistingMaskFieldsSchema = z
  .object({
    mask_id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    kind: z.string().min(1).max(100),
    enabled: z.boolean(),
    supported_parameters: z.array(z.enum(MASK_PARAMETER_NAMES)).max(MASK_PARAMETER_NAMES.length),
    parameters: MaskParameterMapSchema,
  })
  .strict();

function validateExistingMaskFields(
  mask: z.infer<typeof ExistingMaskFieldsSchema>,
  context: z.RefinementCtx,
): void {
  if (new Set(mask.supported_parameters).size !== mask.supported_parameters.length) {
    context.addIssue({
      code: "custom",
      path: ["supported_parameters"],
      message: "Existing-mask supported parameters may not contain duplicates",
    });
  }
  for (const parameter of Object.keys(mask.parameters)) {
    if (!mask.supported_parameters.includes(parameter as (typeof MASK_PARAMETER_NAMES)[number])) {
      context.addIssue({
        code: "custom",
        path: ["parameters", parameter],
        message: `Existing-mask parameter is not declared as supported: ${parameter}`,
      });
    }
  }
}

export const ExistingMaskSummarySchema = ExistingMaskFieldsSchema.superRefine(
  validateExistingMaskFields,
);

export const ExistingMaskSnapshotSchema = ExistingMaskFieldsSchema.extend({
  geometry: z.unknown(),
  opaque: z.unknown(),
})
  .strict()
  .superRefine((mask, context) => validateExistingMaskFields(mask, context));

export const MaskSelectorSchema = z.union([
  z
    .object({
      kind: z.literal("id"),
      mask_id: z.string().min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("name"),
      name: z.string().min(1).max(200),
    })
    .strict(),
]);

export const MaskParameterSettingsSchema = MaskParameterMapSchema.superRefine(
  (settings, context) => {
    const count = Object.keys(settings).length;
    if (count === 0) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Existing-mask adjustment requires at least one parameter",
      });
    }
    if (count > MASK_PARAMETER_NAMES.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: `Existing-mask adjustment may contain at most ${MASK_PARAMETER_NAMES.length} parameters`,
      });
    }
  },
);

function validateUniqueMaskIds(
  masks: readonly { mask_id: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, mask] of masks.entries()) {
    if (seen.has(mask.mask_id)) {
      context.addIssue({
        code: "custom",
        path: ["masks", index, "mask_id"],
        message: `Existing-mask readback contains duplicate mask_id: ${mask.mask_id}`,
      });
    }
    seen.add(mask.mask_id);
  }
}

export const MaskReadbackSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    mask_registry_version: z.literal(MASK_REGISTRY_VERSION),
    mask_schema_version: z.string().min(1).max(100),
    target: BackendPhotoIdentitySchema,
    masks: z.array(ExistingMaskSnapshotSchema).max(256),
    global_settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  })
  .strict()
  .superRefine((readback, context) => validateUniqueMaskIds(readback.masks, context));

function validateMaskAdjustmentBoundary(
  value: {
    master: z.infer<typeof BackendPhotoIdentitySchema>;
    target: z.infer<typeof BackendPhotoIdentitySchema>;
    expected_master_uuid: string;
  },
  context: z.RefinementCtx,
): void {
  if (value.master.is_virtual_copy) {
    context.addIssue({
      code: "custom",
      path: ["master", "is_virtual_copy"],
      message: "Existing-mask inspection source must be a Master Photo",
    });
  }
  if (!value.target.is_virtual_copy) {
    context.addIssue({
      code: "custom",
      path: ["target", "is_virtual_copy"],
      message: "Existing-mask mutation target must be a verified Workflow Copy",
    });
  }
  if (value.expected_master_uuid !== value.master.uuid) {
    context.addIssue({
      code: "custom",
      path: ["expected_master_uuid"],
      message: "Existing-mask expected_master_uuid must match the Master identity",
    });
  }
  if (value.target.master_uuid !== value.expected_master_uuid) {
    context.addIssue({
      code: "custom",
      path: ["target", "master_uuid"],
      message: "Existing-mask Workflow Copy does not reference the expected Master UUID",
    });
  }
}

export const MaskAdjustmentIntentSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    operation_id: z.string().min(1).max(200),
    mask_schema_version: z.string().min(1).max(100),
    master: BackendPhotoIdentitySchema,
    target: BackendPhotoIdentitySchema,
    expected_master_uuid: z.string().min(1),
    selector: MaskSelectorSchema,
    settings: MaskParameterSettingsSchema,
  })
  .strict()
  .superRefine(validateMaskAdjustmentBoundary);

export const MaskAdjustmentPlanSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    mask_registry_version: z.literal(MASK_REGISTRY_VERSION),
    operation_id: z.string().min(1).max(200),
    mask_schema_version: z.string().min(1).max(100),
    master: BackendPhotoIdentitySchema,
    target: BackendPhotoIdentitySchema,
    expected_master_uuid: z.string().min(1),
    selector: MaskSelectorSchema,
    settings: MaskParameterSettingsSchema,
    warnings: z.array(z.string().min(1).max(500)).max(16),
    propagation_policy: z
      .object({
        eligible: z.literal(false),
        blocked_reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateMaskAdjustmentBoundary);

export const MaskGoldenVectorSchema = z
  .object({
    id: z.string().min(1),
    control_group: z.string().min(1),
    intent: MaskAdjustmentIntentSchema,
    expected_plan: MaskAdjustmentPlanSchema,
    current_readback: MaskReadbackSchema,
    expected_readback: MaskReadbackSchema,
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
    requested_settings: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
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
    evidence_status: z.enum(["consistent", "contradictory", "insufficient", "readback_failed"]),
    reason: z.string().min(1),
    requested_photo_id: z.string().min(1).optional(),
    target_photo_id: z.string().min(1).optional(),
    workflow_copy_intent: WorkflowCopyIntentSchema.nullable(),
    workflow_copy: WorkflowCopyResultSchema.nullable(),
    workflow_copy_verification: WorkflowCopyVerificationSchema.nullable(),
    checkpoint_artifacts: z.array(z.string().min(1)),
    operation_artifacts: z.array(z.string().min(1)),
    readback_artifacts: z.array(z.string().min(1)),
    operation_evidence_status: z.enum(["none", "consistent", "insufficient", "contradictory"]),
    invalid_artifacts: z.array(z.string().min(1)),
    read_back: BackendPhotoStateSchema.nullable(),
    copy_creation_reconciled: z.boolean(),
    copy_creation_retried: z.literal(false),
    mutation_retried: z.literal(false),
  })
  .strict();

export const OperationSemanticsSchema = z
  .object({
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
    supported_settings: z.array(z.string().min(1)).optional(),
    supported_curve_variants: z.array(z.enum(TONE_CURVE_VARIANTS)).optional(),
    supported_detail_operations: z.array(z.enum(DETAIL_OPERATION_VARIANTS)).optional(),
    supported_lens_controls: z.array(z.enum(OPTICS_LENS_CONTROLS)).optional(),
    supported_profiles: z.array(z.string().min(1)).optional(),
    supported_geometry_variants: z.array(z.enum(OPTICS_GEOMETRY_VARIANTS)).optional(),
    supported_finishing_controls: z.array(z.enum(FINISHING_OPERATION_VARIANTS)).optional(),
    supported_framing_variants: z.array(z.enum(FINISHING_FRAMING_VARIANTS)).optional(),
    supported_color_grading_wheels: z.array(z.enum(COLOR_GRADING_WHEEL_VARIANTS)).optional(),
    supported_color_grading_controls: z.array(z.enum(COLOR_GRADING_SHARED_CONTROLS)).optional(),
    supported_color_grading_process_versions: z.array(z.string().min(1).max(100)).optional(),
    supported_mask_parameters: z.array(z.enum(MASK_PARAMETER_NAMES)).optional(),
    supported_mask_schema_versions: z.array(z.string().min(1).max(100)).optional(),
  })
  .strict();

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

export const CancellationEvidenceSchema = z
  .object({
    requested_at: z.string().datetime(),
    phase: z.enum(["read_only", "mutation"]),
    reason: z.string().min(1),
    side_effect_started: z.boolean(),
    interrupted_state: z.enum([
      "PENDING",
      "ANALYZING",
      "CODEX_INPUT_REQUIRED",
      "PLAN_READY",
      "APPLYING",
      "RENDERING",
      "EVALUATING",
      "REFINING",
      "ACCEPTED",
      "REVIEW_REQUIRED",
      "FAILED",
      "CANCELLED",
    ]),
  })
  .strict();

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
  cancellation: CancellationEvidenceSchema.optional(),
});

export const WorkflowResultSchema = z
  .object({
    sessionDir: z.string().min(1),
    state: z.enum([
      "PENDING",
      "ANALYZING",
      "CODEX_INPUT_REQUIRED",
      "PLAN_READY",
      "APPLYING",
      "RENDERING",
      "EVALUATING",
      "REFINING",
      "ACCEPTED",
      "REVIEW_REQUIRED",
      "FAILED",
      "CANCELLED",
    ]),
    manifest: SessionManifestSchema,
    normalizedPlan: NormalizedEditPlanSchema,
    renderPath: z.string().min(1).optional(),
    handoffPath: z.string().min(1).optional(),
    iterations: z.number().int().nonnegative().optional(),
  })
  .strict();

export const RepresentativeJobSchema = z
  .object({
    schema_version: z.literal("0.3.0"),
    cluster_id: z.string().min(1),
    representative_id: z.string().min(1).nullable(),
    state: z.enum(["ACCEPTED", "REVIEW_REQUIRED", "FAILED", "RUNNING"]),
    workflow_session_root: z.string().min(1).optional(),
    result: WorkflowResultSchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const CullingDecisionSchema = z.object({
  selection_status: z.enum(["select", "keep", "reject", "review"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
  evidence: z
    .object({
      technical: z.array(z.string().min(1).max(500)),
      aesthetic: z.array(z.string().min(1).max(500)),
    })
    .strict()
    .optional(),
});

export const LightingClassificationSchema = z.object({
  lighting_type: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
});

export const ShootIngestionErrorSchema = z
  .object({
    source: z.enum(["raw", "preview", "sidecar"]),
    stage: z.enum(["hash", "metadata"]),
    message: z.string().min(1).max(2000),
  })
  .strict();

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
  raw_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  preview_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  capture_time: z.string().min(1).optional(),
  camera: z.string().min(1).optional(),
  lens: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  source_confidence: z.enum(["high", "ambiguous", "missing_preview"]),
  high_value: z.boolean().default(false),
  ingestion_errors: z.array(ShootIngestionErrorSchema).default([]),
});

export const ShootDecisionSchema = z.object({
  asset_id: z.string().min(1),
  culling: CullingDecisionSchema,
  lighting: LightingClassificationSchema,
  state: z.enum(["completed", "failed"]),
  error: z.string().optional(),
});

export const ShootPlanSchema = z
  .object({
    schema_version: z.literal("0.3.0"),
    session_id: z.string().min(1),
    shoot_root: z.string().min(1),
    created_at: z.string().datetime(),
    mode: z.literal("dry_run"),
    assets: z.array(ShootAssetSchema),
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, asset] of plan.assets.entries()) {
      if (ids.has(asset.id)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "id"],
          message: "Duplicate shoot asset id",
        });
      }
      ids.add(asset.id);
      const normalizedPath = asset.relative_raw_path.replaceAll("\\", "/").toLowerCase();
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "relative_raw_path"],
          message: "Duplicate shoot relative RAW path",
        });
      }
      paths.add(normalizedPath);
    }
  });

export const ShootReviewFileSchema = z
  .object({
    schema_version: z.literal("0.3.0"),
    decisions: z.array(
      z
        .object({
          asset_id: z.string().min(1).optional(),
          relative_raw_path: z.string().min(1).optional(),
          culling: CullingDecisionSchema,
          lighting: LightingClassificationSchema,
        })
        .strict()
        .refine((value) => value.asset_id !== undefined || value.relative_raw_path !== undefined, {
          message: "Each reviewed decision requires asset_id or relative_raw_path",
        }),
    ),
  })
  .strict();

export const ShootManifestSchema = z.object({
  schema_version: z.literal("0.3.0"),
  session_id: z.string().min(1),
  shoot_root: z.string().min(1),
  created_at: z.string().datetime(),
  mode: z.literal("dry_run"),
  assets: z.array(ShootAssetSchema),
  decisions: z.array(ShootDecisionSchema),
  status: z.enum(["RUNNING", "COMPLETED", "CANCELLED"]).default("COMPLETED"),
  status_reason: z.string().min(1).optional(),
  pending_asset_ids: z.array(z.string()).default([]),
  duplicate_groups: z.array(
    z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), asset_ids: z.array(z.string()) }),
  ),
  burst_groups: z.array(
    z.object({
      group_id: z.string().min(1),
      asset_ids: z.array(z.string()).min(2),
      basis: z.literal("filename_sequence"),
      ranked_asset_ids: z.array(z.string()).min(2).optional(),
      ranking_rationale: z.string().min(1).optional(),
    }),
  ),
  near_duplicate_groups: z
    .array(
      z.object({
        group_id: z.string().min(1),
        asset_ids: z.array(z.string()).min(2),
        basis: z.literal("preview_similarity"),
        ranked_asset_ids: z.array(z.string()).min(2),
        ranking_rationale: z.string().min(1),
      }),
    )
    .default([]),
  clusters: z.array(
    z.object({
      cluster_id: z.string().min(1),
      lighting_type: z.string().min(1),
      member_ids: z.array(z.string()),
      representative_id: z.string().nullable(),
      confidence: z.number().min(0).max(1).default(0),
      strategy: z.string().min(1).default("manual_review_required"),
      outlier_ids: z.array(z.string()).default([]),
    }),
  ),
  unclustered_asset_ids: z.array(z.string()).default([]),
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

export const ShootCancellationEvidenceSchema = z
  .object({
    requested_at: z.string().datetime(),
    phase: z.literal("read_only"),
    reason: z.string().min(1),
    pending_asset_ids: z.array(z.string().min(1)),
  })
  .strict();

export const PropagationPlanSchema = z.object({
  schema_version: z.literal("0.3.0"),
  parameter_registry_version: z.string().min(1).optional(),
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
