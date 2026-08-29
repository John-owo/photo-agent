import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BackendCapabilityManifestSchema, BackendPhotoStateSchema } from "./schemas.js";
import { writeFixtureJpeg } from "./preview.js";
import type {
  BackendAdapter,
  BackendCapabilityManifest,
  BackendPhotoState,
  CheckpointResult,
  RenderResult,
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

const LIGHTROOM_CAPABILITIES = BackendCapabilityManifestSchema.parse({
  backend: "lightroom-mcp",
  version: "0.10.0",
  trust_boundary: {
    transport: "localhost stdio -> Lightroom MCP local TCP bridge",
    authentication: "local MCP/plugin token managed by backend",
    cloud: false,
  },
  capabilities: [
    "read_current_edit",
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
      concurrency: "parallel_safe",
      retry_policy: "automatic",
      safe_to_resume: true,
    },
    apply_global_adjustment: {
      supported: true,
      side_effect: "mutating",
      idempotent: false,
      reversible: "checkpoint_only",
      scope: "photo",
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
      concurrency: "exclusive_backend",
      retry_policy: "manual_review_only",
      safe_to_resume: false,
    },
  },
});

const MOCK_CAPABILITIES = BackendCapabilityManifestSchema.parse({
  backend: "mock",
  version: "0.1.0",
  trust_boundary: { transport: "in-process", authentication: "none", cloud: false },
  capabilities: [
    "read_current_edit",
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
  readonly capabilities = MOCK_CAPABILITIES;
  readonly calls: string[] = [];
  private settings: Record<string, number | string | boolean> = {
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

  constructor(private readonly photoPath: string) {}

  async connect(): Promise<void> {
    this.calls.push("connect");
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }

  async readCurrentEdit(photoId: string): Promise<BackendPhotoState> {
    this.calls.push("read_current_edit");
    return BackendPhotoStateSchema.parse({
      photo_id: photoId,
      path: resolve(this.photoPath),
      develop_settings: this.settings,
    });
  }

  async createCheckpoint(
    _photoId: string,
    name: string,
    _settings: string[],
  ): Promise<CheckpointResult> {
    this.calls.push("create_checkpoint");
    void _settings;
    return { name, raw: { name, settings: this.settings } };
  }

  async applyGlobalAdjustment(
    _photoId: string,
    settings: Record<string, number | string | boolean>,
  ): Promise<unknown> {
    this.calls.push("apply_global_adjustment");
    this.settings = { ...this.settings, ...settings };
    return { applied: settings };
  }

  async renderPreview(_photoId: string, destination: string): Promise<RenderResult> {
    this.calls.push("render_preview");
    await mkdir(destination, { recursive: true });
    const output = join(destination, "mock-render.jpg");
    await writeFixtureJpeg(output);
    return { path: output, raw: { output } };
  }
}

export class LightroomMcpAdapter implements BackendAdapter {
  readonly name = "lightroom-mcp";
  readonly capabilities: BackendCapabilityManifest = LIGHTROOM_CAPABILITIES;
  private transport: StdioClientTransport | undefined;
  private client: Client | undefined;

  constructor(private readonly entryPath: string) {}

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.entryPath],
      stderr: "pipe",
    });
    this.client = new Client({ name: "photo-agent", version: "0.3.0-alpha.0" });
    await this.client.connect(this.transport);
    const tools = await this.client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    const required = [
      "get_photo_metadata",
      "set_develop_settings",
      "create_develop_preset",
      "export_photos",
    ];
    const missing = required.filter((name) => !names.has(name));
    if (missing.length > 0)
      throw new Error(`Lightroom MCP missing required tools: ${missing.join(", ")}`);
    if (names.has("get_selected_photos")) await this.waitForPluginReady();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.transport = undefined;
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

  async readCurrentEdit(photoId: string): Promise<BackendPhotoState> {
    const raw = await this.call<unknown>("get_photo_metadata", { photo_id: photoId });
    const record = asRecord(raw);
    const pathValue = record.path ?? asRecord(record.metadata).path ?? photoId;
    return BackendPhotoStateSchema.parse({
      photo_id: photoId,
      path: typeof pathValue === "string" ? pathValue : photoId,
      develop_settings: asDevelopSettings(raw),
    });
  }

  async createCheckpoint(
    photoId: string,
    name: string,
    settings: string[],
  ): Promise<CheckpointResult> {
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
    return this.call("set_develop_settings", { photo_id: photoId, settings });
  }

  async renderPreview(photoId: string, destination: string): Promise<RenderResult> {
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

export function lightroomCapabilities(): BackendCapabilityManifest {
  return LIGHTROOM_CAPABILITIES;
}
