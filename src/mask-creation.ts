import { z } from "zod";

import {
  CREATE_MASK_OPERATION,
  MASK_CREATION_OPERATIONS,
  requireBackendHandshake,
} from "./backend-handshake.js";
import type {
  BackendAdapter,
  MaskCreationExecutionResult,
  MaskCreationRequest,
  MaskCreationResponse,
} from "./types.js";

export { CREATE_MASK_OPERATION };
export const CREATE_MASK_CONTRACT_META_KEY = "io.github.john-owo.lightroom-mcp/contract-revision";
export const CREATE_MASK_CONTRACT_REVISION = "create-mask.v2";

const OperationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Invalid mask operation ID");

const CatalogIdSchema = z
  .union([z.string().regex(/^[0-9]+$/), z.number().int().nonnegative()])
  .transform((value) => String(value));

const BrushKindParametersSchema = z
  .object({
    coordinate_system: z.literal("normalized_image"),
    coordinate_units: z.literal("unit_interval"),
    path: z
      .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict())
      .min(1)
      .max(4096),
    size: z.number().gt(0).max(1),
    feather: z.number().min(0).max(1),
    flow: z.number().min(0).max(1),
    density: z.number().min(0).max(1),
  })
  .strict();

const AiKindParametersSchema = z.object({}).strict();

const localSettingRanges = {
  exposure: z.number().min(-5).max(5),
  contrast: z.number().min(-100).max(100),
  highlights: z.number().min(-100).max(100),
  shadows: z.number().min(-100).max(100),
  whites: z.number().min(-100).max(100),
  blacks: z.number().min(-100).max(100),
  temperature: z.number().min(-100).max(100),
  tint: z.number().min(-100).max(100),
  texture: z.number().min(-100).max(100),
  clarity: z.number().min(-100).max(100),
  dehaze: z.number().min(-100).max(100),
  saturation: z.number().min(-100).max(100),
  sharpness: z.number().min(-100).max(100),
  luminance_noise: z.number().min(-100).max(100),
  moire: z.number().min(-100).max(100),
  defringe: z.number().min(-100).max(100),
  hue: z.number().min(-100).max(100),
} as const;

const LocalSettingsSchema = z
  .object(localSettingRanges)
  .partial()
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, "At least one local setting is required");

const requestBase = {
  photo_id: CatalogIdSchema,
  expected_photo_uuid: z.string().min(1),
  expected_master_uuid: z.string().min(1),
  operation_id: OperationIdSchema,
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((name) => /\S/.test(name), "Mask name is blank"),
  local_settings: LocalSettingsSchema,
};

export const MaskCreationRequestSchema = z.discriminatedUnion("mask_kind", [
  z
    .object({
      ...requestBase,
      mask_kind: z.literal("brush"),
      kind_parameters: BrushKindParametersSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      mask_kind: z.literal("subject"),
      kind_parameters: AiKindParametersSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      mask_kind: z.literal("sky"),
      kind_parameters: AiKindParametersSchema,
    })
    .strict(),
]);

const capabilityKindSchema = z
  .object({
    supported: z.boolean(),
    accepted_parameters: z.array(z.string()),
    readback_guarantees: z.array(z.string()),
    reason: z.string().optional(),
  })
  .strict();

const CapabilitySchema = z
  .object({
    lightroom_version: z.string().min(1),
    process_version: z.string().min(1),
    mask_schema: z.string().min(1),
    kinds: z
      .object({
        brush: capabilityKindSchema,
        subject: capabilityKindSchema,
        sky: capabilityKindSchema,
      })
      .strict(),
  })
  .strict();

