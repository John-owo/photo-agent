import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  BackendCapabilityManifestSchema,
  BackendPhotoIdentitySchema,
  BackendPhotoStateSchema,
  OperationSemanticsSchema,
  WorkflowCopyResultSchema,
} from "./schemas.js";
import {
  assertBackendOperations,
  validateBackendCapabilityManifest,
  type BackendHandshakeRequirements,
} from "./backend-handshake.js";
import { writeFixtureJpeg } from "./preview.js";
import type {
  BackendAdapter,
  BackendCapabilityManifest,
  BackendPhotoState,
  CheckpointResult,
  RenderResult,
  WorkflowCopyResult,
} from "./types.js";

const SUPPORTED_DEVELOP_KEYS = [
  "WhiteBalance",
  "Temperature",
  "Tint",
  "Exposure2012",
  "Contrast2012",
  "Highlights2012",
  "Shadows2012",
  "Whites2012",
  "Blacks2012",
  "Texture",
  "Clarity2012",
  "Dehaze",
  "Vibrance",
  "Saturation",
];

const PLUGIN_READY_TIMEOUT_MS = 10_000;
const PLUGIN_READY_RETRY_MS = 250;
export const LIGHTROOM_MCP_SERVER_NAME = "lightroom-mcp-server";
export const OPERATION_SEMANTICS_META_KEY =
  "io.github.john-owo.lightroom-mcp/operation-semantics";

export const LIGHTROOM_TRUST_BOUNDARY = {
  transport: "localhost stdio -> Lightroom MCP local TCP bridge",
  authentication: "local MCP/plugin token managed by backend",
  cloud: false,
} as const;

export const MOCK_TRUST_BOUNDARY = {
  transport: "in-process",
  authentication: "none",
  cloud: false,
} as const;

const LIGHTROOM_TOOL_OPERATIONS = {
  get_photo_metadata: "read_current_edit",
  set_develop_settings: "apply_global_adjustment",
  create_develop_preset: "create_checkpoint",
  export_photos: "render_preview",
  create_virtual_copy: "create_workflow_copy",
} as const;

const LIGHTROOM_HANDSHAKE_REQUIREMENTS: BackendHandshakeRequirements = {
  expectedBackend: "lightroom-mcp",
  expectedVersion: "0.10.0",
  expectedTrustBoundary: LIGHTROOM_TRUST_BOUNDARY,
};

const MOCK_HANDSHAKE_REQUIREMENTS: BackendHandshakeRequirements = {
  expectedBackend: "mock",
  expectedVersion: "0.1.0",
  expectedTrustBoundary: MOCK_TRUST_BOUNDARY,
};

export const LIGHTROOM_CAPABILITIES = BackendCapabilityManifestSchema.parse({
  backend: "lightroom-mcp",
  version: "0.10.0",
  trust_boundary: LIGHTROOM_TRUST_BOUNDARY,
  capabilities: [
    "read_current_edit",
    "create_workflow_copy",
    "apply_global_adjustment",
    "render_preview",
    "create_checkpoint",
  ],
  operations: {
    read_current_edit: {
      supported: true,
      side_effect: "read_only",
      idempotent: true,
      reversible: "true_undo",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "parallel_safe",
      retry_policy: "automatic",
      safe_to_resume: true,
    },
    create_workflow_copy: {
      supported: true,
      side_effect: "mutating",
      idempotent: false,
      reversible: "irreversible",
      scope: "selection",
      requires_active_selection: true,
      requires_editor_foreground: true,
      concurrency: "exclusive_backend",
      retry_policy: "readback_before_retry",
      safe_to_resume: false,
    },
    apply_global_adjustment: {
      supported: true,
      side_effect: "mutating",
      idempotent: false,
      reversible: "checkpoint_only",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "exclusive_backend",
      retry_policy: "readback_before_retry",
      safe_to_resume: false,
    },
    render_preview: {
      supported: true,
      side_effect: "temporary",
      idempotent: true,
      reversible: "new_file",
      scope: "session",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "exclusive_backend",
      retry_policy: "manual_review_only",
      safe_to_resume: false,
    },
    create_checkpoint: {
      supported: true,
      side_effect: "mutating",
      idempotent: false,
      reversible: "new_file",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "exclusive_backend",
      retry_policy: "manual_review_only",
      safe_to_resume: false,
    },
  },
});

