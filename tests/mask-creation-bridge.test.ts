import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import {
  LIGHTROOM_MCP_SERVER_NAME,
  MOCK_CAPABILITIES,
  OPERATION_SEMANTICS_META_KEY,
  LightroomMcpAdapter,
  MockBackend,
} from "../src/backends.js";
import {
  CREATE_MASK_CONTRACT_META_KEY,
  CREATE_MASK_CONTRACT_REVISION,
  executeMaskCreation,
  validateMaskCreationRequest,
  validateMaskCreationResponse,
} from "../src/mask-creation.js";
import { BackendCapabilityManifestSchema } from "../src/schemas.js";
import type { BackendCapabilityManifest, MaskCreationRequest } from "../src/types.js";

const brushRequest: MaskCreationRequest = {
  photo_id: "101",
  expected_photo_uuid: "uuid-copy",
  expected_master_uuid: "uuid-master",
  operation_id: "photoagent-mask-001",
  mask_kind: "brush",
  name: "PhotoAgent Brush",
  kind_parameters: {
    coordinate_system: "normalized_image",
    coordinate_units: "unit_interval",
    path: [
      { x: 0.25, y: 0.4 },
      { x: 0.5, y: 0.6 },
    ],
    size: 0.1,
    feather: 0.7,
    flow: 0.8,
    density: 1,
  },
  local_settings: { exposure: 0.35, temperature: 8 },
};

const mutatingMaskSemantics = {
  supported: true,
  side_effect: "mutating" as const,
  idempotent: false,
  reversible: "checkpoint_only" as const,
  scope: "photo" as const,
  requires_active_selection: true,
  requires_editor_foreground: true,
  concurrency: "exclusive_backend" as const,
  retry_policy: "readback_before_retry" as const,
  safe_to_resume: false,
};

const readSemantics = {
  supported: true,
  side_effect: "read_only" as const,
  idempotent: true,
  reversible: "true_undo" as const,
  scope: "photo" as const,
  requires_active_selection: false,
  requires_editor_foreground: false,
  concurrency: "parallel_safe" as const,
  retry_policy: "automatic" as const,
  safe_to_resume: true,
};

function listedTool(
  name: string,
  semantics: BackendCapabilityManifest["operations"][string] = readSemantics,
  options: { contractRevision?: unknown; omitContractRevision?: boolean } = {},
) {
  const contractRevision = options.omitContractRevision
    ? undefined
    : (options.contractRevision ??
      (name === "create_mask" ? CREATE_MASK_CONTRACT_REVISION : undefined));
  return {
    name,
    description: `fixture ${name}`,
    inputSchema: { type: "object", properties: {} },
    _meta: {
      [OPERATION_SEMANTICS_META_KEY]: semantics,
      ...(contractRevision !== undefined
        ? { [CREATE_MASK_CONTRACT_META_KEY]: contractRevision }
        : {}),
    },
  };
}

function successfulResponse(request: MaskCreationRequest) {
  if (request.mask_kind !== "brush") throw new Error("Fixture only supports brush");
  return {
    operation_id: request.operation_id,
    result: "created",
    capability: {
      lightroom_version: "15.0",
      process_version: "15.0",
      mask_schema: "MaskGroupBasedCorrections-v1",
      kinds: {
        brush: {
          supported: true,
          accepted_parameters: ["exposure", "temperature"],
          readback_guarantees: ["global_develop_unchanged"],
        },
        subject: {
          supported: true,
          accepted_parameters: ["exposure", "temperature"],
          readback_guarantees: ["global_develop_unchanged"],
        },
        sky: {
          supported: false,
          accepted_parameters: [],
          readback_guarantees: [],
          reason: "Runtime unsupported",
        },
      },
    },
    selection_restoration: { status: "restored", verified: true },
    photo: {
      catalog_id: request.photo_id,
      uuid: request.expected_photo_uuid,
      is_virtual_copy: true,
    },
    master: { catalog_id: "100", uuid: request.expected_master_uuid, is_virtual_copy: false },
    mask_id: "mask-001",
    correction_id: "correction-001",
    name: request.name,
    mask_kind: "brush",
    kind_parameters: request.kind_parameters,
    initial_local_settings: request.local_settings,
    lightroom_version: "15.0",
    process_version: "15.0",
    mask_schema: "MaskGroupBasedCorrections-v1",
    geometry: {
      coordinate_system: "normalized_image",
      coordinate_units: "unit_interval",
      point_count: 2,
      bounds: { x_min: 0.25, x_max: 0.5, y_min: 0.4, y_max: 0.6 },
    },
    checkpoint: {
      name: "PhotoAgent mask checkpoint",
      uuid: "checkpoint-001",
      scope: "plugin",
      recovery_evidence: true,
      true_undo: false,
    },
    preservation: {
      exactly_one_mask_added: true,
      existing_mask_tree_unchanged: true,
      global_develop_unchanged: true,
      source_untouched: true,
      sidecar_untouched: true,
    },
  };
}