const SelectionRestorationSchema = z
  .object({
    status: z.enum(["restored", "not_needed", "not_attempted", "failed"]),
    verified: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();

const CopyIdentitySchema = z
  .object({
    catalog_id: CatalogIdSchema,
    uuid: z.string().min(1),
    path: z.string().optional(),
    filename: z.string().optional(),
    copy_name: z.string().optional(),
    is_virtual_copy: z.literal(true),
  })
  .strict();

const MasterIdentitySchema = CopyIdentitySchema.extend({ is_virtual_copy: z.literal(false) });

const CheckpointSchema = z
  .object({
    name: z.string().min(1),
    uuid: z.string().min(1),
    scope: z.literal("plugin"),
    recovery_evidence: z.literal(true),
    true_undo: z.literal(false),
  })
  .strict();

const PreservationSchema = z
  .object({
    exactly_one_mask_added: z.literal(true),
    existing_mask_tree_unchanged: z.literal(true),
    global_develop_unchanged: z.literal(true),
    source_untouched: z.literal(true),
    sidecar_untouched: z.literal(true),
  })
  .strict();

const ValidationFailureSchema = z
  .object({
    raw_response_json: z.string().max(16_384),
    raw_response_truncated: z.boolean(),
    raw_response_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    validator_summary: z.string().min(1).max(2_048),
  })
  .strict();

const BrushGeometrySchema = z
  .object({
    coordinate_system: z.literal("normalized_image"),
    coordinate_units: z.literal("unit_interval"),
    point_count: z.number().int().min(1),
    bounds: z
      .object({
        x_min: z.number().min(0).max(1),
        x_max: z.number().min(0).max(1),
        y_min: z.number().min(0).max(1),
        y_max: z.number().min(0).max(1),
      })
      .strict()
      .refine(
        (bounds) => bounds.x_min <= bounds.x_max && bounds.y_min <= bounds.y_max,
        "Invalid Brush geometry bounds",
      ),
  })
  .strict();

const AiGeometrySchema = z
  .object({
    coordinate_system: z.literal("lightroom_ai"),
    coordinate_units: z.literal("opaque"),
    ai_payload_present: z.literal(true),
    ai_payload_field_count: z.number().int().min(1),
    ai_mask_type: z.literal("Mask/Image"),
    ai_mask_subtype: z.literal(1),
    ai_error_state: z.enum(["absent", "zero"]),
    error_reason: z.literal(0).optional(),
  })
  .strict();

const responseEnvelope = {
  operation_id: OperationIdSchema,
  capability: CapabilitySchema,
  selection_restoration: SelectionRestorationSchema,
};

const successResponseFields = {
  ...responseEnvelope,
  photo: CopyIdentitySchema,
  master: MasterIdentitySchema,
  mask_id: z.string().min(1),
  correction_id: z.string().min(1),
  name: z.string().min(1),
  initial_local_settings: LocalSettingsSchema,
  lightroom_version: z.string().min(1),
  process_version: z.string().min(1),
  mask_schema: z.string().min(1),
  checkpoint: CheckpointSchema,
  preservation: PreservationSchema,
};

const reviewEvidenceFields = {
  photo: CopyIdentitySchema.optional(),
  master: MasterIdentitySchema.optional(),
  mask_id: z.string().min(1).optional(),
  correction_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  mask_kind: z.enum(["brush", "subject"]).optional(),
  kind_parameters: z.union([BrushKindParametersSchema, AiKindParametersSchema]).optional(),
  initial_local_settings: LocalSettingsSchema.optional(),
  lightroom_version: z.string().min(1).optional(),
  process_version: z.string().min(1).optional(),
  mask_schema: z.string().min(1).optional(),
  geometry: z.union([BrushGeometrySchema, AiGeometrySchema]).optional(),
  checkpoint: CheckpointSchema.optional(),
  preservation: PreservationSchema.optional(),
  validation_failure: ValidationFailureSchema.optional(),
};

export const MaskCreationResponseSchema = z.union([
  z
    .object({
      ...successResponseFields,
      result: z.enum(["created", "reconciled"]),
      mask_kind: z.literal("brush"),
      kind_parameters: BrushKindParametersSchema,
      geometry: BrushGeometrySchema,
    })
    .strict(),
  z
    .object({
      ...successResponseFields,
      result: z.enum(["created", "reconciled"]),
      mask_kind: z.literal("subject"),
      kind_parameters: AiKindParametersSchema,
      geometry: AiGeometrySchema,
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      result: z.literal("unsupported"),
      reason: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...responseEnvelope,
      ...reviewEvidenceFields,
      result: z.literal("REVIEW_REQUIRED"),
      reason: z.string().min(1),
    })
    .strict(),
]);

export function validateMaskCreationRequest(value: unknown): MaskCreationRequest {
  return MaskCreationRequestSchema.parse(value) as MaskCreationRequest;
}

export class MaskCreationResponseValidationError extends Error {
  constructor(
    message: string,
    readonly rawResponse: unknown,
  ) {
    super(message);
    this.name = "MaskCreationResponseValidationError";
  }
}

export function validateMaskCreationResponse(value: unknown): MaskCreationResponse {
  const parsed = MaskCreationResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new MaskCreationResponseValidationError(parsed.error.message, value);
  }
  return parsed.data as MaskCreationResponse;
}

function reviewRequired(
  operationId: string,
  reason: string,
  response?: MaskCreationResponse,
  evidenceStatus?: MaskCreationExecutionResult["evidence_status"],
  rawResponse?: unknown,
): MaskCreationExecutionResult {
  return {
    operation_id: operationId,
    outcome: "REVIEW_REQUIRED",
    retry_allowed: false,
    reason,
    ...(response ? { response } : {}),
    ...(evidenceStatus ? { evidence_status: evidenceStatus } : {}),
    ...(rawResponse !== undefined ? { raw_response: rawResponse } : {}),
  };
}

function sameNumericRecord(
  actual: Record<string, number> | undefined,
  expected: Record<string, number>,
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index] && Object.is(actual[key], expected[key]),
    )
  );
}