export const MOCK_CAPABILITIES = BackendCapabilityManifestSchema.parse({
  backend: "mock",
  version: "0.1.0",
  trust_boundary: MOCK_TRUST_BOUNDARY,
  capabilities: [
    "read_current_edit",
    "create_workflow_copy",
    "apply_global_adjustment",
    "render_preview",
    "create_checkpoint",
  ],
  operations: LIGHTROOM_CAPABILITIES.operations,
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asDevelopSettings(value: unknown): Record<string, number | string | boolean> {
  const source = asRecord(value);
  const nested = asRecord(source.developSettings ?? source.develop_settings);
  const aliases: Record<string, string> = {
    whiteBalance: "WhiteBalance",
    temperature: "Temperature",
    tint: "Tint",
    exposure: "Exposure2012",
    contrast: "Contrast2012",
    highlights: "Highlights2012",
    shadows: "Shadows2012",
    whites: "Whites2012",
    blacks: "Blacks2012",
    texture: "Texture",
    clarity: "Clarity2012",
    dehaze: "Dehaze",
    vibrance: "Vibrance",
    saturation: "Saturation",
  };
  const settings: Record<string, number | string | boolean> = {};
  for (const key of SUPPORTED_DEVELOP_KEYS) {
    const direct = nested[key] ?? source[key];
    if (typeof direct === "number" || typeof direct === "string" || typeof direct === "boolean")
      settings[key] = direct;
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    const valueAtAlias = nested[alias] ?? source[alias];
    if (
      settings[canonical] === undefined &&
      (typeof valueAtAlias === "number" ||
        typeof valueAtAlias === "string" ||
        typeof valueAtAlias === "boolean")
    ) {
      settings[canonical] = valueAtAlias;
    }
  }
  return settings;
}

function parseToolResult<T>(value: unknown): T {
  const result = asRecord(value);
  if (result.isError === true)
    throw new Error(`Lightroom MCP tool failed: ${JSON.stringify(result)}`);
  if (result.structuredContent) return result.structuredContent as T;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => asRecord(item).type === "text");
  if (text) {
    const textValue = asRecord(text).text;
    if (typeof textValue === "string") {
      try {
        return JSON.parse(textValue) as T;
      } catch {
        return textValue as T;
      }
    }
  }
  return value as T;
}

export class MockBackend implements BackendAdapter {
  readonly name = "mock";
  readonly handshakeRequirements = MOCK_HANDSHAKE_REQUIREMENTS;
  readonly calls: string[] = [];
  readonly operationTargets: string[] = [];
  private readonly advertisedManifest: unknown;
  private readonly sourceIdentityMode: "master" | "virtual_copy" | "uncertain";
  private negotiatedManifest: BackendCapabilityManifest | undefined;
  private connected = false;
  private readonly masterUuid = "mock-master-uuid";
  private masterPhotoId: string | undefined;
  private readonly copies = new Map<
    string,
    {
      operationId: string;
      uuid: string;
      settings: Record<string, number | string | boolean>;
    }
  >();
  private readonly copyByOperation = new Map<string, string>();
  private masterSettings: Record<string, number | string | boolean> = {
    WhiteBalance: "As Shot",
    Temperature: 5200,
    Tint: 0,
    Exposure2012: 0,
    Contrast2012: 0,
    Highlights2012: 0,
    Shadows2012: 0,
    Whites2012: 0,
    Blacks2012: 0,
    Texture: 0,
    Clarity2012: 0,
    Dehaze: 0,
    Vibrance: 0,
    Saturation: 0,
  };

  constructor(private readonly photoPath: string, manifestOrOptions?: unknown) {
    const options = asRecord(manifestOrOptions);
    const requestedIdentity = options.sourceIdentity;
    this.sourceIdentityMode =
      requestedIdentity === "virtual_copy" || requestedIdentity === "uncertain"
        ? requestedIdentity
        : "master";
    this.advertisedManifest =
      "manifest" in options || "sourceIdentity" in options
        ? (options.manifest ?? MOCK_CAPABILITIES)
        : (manifestOrOptions ?? MOCK_CAPABILITIES);
  }

  get capabilities(): BackendCapabilityManifest {
    if (!this.negotiatedManifest) {
      throw new Error("Mock backend capabilities are unavailable before handshake");
    }
    return this.negotiatedManifest;
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    this.connected = true;
    this.negotiatedManifest = undefined;
  }

  async handshake(): Promise<BackendCapabilityManifest> {
    if (!this.connected) throw new Error("Mock backend must connect before handshake");
    this.calls.push("handshake");
    const manifest = validateBackendCapabilityManifest(this.advertisedManifest, MOCK_HANDSHAKE_REQUIREMENTS);
    this.negotiatedManifest = manifest;
    return manifest;
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.connected = false;
    this.negotiatedManifest = undefined;
  }

  private requireHandshake(): BackendCapabilityManifest {
    if (!this.negotiatedManifest) {
      throw new Error("Mock backend handshake is required before backend operations");
    }
    return this.negotiatedManifest;
  }

  private requireOperation(operation: string): void {
    assertBackendOperations(this.requireHandshake(), [operation]);
  }

  async readCurrentEdit(photoId: string): Promise<BackendPhotoState> {
    this.requireOperation("read_current_edit");
    this.calls.push("read_current_edit");
    const copy = this.copies.get(photoId);
    if (!this.masterPhotoId) this.masterPhotoId = copy ? undefined : photoId;
    const masterId = this.masterPhotoId ?? photoId;
    return BackendPhotoStateSchema.parse({
      photo_id: photoId,
      path: resolve(this.photoPath),
      develop_settings: copy?.settings ?? this.masterSettings,
      identity: copy
        ? {
            catalog_id: photoId,
            uuid: copy.uuid,
            master_id: masterId,
            master_uuid: this.masterUuid,
            is_virtual_copy: true,
          }
        : this.sourceIdentityMode === "uncertain"
          ? undefined
          : this.sourceIdentityMode === "virtual_copy"
            ? {
                catalog_id: photoId,
                uuid: "mock-input-copy-uuid",
                master_id: `${photoId}-master`,
                master_uuid: this.masterUuid,
                is_virtual_copy: true,
              }
            : {
                catalog_id: photoId,
                uuid: this.masterUuid,
                master_id: photoId,
                master_uuid: this.masterUuid,
                is_virtual_copy: false,
              },
    });
  }

  async createWorkflowCopy(
    sourcePhotoId: string,
    expectedSourceUuid: string,
    operationId: string,
  ): Promise<WorkflowCopyResult> {
    this.requireOperation("create_workflow_copy");
    this.calls.push("create_workflow_copy");
    this.masterPhotoId ??= sourcePhotoId;
    if (sourcePhotoId !== this.masterPhotoId || expectedSourceUuid !== this.masterUuid) {
      throw new Error("Mock Workflow Copy source identity mismatch");
    }
    const existingId = this.copyByOperation.get(operationId);
    const copyId = existingId ?? `mock-copy-${operationId}`;
    if (!existingId) {
      this.copies.set(copyId, {
        operationId,
        uuid: `mock-copy-uuid-${operationId}`,
        settings: { ...this.masterSettings },
      });
      this.copyByOperation.set(operationId, copyId);
    }
    const copy = this.copies.get(copyId)!;
    return WorkflowCopyResultSchema.parse({
      operation_id: operationId,
      result: existingId ? "reconciled" : "created",
      partial: false,
      source: {
        catalog_id: this.masterPhotoId,
        uuid: this.masterUuid,
        master_id: this.masterPhotoId,
        master_uuid: this.masterUuid,
        is_virtual_copy: false,
      },
      master: {
        catalog_id: this.masterPhotoId,
        uuid: this.masterUuid,
        master_id: this.masterPhotoId,
        master_uuid: this.masterUuid,
        is_virtual_copy: false,
      },
      copy: {
        catalog_id: copyId,
        uuid: copy.uuid,
        master_id: this.masterPhotoId,
        master_uuid: this.masterUuid,
        is_virtual_copy: true,
      },
      selection_restoration: { status: "restored", verified: true },
    });
  }

  async createCheckpoint(
    photoId: string,
    name: string,
    _settings: string[],
  ): Promise<CheckpointResult> {
    this.requireOperation("create_checkpoint");
    this.calls.push("create_checkpoint");
    this.operationTargets.push(photoId);
    void _settings;
    const settings = this.copies.get(photoId)?.settings ?? this.masterSettings;
    return { name, raw: { name, settings } };
  }

  async applyGlobalAdjustment(
    photoId: string,
    settings: Record<string, number | string | boolean>,
  ): Promise<unknown> {
    this.requireOperation("apply_global_adjustment");
    this.calls.push("apply_global_adjustment");
    this.operationTargets.push(photoId);
    const copy = this.copies.get(photoId);
    if (copy) copy.settings = { ...copy.settings, ...settings };
    else this.masterSettings = { ...this.masterSettings, ...settings };
    return { applied: settings };
  }

  async renderPreview(photoId: string, destination: string): Promise<RenderResult> {
    this.requireOperation("render_preview");
    this.calls.push("render_preview");
    this.operationTargets.push(photoId);
    await mkdir(destination, { recursive: true });
    const output = join(destination, "mock-render.jpg");
    await writeFixtureJpeg(output);
    return { path: output, raw: { output } };
  }
}

export class LightroomMcpAdapter implements BackendAdapter {
  readonly name = "lightroom-mcp";
  readonly handshakeRequirements = LIGHTROOM_HANDSHAKE_REQUIREMENTS;
  private transport: Transport | undefined;
  private client: Client | undefined;
  private negotiatedManifest: BackendCapabilityManifest | undefined;
  private availableToolNames = new Set<string>();
  private pluginReady = false;
  private readonly injectedClient: Client | undefined;
  private readonly injectedTransport: Transport | undefined;

  constructor(
    private readonly entryPath: string,
    options: { client?: Client; transport?: Transport } = {},
  ) {
    if ((options.client && !options.transport) || (!options.client && options.transport)) {
      throw new Error("Lightroom MCP adapter injection requires both client and transport");
    }
    this.injectedClient = options.client;
    this.injectedTransport = options.transport;
  }

  get capabilities(): BackendCapabilityManifest {
    if (!this.negotiatedManifest) {
      throw new Error("Lightroom MCP capabilities are unavailable before handshake");
    }
    return this.negotiatedManifest;
  }

  async connect(): Promise<void> {
    this.transport =
      this.injectedTransport ??
      new StdioClientTransport({
        command: process.execPath,
        args: [this.entryPath],
        stderr: "pipe",
      });
    this.client = this.injectedClient ?? new Client({ name: "photo-agent", version: "0.3.0-alpha.0" });
    await this.client.connect(this.transport);
    this.negotiatedManifest = undefined;
    this.availableToolNames = new Set<string>();
    this.pluginReady = false;
  }

  async handshake(): Promise<BackendCapabilityManifest> {
    if (!this.client) throw new Error("Lightroom MCP adapter is not connected");
    const serverVersion = this.client.getServerVersion();
    if (!serverVersion) {
      throw new Error("Lightroom MCP handshake rejected: server version is missing");
    }
    if (serverVersion.name !== LIGHTROOM_MCP_SERVER_NAME) {
      throw new Error(
        `Lightroom MCP handshake rejected wrong server identity: expected ${LIGHTROOM_MCP_SERVER_NAME}, received ${serverVersion.name}`,
      );
    }
    const toolsResult = await this.client.listTools();
    if (!Array.isArray(toolsResult.tools)) {
      throw new Error("Lightroom MCP handshake rejected malformed tool listing");
    }
    const toolNames = toolsResult.tools.map((tool) => tool.name);
    if (new Set(toolNames).size !== toolNames.length) {
      throw new Error("Lightroom MCP handshake rejected duplicate tool names");
    }
    const tools = new Map(toolsResult.tools.map((tool) => [tool.name, tool]));
    const operations: Record<string, BackendCapabilityManifest["operations"][string]> = {};
    const capabilities: string[] = [];
    for (const [toolName, operationName] of Object.entries(LIGHTROOM_TOOL_OPERATIONS)) {
      const tool = tools.get(toolName);
      if (!tool) continue;
      const metadata = asRecord(tool._meta);
      const semantics = OperationSemanticsSchema.safeParse(metadata[OPERATION_SEMANTICS_META_KEY]);
      if (!semantics.success) {
        throw new Error(
          `Lightroom MCP handshake rejected malformed operation semantics for ${toolName}: ${semantics.error.message}`,
        );
      }
      operations[operationName] = semantics.data;
      capabilities.push(operationName);
    }
    const selectedTool = tools.get("get_selected_photos");
    if (selectedTool) {
      const selectedSemantics = OperationSemanticsSchema.safeParse(
        asRecord(selectedTool._meta)[OPERATION_SEMANTICS_META_KEY],
      );
      if (!selectedSemantics.success) {
        throw new Error(
          `Lightroom MCP handshake rejected malformed operation semantics for get_selected_photos: ${selectedSemantics.error.message}`,
        );
      }
      if (!selectedSemantics.data.supported) {
        throw new Error(
          "Lightroom MCP handshake rejected unsupported operation: get_selected_photos",
        );
      }
    }
    const manifest = BackendCapabilityManifestSchema.parse({
      backend: this.name,
      version: serverVersion.version,
      trust_boundary: LIGHTROOM_TRUST_BOUNDARY,
      capabilities,
      operations,
    });
    const validated = validateBackendCapabilityManifest(
      manifest,
      LIGHTROOM_HANDSHAKE_REQUIREMENTS,
    );
    this.availableToolNames = new Set(tools.keys());
    this.negotiatedManifest = validated;
    this.pluginReady = false;
    return validated;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
    this.negotiatedManifest = undefined;
    this.availableToolNames = new Set<string>();
    this.pluginReady = false;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error("Lightroom MCP adapter is not connected");
    return parseToolResult<T>(await this.client.callTool({ name, arguments: args }));
  }

  private async waitForPluginReady(): Promise<void> {
    const deadline = Date.now() + PLUGIN_READY_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.call("get_selected_photos", { limit: 1, offset: 0 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, PLUGIN_READY_RETRY_MS));
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Lightroom MCP plugin did not become ready within 10s: ${message}`);
  }

  private requireHandshake(): BackendCapabilityManifest {
    if (!this.negotiatedManifest) {
      throw new Error("Lightroom MCP handshake is required before backend operations");
    }
    return this.negotiatedManifest;
  }

  private requireOperation(operation: string): void {
    assertBackendOperations(this.requireHandshake(), [operation]);
  }

  private async ensurePluginReady(): Promise<void> {
    this.requireHandshake();
    if (this.pluginReady || !this.availableToolNames.has("get_selected_photos")) return;
    await this.waitForPluginReady();
    this.pluginReady = true;
  }

  async readCurrentEdit(photoId: string): Promise<BackendPhotoState> {
    this.requireOperation("read_current_edit");
    await this.ensurePluginReady();
    const raw = await this.call<unknown>("get_photo_metadata", { photo_id: photoId });
    const record = asRecord(raw);
    const pathValue = record.path ?? asRecord(record.metadata).path ?? photoId;
    const identityResult = BackendPhotoIdentitySchema.safeParse({
      catalog_id: record.catalog_id,
      uuid: record.uuid,
      master_id: record.master_id,
      master_uuid: record.master_uuid,
      is_virtual_copy: record.is_virtual_copy,
    });
    return BackendPhotoStateSchema.parse({
      photo_id: photoId,
      path: typeof pathValue === "string" ? pathValue : photoId,
      develop_settings: asDevelopSettings(raw),
      ...(identityResult.success ? { identity: identityResult.data } : {}),
    });
  }

  async createWorkflowCopy(
    sourcePhotoId: string,
    expectedSourceUuid: string,
    operationId: string,
  ): Promise<WorkflowCopyResult> {
    this.requireOperation("create_workflow_copy");
    const raw = await this.call<unknown>("create_virtual_copy", {
      source_photo_id: sourcePhotoId,
      expected_source_uuid: expectedSourceUuid,
      operation_id: operationId,
    });
    const record = asRecord(raw);
    const source = asRecord(record.source);
    const master = asRecord(record.master);
    const copy = asRecord(record.copy);
    const masterId = master.catalog_id ?? source.catalog_id;
    const masterUuid = master.uuid ?? source.uuid;
    return WorkflowCopyResultSchema.parse({
      operation_id: record.operation_id,
      result: record.result,
      partial: record.partial ?? false,
      ...(typeof source.catalog_id === "string" && typeof source.uuid === "string"
        ? {
            source: {
              catalog_id: source.catalog_id,
              uuid: source.uuid,
              master_id: masterId,
              master_uuid: masterUuid,
              is_virtual_copy: source.is_virtual_copy,
            },
          }
        : {}),
      ...(typeof masterId === "string" && typeof masterUuid === "string"
        ? {
            master: {
              catalog_id: masterId,
              uuid: masterUuid,
              master_id: masterId,
              master_uuid: masterUuid,
              is_virtual_copy: false,
            },
          }
        : {}),
      ...(typeof copy.catalog_id === "string" && typeof copy.uuid === "string"
        ? {
            copy: {
              catalog_id: copy.catalog_id,
              uuid: copy.uuid,
              master_id: masterId,
              master_uuid: masterUuid,
              is_virtual_copy: copy.is_virtual_copy,
            },
          }
        : {}),
      selection_restoration: record.selection_restoration,
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    });
  }

  async createCheckpoint(
    photoId: string,
    name: string,
    settings: string[],
  ): Promise<CheckpointResult> {
    this.requireOperation("create_checkpoint");
    const raw = await this.call<unknown>("create_develop_preset", {
      photo_id: photoId,
      preset_name: name,
      settings,
    });
    return { name, raw };
  }

  async applyGlobalAdjustment(
    photoId: string,
    settings: Record<string, number | string | boolean>,
  ): Promise<unknown> {
    this.requireOperation("apply_global_adjustment");
    return this.call("set_develop_settings", { photo_id: photoId, settings });
  }

  async renderPreview(photoId: string, destination: string): Promise<RenderResult> {
    this.requireOperation("render_preview");
    await mkdir(destination, { recursive: true });
    const before = new Set(await readdir(destination));
    const raw = await this.call<unknown>("export_photos", {
      photo_ids: [photoId],
      destination,
      format: "jpeg",
      quality: 80,
      width: 2048,
      height: 2048,
    });
    const created = (await readdir(destination)).filter((name) => !before.has(name));
    const renderName = created.find((name) => /\.(jpe?g|png)$/i.test(name));
    if (!renderName)
      throw new Error(
        `Lightroom export produced no preview inside session directory: ${destination}`,
      );
    return { path: join(destination, renderName), raw };
  }
}

/**
 * Return the checked-in Lightroom capability reference for documentation and
 * fixture construction. Runtime calls must use `handshake()`/`capabilities`
 * after negotiation; this reference is never used as runtime authorization.
 */
export function lightroomCapabilities(): BackendCapabilityManifest {
  return LIGHTROOM_CAPABILITIES;
}