async function fixtureRaw(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-mask-bridge-"));
  const raw = join(root, "sample.NEF");
  await writeFile(raw, "fixture", "utf8");
  return raw;
}

async function seededMock(
  options: Record<string, unknown> = {},
): Promise<{ backend: MockBackend; request: MaskCreationRequest }> {
  const backend = new MockBackend(await fixtureRaw(), { mockCopyCatalogId: "101", ...options });
  await backend.connect();
  await backend.handshake();
  const master = await backend.readCurrentEdit("100");
  const copy = await backend.createWorkflowCopy(
    "100",
    master.identity!.uuid,
    "photoagent-copy-for-mask-001",
  );
  await backend.close();
  if (!copy.copy) throw new Error("Mock failed to seed Workflow Copy");
  return {
    backend,
    request: {
      ...brushRequest,
      photo_id: copy.copy.catalog_id,
      expected_photo_uuid: copy.copy.uuid,
      expected_master_uuid: copy.copy.master_uuid,
    },
  };
}

describe("PhotoAgent create_mask execution bridge", () => {
  it("executes one validated mask request on an identity-verified Workflow Copy", async () => {
    const { backend, request } = await seededMock();
    const callStart = backend.calls.length;

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      operation_id: request.operation_id,
      outcome: "CREATED",
      retry_allowed: false,
    });
    expect(result.response).toMatchObject({
      result: "created",
      photo: { catalog_id: request.photo_id, uuid: request.expected_photo_uuid },
      master: { uuid: request.expected_master_uuid },
      initial_local_settings: request.local_settings,
    });
    expect(backend.calls.slice(callStart)).toEqual([
      "connect",
      "handshake",
      "read_current_edit",
      "create_mask",
      "close",
    ]);
  });

  it("refuses an unadvertised create_mask capability before catalog read or mutation", async () => {
    const operations = { ...MOCK_CAPABILITIES.operations };
    delete operations.create_mask;
    const manifest = BackendCapabilityManifestSchema.parse({
      ...MOCK_CAPABILITIES,
      capabilities: MOCK_CAPABILITIES.capabilities.filter(
        (capability) => capability !== "create_mask",
      ),
      operations,
    });
    const backend = new MockBackend(await fixtureRaw(), { manifest });

    const result = await executeMaskCreation(backend, brushRequest);

    expect(result).toMatchObject({ outcome: "REVIEW_REQUIRED", retry_allowed: false });
    expect(result.reason).toMatch(/unsupported operation: create_mask/i);
    expect(backend.calls).toEqual(["connect", "handshake", "close"]);
  });

  it("does not blindly retry create_mask after a timeout-like transport failure", async () => {
    const { backend, request } = await seededMock({ maskError: "Plugin response timeout" });
    const callStart = backend.calls.length;

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({ outcome: "REVIEW_REQUIRED", retry_allowed: false });
    expect(result.reason).toMatch(/reconcile by operation ID.*timeout/i);
    expect(backend.calls.slice(callStart).filter((call) => call === "create_mask")).toHaveLength(1);
  });

  it("preserves a backend REVIEW_REQUIRED result without retrying", async () => {
    const { backend, request } = await seededMock({ maskResult: "REVIEW_REQUIRED" });
    const callStart = backend.calls.length;

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      response: { result: "REVIEW_REQUIRED" },
      evidence_status: "insufficient",
    });
    expect(result.reason).toMatch(/recovery evidence is insufficient/i);
    expect(backend.calls.slice(callStart).filter((call) => call === "create_mask")).toHaveLength(1);
  });

  it("preserves optional reconciliation evidence from a REVIEW_REQUIRED response", async () => {
    const { backend, request } = await seededMock();
    const originalCreateMask = backend.createMask.bind(backend);
    backend.createMask = async (input) => {
      const created = await originalCreateMask(input);
      return {
        ...created,
        result: "REVIEW_REQUIRED",
        reason: "Selection restoration needs review",
      };
    };

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "validated",
      response: {
        result: "REVIEW_REQUIRED",
        photo: { catalog_id: request.photo_id },
        checkpoint: { recovery_evidence: true, true_undo: false },
        preservation: { global_develop_unchanged: true },
      },
    });
  });

  it("fails closed when a valid success response does not match the requested mask payload", async () => {
    const { backend, request } = await seededMock();
    const originalCreateMask = backend.createMask.bind(backend);
    backend.createMask = async (input) => {
      const created = await originalCreateMask(input);
      return validateMaskCreationResponse({
        ...created,
        name: "Different mask",
        initial_local_settings: { exposure: 0.1 },
      });
    };

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "contradictory",
      response: {
        result: "created",
        name: "Different mask",
        initial_local_settings: { exposure: 0.1 },
      },
    });
    expect(result.reason).toMatch(/does not match the requested mask payload/i);
  });

  it("fails closed when a valid success response changes the requested mask kind", async () => {
    const { backend, request } = await seededMock();
    const originalCreateMask = backend.createMask.bind(backend);
    backend.createMask = async (input) => {
      const created = await originalCreateMask(input);
      return validateMaskCreationResponse({
        ...created,
        mask_kind: "subject",
        kind_parameters: {},
        geometry: {
          coordinate_system: "lightroom_ai",
          coordinate_units: "opaque",
          ai_payload_present: true,
          ai_payload_field_count: 1,
          ai_mask_type: "Mask/Image",
          ai_mask_subtype: 1,
          ai_error_state: "absent",
        },
      });
    };

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "contradictory",
      response: { result: "created", mask_kind: "subject" },
    });
    expect(result.reason).toMatch(/does not match the requested mask payload/i);
  });

  it("fails closed when Brush readback geometry contradicts the requested path", async () => {
    const { backend, request } = await seededMock();
    const originalCreateMask = backend.createMask.bind(backend);
    backend.createMask = async (input) => {
      const created = await originalCreateMask(input);
      return validateMaskCreationResponse({
        ...created,
        geometry: {
          coordinate_system: "normalized_image",
          coordinate_units: "unit_interval",
          point_count: 1,
          bounds: { x_min: 0.25, x_max: 0.5, y_min: 0.4, y_max: 0.6 },
        },
      });
    };

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "contradictory",
      response: { geometry: { point_count: 1 } },
    });
    expect(result.reason).toMatch(/does not match the requested mask payload/i);
  });

  it("marks conflicting REVIEW_REQUIRED identity evidence as contradictory", async () => {
    const { backend, request } = await seededMock();
    const originalCreateMask = backend.createMask.bind(backend);
    backend.createMask = async (input) => {
      const created = await originalCreateMask(input);
      return validateMaskCreationResponse({
        ...created,
        result: "REVIEW_REQUIRED",
        reason: "Selection restoration needs review",
        photo: { ...created.photo, uuid: "different-copy-uuid" },
      });
    };

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "contradictory",
      response: { photo: { uuid: "different-copy-uuid" } },
    });
    expect(result.reason).toMatch(/contradictory mask evidence/i);
  });

  it("retains a malformed post-mutation payload for operation-ID reconciliation", async () => {
    const { backend, request } = await seededMock();
    const malformed = { operation_id: request.operation_id, result: "created", mask_id: "mask-1" };
    backend.createMask = async () => validateMaskCreationResponse(malformed);

    const result = await executeMaskCreation(backend, request);

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      retry_allowed: false,
      evidence_status: "unparsed",
      raw_response: malformed,
    });
    expect(result.reason).toMatch(/malformed evidence.*reconcile by operation ID/i);
  });

  it("rejects a non-numeric Lightroom catalog ID before backend access", async () => {
    const backend = new MockBackend(await fixtureRaw());

    expect(() =>
      validateMaskCreationRequest({ ...brushRequest, photo_id: "not-a-catalog-id" }),
    ).toThrow(/invalid string/i);
    expect(backend.calls).toEqual([]);
  });

  it("refuses a Master or mismatched Copy identity before create_mask", async () => {
    const backend = new MockBackend(await fixtureRaw());

    const result = await executeMaskCreation(backend, {
      ...brushRequest,
      photo_id: "100",
      expected_photo_uuid: "mock-master-uuid",
      expected_master_uuid: "mock-master-uuid",
    });

    expect(result).toMatchObject({ outcome: "REVIEW_REQUIRED", retry_allowed: false });
    expect(result.reason).toMatch(/identity-verified Workflow Copy/i);
    expect(backend.calls).not.toContain("create_mask");
  });

  it("maps the exact request and validates the structured Lightroom MCP response", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const seenArguments: unknown[] = [];
    const server = new Server(
      { name: LIGHTROOM_MCP_SERVER_NAME, version: "0.12.0" },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        listedTool("get_selected_photos"),
        listedTool("get_photo_metadata"),
        listedTool("create_mask", mutatingMaskSemantics),
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "get_selected_photos") {
        return { content: [{ type: "text", text: JSON.stringify({ photos: [] }) }] };
      }
      if (request.params.name === "get_photo_metadata") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                catalog_id: "101",
                uuid: "uuid-copy",
                master_id: "100",
                master_uuid: "uuid-master",
                is_virtual_copy: true,
                path: "D:/fixture/sample.NEF",
                developSettings: { Exposure2012: 0 },
              }),
            },
          ],
        };
      }
      if (request.params.name === "create_mask") {
        seenArguments.push(request.params.arguments);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(successfulResponse(brushRequest)),
            },
          ],
        };
      }
      throw new Error(`Unexpected tool: ${request.params.name}`);
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "photo-agent-test", version: "1.0.0" });
    const backend = new LightroomMcpAdapter("unused-entry.js", {
      client,
      transport: clientTransport,
    });

    try {
      const result = await executeMaskCreation(backend, brushRequest);

      expect(result).toMatchObject({ outcome: "CREATED", retry_allowed: false });
      expect(seenArguments).toEqual([brushRequest]);
      expect(result.response?.preservation).toEqual({
        exactly_one_mask_added: true,
        existing_mask_tree_unchanged: true,
        global_develop_unchanged: true,
        source_untouched: true,
        sidecar_untouched: true,
      });
    } finally {
      await server.close();
    }
  });

  it("retains malformed post-operation evidence across the actual MCP adapter transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const malformed = {
      operation_id: brushRequest.operation_id,
      result: "created",
      mask_id: 42,
    };
    let maskCallCount = 0;
    const server = new Server(
      { name: LIGHTROOM_MCP_SERVER_NAME, version: "0.12.0" },
      { capabilities: { tools: { listChanged: false } } },
    );
    const recoveryOutputSchema = {
      type: "object" as const,
      additionalProperties: true,
      properties: {
        operation_id: { type: "string" as const },
        result: { enum: ["REVIEW_REQUIRED"] },
        validation_failure: {
          type: "object" as const,
          properties: { raw_response_json: { type: "string" as const } },
          required: ["raw_response_json"],
        },
      },
      required: ["operation_id", "result", "validation_failure"],
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        listedTool("get_selected_photos"),
        listedTool("get_photo_metadata"),
        { ...listedTool("create_mask", mutatingMaskSemantics), outputSchema: recoveryOutputSchema },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "get_selected_photos") {
        return { content: [{ type: "text", text: JSON.stringify({ photos: [] }) }] };
      }
      if (request.params.name === "get_photo_metadata") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                catalog_id: "101",
                uuid: "uuid-copy",
                master_id: "100",
                master_uuid: "uuid-master",
                is_virtual_copy: true,
                path: "D:/fixture/sample.NEF",
                developSettings: { Exposure2012: 0 },
              }),
            },
          ],
        };
      }
      if (request.params.name === "create_mask") {
        maskCallCount += 1;
        const recovery = {
          operation_id: brushRequest.operation_id,
          result: "REVIEW_REQUIRED",
          capability: {
            lightroom_version: "unverified",
            process_version: "unverified",
            mask_schema: "unverified",
            kinds: {
              brush: {
                supported: false,
                accepted_parameters: [],
                readback_guarantees: [],
                reason: "Plugin result failed contract validation",
              },
              subject: {
                supported: false,
                accepted_parameters: [],
                readback_guarantees: [],
                reason: "Plugin result failed contract validation",
              },
              sky: {
                supported: false,
                accepted_parameters: [],
                readback_guarantees: [],
                reason: "Plugin result failed contract validation",
              },
            },
          },
          selection_restoration: { status: "not_attempted", verified: false },
          reason: "Plugin returned malformed post-operation evidence",
          validation_failure: {
            raw_response_json: JSON.stringify(malformed),
            raw_response_truncated: false,
            raw_response_sha256: "a".repeat(64),
            validator_summary: "fixture output mismatch",
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(recovery) }],
          structuredContent: recovery,
        };
      }
      throw new Error(`Unexpected tool: ${request.params.name}`);
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "photo-agent-test", version: "1.0.0" });
    const backend = new LightroomMcpAdapter("unused-entry.js", {
      client,
      transport: clientTransport,
    });

    try {
      const result = await executeMaskCreation(backend, brushRequest);

      expect(result).toMatchObject({
        outcome: "REVIEW_REQUIRED",
        retry_allowed: false,
        evidence_status: "unparsed",
        raw_response: malformed,
      });
      expect(result.reason).toMatch(
        /malformed post-operation evidence.*reconcile by operation ID/i,
      );
      expect(maskCallCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      "missing contract revision",
      listedTool("create_mask", mutatingMaskSemantics, { omitContractRevision: true }),
    ],
    [
      "wrong contract revision",
      listedTool("create_mask", mutatingMaskSemantics, { contractRevision: "create-mask.v0" }),
    ],
    [
      "unsafe operation semantics",
      listedTool("create_mask", { ...mutatingMaskSemantics, safe_to_resume: true }),
    ],
  ])("refuses %s before any catalog or mutation tool call", async (_label, maskTool) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let callCount = 0;
    const server = new Server(
      { name: LIGHTROOM_MCP_SERVER_NAME, version: "0.12.0" },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [listedTool("get_selected_photos"), listedTool("get_photo_metadata"), maskTool],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      callCount += 1;
      throw new Error("No tool call is permitted after a rejected handshake");
    });
    await server.connect(serverTransport);
    const client = new Client({ name: "photo-agent-test", version: "1.0.0" });
    const backend = new LightroomMcpAdapter("unused-entry.js", {
      client,
      transport: clientTransport,
    });

    try {
      const result = await executeMaskCreation(backend, brushRequest);

      expect(result).toMatchObject({ outcome: "REVIEW_REQUIRED", retry_allowed: false });
      expect(result.reason).toMatch(/create_mask contract revision|unsafe create_mask semantics/i);
      expect(callCount).toBe(0);
    } finally {
      await server.close();
    }
  });
});