function brushParametersMatchRequest(
  actual: MaskCreationResponse["kind_parameters"],
  request: Extract<MaskCreationRequest, { mask_kind: "brush" }>,
): boolean {
  if (!actual || !("path" in actual) || !Array.isArray(actual.path)) return false;
  return (
    actual.coordinate_system === request.kind_parameters.coordinate_system &&
    actual.coordinate_units === request.kind_parameters.coordinate_units &&
    Object.is(actual.size, request.kind_parameters.size) &&
    Object.is(actual.feather, request.kind_parameters.feather) &&
    Object.is(actual.flow, request.kind_parameters.flow) &&
    Object.is(actual.density, request.kind_parameters.density) &&
    actual.path.length === request.kind_parameters.path.length &&
    actual.path.every(
      (point, index) =>
        Object.is(point.x, request.kind_parameters.path[index]?.x) &&
        Object.is(point.y, request.kind_parameters.path[index]?.y),
    )
  );
}

function brushGeometryMatchesRequest(
  geometry: MaskCreationResponse["geometry"],
  request: Extract<MaskCreationRequest, { mask_kind: "brush" }>,
): boolean {
  if (!geometry || geometry.coordinate_system !== "normalized_image") return false;
  const bounds = geometry.bounds as Record<string, unknown> | undefined;
  const xValues = request.kind_parameters.path.map((point) => point.x);
  const yValues = request.kind_parameters.path.map((point) => point.y);
  return (
    geometry.point_count === request.kind_parameters.path.length &&
    Object.is(bounds?.x_min, Math.min(...xValues)) &&
    Object.is(bounds?.x_max, Math.max(...xValues)) &&
    Object.is(bounds?.y_min, Math.min(...yValues)) &&
    Object.is(bounds?.y_max, Math.max(...yValues))
  );
}

function successResponseMatchesRequest(
  response: MaskCreationResponse,
  request: MaskCreationRequest,
): boolean {
  if (
    response.name !== request.name ||
    response.mask_kind !== request.mask_kind ||
    response.lightroom_version !== response.capability.lightroom_version ||
    response.process_version !== response.capability.process_version ||
    response.mask_schema !== response.capability.mask_schema ||
    response.capability.kinds[request.mask_kind].supported !== true ||
    !sameNumericRecord(response.initial_local_settings, request.local_settings)
  ) {
    return false;
  }

  if (request.mask_kind !== "brush") {
    return (
      response.kind_parameters !== undefined &&
      Object.keys(response.kind_parameters).length === 0 &&
      response.geometry?.coordinate_system === "lightroom_ai"
    );
  }
  return (
    brushParametersMatchRequest(response.kind_parameters, request) &&
    brushGeometryMatchesRequest(response.geometry, request)
  );
}

function reviewEvidenceMatchesRequest(
  response: MaskCreationResponse,
  request: MaskCreationRequest,
  before: Awaited<ReturnType<BackendAdapter["readCurrentEdit"]>>,
): boolean {
  if (
    (response.photo !== undefined &&
      (response.photo.catalog_id !== request.photo_id ||
        response.photo.uuid !== request.expected_photo_uuid ||
        response.photo.is_virtual_copy !== true)) ||
    (response.master !== undefined &&
      (response.master.catalog_id !== before.identity?.master_id ||
        response.master.uuid !== request.expected_master_uuid ||
        response.master.is_virtual_copy !== false)) ||
    (response.name !== undefined && response.name !== request.name) ||
    (response.mask_kind !== undefined && response.mask_kind !== request.mask_kind) ||
    (response.initial_local_settings !== undefined &&
      !sameNumericRecord(response.initial_local_settings, request.local_settings)) ||
    (response.lightroom_version !== undefined &&
      response.lightroom_version !== response.capability.lightroom_version) ||
    (response.process_version !== undefined &&
      response.process_version !== response.capability.process_version) ||
    (response.mask_schema !== undefined && response.mask_schema !== response.capability.mask_schema)
  ) {
    return false;
  }
  if (response.kind_parameters !== undefined) {
    if (request.mask_kind === "brush") {
      if (!brushParametersMatchRequest(response.kind_parameters, request)) return false;
    } else if (Object.keys(response.kind_parameters).length !== 0) {
      return false;
    }
  }
  if (response.geometry !== undefined) {
    if (request.mask_kind === "brush") {
      if (!brushGeometryMatchesRequest(response.geometry, request)) return false;
    } else if (
      request.mask_kind === "sky" ||
      response.geometry.coordinate_system !== "lightroom_ai"
    ) {
      return false;
    }
  }
  return true;
}

function hasMinimumReviewEvidence(response: MaskCreationResponse): boolean {
  return Boolean(response.photo && response.master && response.checkpoint);
}

function verifiedWorkflowCopy(
  backendState: Awaited<ReturnType<BackendAdapter["readCurrentEdit"]>>,
  request: MaskCreationRequest,
): boolean {
  const identity = backendState.identity;
  return (
    backendState.photo_id === request.photo_id &&
    identity?.catalog_id === request.photo_id &&
    identity.uuid === request.expected_photo_uuid &&
    identity.master_uuid === request.expected_master_uuid &&
    identity.is_virtual_copy === true
  );
}

/**
 * Execute one create_mask call against a pre-existing, identity-verified
 * Workflow Copy. Any uncertain mutation result is terminal for this invocation:
 * the function never issues a second create_mask call.
 */
export async function executeMaskCreation(
  backend: BackendAdapter,
  input: unknown,
): Promise<MaskCreationExecutionResult> {
  const request = validateMaskCreationRequest(input);
  let connected = false;
  try {
    await backend.connect();
    connected = true;
    await requireBackendHandshake(backend, MASK_CREATION_OPERATIONS);
    const before = await backend.readCurrentEdit(request.photo_id);
    if (!verifiedWorkflowCopy(before, request)) {
      return reviewRequired(
        request.operation_id,
        "Mask creation target is not the expected identity-verified Workflow Copy",
      );
    }

    let response: MaskCreationResponse;
    try {
      response = validateMaskCreationResponse(await backend.createMask(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MaskCreationResponseValidationError) {
        return reviewRequired(
          request.operation_id,
          `Mask creation returned malformed evidence; reconcile by operation ID before any retry: ${message}`,
          undefined,
          "unparsed",
          error.rawResponse,
        );
      }
      return reviewRequired(
        request.operation_id,
        `Mask creation outcome is uncertain; reconcile by operation ID before any retry: ${message}`,
      );
    }

    if (response.operation_id !== request.operation_id) {
      return reviewRequired(
        request.operation_id,
        "Mask response operation ID mismatch",
        response,
        "contradictory",
      );
    }
    if (response.result === "unsupported") {
      return {
        operation_id: request.operation_id,
        outcome: "UNSUPPORTED",
        retry_allowed: false,
        response,
        reason: response.reason ?? "Mask kind is unsupported by the Lightroom runtime",
      };
    }
    if (response.result === "REVIEW_REQUIRED") {
      if (response.validation_failure) {
        let rawResponse: unknown = {
          raw_response_json: response.validation_failure.raw_response_json,
          raw_response_truncated: response.validation_failure.raw_response_truncated,
          raw_response_sha256: response.validation_failure.raw_response_sha256,
        };
        if (!response.validation_failure.raw_response_truncated) {
          try {
            rawResponse = JSON.parse(response.validation_failure.raw_response_json);
          } catch {
            // Preserve the exact serialized evidence when it is not valid JSON.
          }
        }
        return reviewRequired(
          request.operation_id,
          `${response.reason}; reconcile by operation ID before any retry`,
          response,
          "unparsed",
          rawResponse,
        );
      }
      const evidenceMatches = reviewEvidenceMatchesRequest(response, request, before);
      const evidenceStatus = evidenceMatches
        ? hasMinimumReviewEvidence(response)
          ? "validated"
          : "insufficient"
        : "contradictory";
      return {
        operation_id: request.operation_id,
        outcome: "REVIEW_REQUIRED",
        retry_allowed: false,
        response,
        evidence_status: evidenceStatus,
        reason: evidenceMatches
          ? evidenceStatus === "validated"
            ? (response.reason ?? "Lightroom requested manual mask review")
            : `${response.reason ?? "Lightroom requested manual mask review"}; recovery evidence is insufficient`
          : `${response.reason ?? "Lightroom requested manual mask review"}; contradictory mask evidence`,
      };
    }
    if (
      response.photo?.catalog_id !== request.photo_id ||
      response.photo.uuid !== request.expected_photo_uuid ||
      response.photo.is_virtual_copy !== true ||
      response.master?.catalog_id !== before.identity?.master_id ||
      response.master?.uuid !== request.expected_master_uuid ||
      response.master.is_virtual_copy !== false ||
      response.selection_restoration.verified !== true ||
      !["restored", "not_needed"].includes(response.selection_restoration.status)
    ) {
      return reviewRequired(
        request.operation_id,
        "Mask response Workflow Copy identity mismatch",
        response,
        "contradictory",
      );
    }
    if (!successResponseMatchesRequest(response, request)) {
      return reviewRequired(
        request.operation_id,
        "Mask response does not match the requested mask payload",
        response,
        "contradictory",
      );
    }
    return {
      operation_id: request.operation_id,
      outcome: response.result === "created" ? "CREATED" : "RECONCILED",
      retry_allowed: false,
      response,
      evidence_status: "validated",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reviewRequired(request.operation_id, message);
  } finally {
    if (connected) {
      try {
        await backend.close();
      } catch {
        // The mask outcome remains authoritative; lease cleanup is caller-observable elsewhere.
      }
    }
  }
}
