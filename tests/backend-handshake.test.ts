import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  LIGHTROOM_MCP_SERVER_NAME,
  OPERATION_SEMANTICS_META_KEY,
  LightroomMcpAdapter,
  MockBackend,
} from "../src/backends.js";
import { assertBackendOperations, requireBackendHandshake } from "../src/backend-handshake.js";
import { BackendCapabilityManifestSchema } from "../src/schemas.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { MockProvider } from "../src/providers.js";
import { runSinglePhoto } from "../src/workflow.js";

const operation = {
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

function manifest(overrides: Record<string, unknown> = {}) {
  return BackendCapabilityManifestSchema.parse({
    backend: "mock",
    version: "0.1.0",
    trust_boundary: { transport: "in-process", authentication: "none", cloud: false },
    capabilities: [
      "read_current_edit",
      "create_workflow_copy",
      "apply_global_adjustment",
      "render_preview",
      "create_checkpoint",
    ],
    operations: {
      read_current_edit: operation,
      create_workflow_copy: {
        ...operation,
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
      apply_global_adjustment: { ...operation, side_effect: "mutating", idempotent: false },
      render_preview: { ...operation, side_effect: "temporary" },
      create_checkpoint: { ...operation, side_effect: "mutating", idempotent: false },
    },
    ...overrides,
  });
}

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-t06-handshake-"));
  const path = join(root, "sample.NEF");
  await writeFile(path, "fixture", "utf8");
  return path;
}

async function rejectedWorkflow(advertised: unknown) {
  const root = await mkdtemp(join(tmpdir(), "photo-agent-t06-rejected-"));
  const raw = join(root, "sample.NEF");
  const preview = join(root, "sample.JPG");
  await writeFile(raw, "fixture", "utf8");
  await writeFixtureJpeg(preview);
  const backend = new MockBackend(raw, { manifest: advertised });
  const result = await runSinglePhoto({
    rawPath: raw,
    previewPath: preview,
    provider: new MockProvider(),
    backend,
    sessionRoot: join(root, "sessions"),
    apply: true,
    allowCloudPreview: false,
  });
  return { backend, result };
}

type OperationSemantics = z.infer<typeof BackendCapabilityManifestSchema>["operations"][string];

const readSemantics: OperationSemantics = {
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

function tool(name: string, semantics: OperationSemantics = readSemantics) {
  return {
    name,
    description: `fixture ${name}`,
    inputSchema: { type: "object", properties: {} },
    _meta: { [OPERATION_SEMANTICS_META_KEY]: semantics },
  };
}

async function inMemoryLightroom(
  version: string,
  name = LIGHTROOM_MCP_SERVER_NAME,
  malformedTool?: string,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const calls: string[] = [];
  const server = new Server({ name, version }, { capabilities: { tools: { listChanged: false } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    calls.push("list_tools");
    const listedTool = (toolName: string, semantics?: OperationSemantics) =>
      toolName === malformedTool
        ? { ...tool(toolName, semantics), _meta: {} }
        : tool(toolName, semantics);
    return {
      tools: [
        listedTool("get_selected_photos"),
        listedTool("get_photo_metadata"),
        listedTool("create_virtual_copy", {
          ...readSemantics,
          side_effect: "mutating",
          idempotent: false,
          reversible: "irreversible",
          scope: "selection",
          requires_active_selection: true,
          requires_editor_foreground: true,
          concurrency: "exclusive_backend",
          retry_policy: "readback_before_retry",
          safe_to_resume: false,
        }),
        listedTool("set_develop_settings", {
          ...readSemantics,
          side_effect: "mutating",
          idempotent: false,
        }),
        listedTool("create_develop_preset", {
          ...readSemantics,
          side_effect: "mutating",
          idempotent: false,
        }),
        listedTool("export_photos", { ...readSemantics, side_effect: "delivery_export" }),
      ],
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    calls.push(name);
    if (name === "get_selected_photos") {
      return { content: [{ type: "text", text: JSON.stringify({ photos: [] }) }] };
    }
    if (name === "get_photo_metadata") {
      const photoId = String(request.params.arguments?.photo_id ?? "100");
      const isCopy = photoId === "101";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              catalog_id: photoId,
              uuid: isCopy ? "uuid-copy" : "uuid-master",
              master_id: "100",
              master_uuid: "uuid-master",
              is_virtual_copy: isCopy,
              path: "C:/照片/星空.NEF",
              developSettings: { Exposure2012: 0 },
            }),
          },
        ],
      };
    }
    if (name === "create_virtual_copy") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              operation_id: "photoagent-vc-test-001",
              result: "created",
              partial: false,
              source: {
                catalog_id: "100",
                uuid: "uuid-master",
                is_virtual_copy: false,
              },
              master: {
                catalog_id: "100",
                uuid: "uuid-master",
                is_virtual_copy: false,
              },
              copy: {
                catalog_id: "101",
                uuid: "uuid-copy",
                is_virtual_copy: true,
              },
              selection_restoration: { status: "restored", verified: true },
            }),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });
  await server.connect(serverTransport);
  const client = new Client({ name: "photo-agent-test", version: "1.0.0" });
  return {
    adapter: new LightroomMcpAdapter("unused-entry.js", {
      client,
      transport: clientTransport,
    }),
    calls,
    close: async () => {
      await server.close();
    },
  };
}

describe("versioned backend handshake", () => {
  it("returns the validated manifest and records the handshake before backend reads", async () => {
    const backend = new MockBackend(await fixturePath());
    await backend.connect();
    const result = await backend.handshake();

    expect(result).toMatchObject({ backend: "mock", version: "0.1.0" });
    expect(result.trust_boundary).toEqual({
      transport: "in-process",
      authentication: "none",
      cloud: false,
    });
    expect(backend.calls).toEqual(["connect", "handshake"]);
  });

  it.each([
    ["incompatible major", manifest({ version: "1.0.0" })],
    ["wrong backend", manifest({ backend: "untrusted-backend" })],
  ])("rejects %s before any backend operation", async (_name, advertised) => {
    const backend = new MockBackend(await fixturePath(), { manifest: advertised });

    await backend.connect();
    await expect(backend.handshake()).rejects.toThrow(/handshake|incompatible|wrong backend/i);
    expect(backend.calls).toEqual(["connect", "handshake"]);
  });

  it("rejects an unsupported operation at the shared execution gate", async () => {
    const advertised = manifest({
      capabilities: ["read_current_edit", "render_preview", "create_checkpoint"],
      operations: {
        ...manifest().operations,
        apply_global_adjustment: { ...operation, supported: false },
      },
    });
    const backend = new MockBackend(await fixturePath(), { manifest: advertised });

    await backend.connect();
    const negotiated = await backend.handshake();
    expect(() => assertBackendOperations(negotiated, ["apply_global_adjustment"])).toThrow(
      /unsupported operation/i,
    );
    expect(backend.calls).toEqual(["connect", "handshake"]);
  });

  it.each([
    ["incompatible major", manifest({ version: "1.0.0" })],
    [
      "unexpected trust boundary",
      manifest({
        trust_boundary: { transport: "in-process", authentication: "none", cloud: true },
      }),
    ],
  ])("revalidates %s at the shared backend gate", async (_name, advertised) => {
    const backend = new MockBackend(await fixturePath());
    await backend.connect();
    backend.handshake = async () => advertised;

    await expect(requireBackendHandshake(backend, ["read_current_edit"])).rejects.toThrow(
      /incompatible major|unexpected trust boundary/i,
    );
    expect(backend.calls).toEqual(["connect"]);
  });

  it.each([
    ["incompatible major", manifest({ version: "1.0.0" })],
    ["wrong backend", manifest({ backend: "untrusted-backend" })],
    [
      "unsupported required operation",
      manifest({
        capabilities: ["read_current_edit", "render_preview", "create_checkpoint"],
        operations: {
          ...manifest().operations,
          apply_global_adjustment: { ...operation, supported: false },
        },
      }),
    ],
  ])("fails closed before read/checkpoint/apply for %s", async (_name, advertised) => {
    const { backend, result } = await rejectedWorkflow(advertised);

    expect(result.state).toBe("FAILED");
    expect(backend.calls).toEqual(["connect", "handshake", "close"]);
    expect(backend.calls).not.toContain("read_current_edit");
    expect(backend.calls).not.toContain("create_checkpoint");
    expect(backend.calls).not.toContain("apply_global_adjustment");
  });

  it.each([
    [
      "advertised capability without semantics",
      (() => {
        const malformed = manifest();
        delete malformed.operations.read_current_edit;
        return malformed;
      })(),
    ],
    [
      "duplicate advertised capability",
      { ...manifest(), capabilities: ["read_current_edit", "read_current_edit"] },
    ],
  ])("fails closed before catalog access for %s", async (_name, advertised) => {
    const { backend, result } = await rejectedWorkflow(advertised);

    expect(result.state).toBe("FAILED");
    expect(backend.calls).toEqual(["connect", "handshake", "close"]);
    expect(backend.calls).not.toContain("read_current_edit");
  });

  it("derives a compatible Lightroom manifest through an in-memory MCP transport", async () => {
    const fixture = await inMemoryLightroom("0.10.7");
    await fixture.adapter.connect();
    expect(fixture.calls).toEqual([]);
    expect(() => fixture.adapter.capabilities).toThrow(/before handshake/);

    const negotiated = await fixture.adapter.handshake();
    expect(negotiated).toMatchObject({
      backend: "lightroom-mcp",
      version: "0.10.7",
      trust_boundary: {
        transport: "localhost stdio -> Lightroom MCP local TCP bridge",
        authentication: "local MCP/plugin token managed by backend",
        cloud: false,
      },
    });
    expect(negotiated.operations.read_current_edit).toMatchObject({
      supported: true,
      requires_active_selection: false,
      requires_editor_foreground: false,
    });
    expect(fixture.calls).toEqual(["list_tools"]);

    const current = await fixture.adapter.readCurrentEdit("C:/照片/星空.NEF");
    expect(current.path).toBe("C:/照片/星空.NEF");
    expect(fixture.calls).toEqual(["list_tools", "get_selected_photos", "get_photo_metadata"]);
    await fixture.adapter.close();
    await fixture.close();
  });

  it("rejects an incompatible Lightroom MCP major before any catalog read", async () => {
    const fixture = await inMemoryLightroom("1.0.0");
    await fixture.adapter.connect();

    await expect(fixture.adapter.handshake()).rejects.toThrow(/incompatible major/i);
    expect(fixture.calls).toEqual(["list_tools"]);
    await expect(fixture.adapter.readCurrentEdit("C:/照片/星空.NEF")).rejects.toThrow(
      /before backend operations|handshake/i,
    );
    expect(fixture.calls).toEqual(["list_tools"]);
    await fixture.adapter.close();
    await fixture.close();
  });

  it("rejects an unexpected MCP server identity before listing tools", async () => {
    const fixture = await inMemoryLightroom("0.10.7", "untrusted-server");
    await fixture.adapter.connect();

    await expect(fixture.adapter.handshake()).rejects.toThrow(/wrong server identity/i);
    expect(fixture.calls).toEqual([]);
    await fixture.adapter.close();
    await fixture.close();
  });

  it("rejects malformed operation semantics at the MCP trust boundary", async () => {
    const fixture = await inMemoryLightroom("0.10.7", LIGHTROOM_MCP_SERVER_NAME, "export_photos");
    await fixture.adapter.connect();

    await expect(fixture.adapter.handshake()).rejects.toThrow(/malformed operation semantics/i);
    expect(fixture.calls).toEqual(["list_tools"]);
    await fixture.adapter.close();
    await fixture.close();
  });

  it("maps an identity-verified Workflow Copy through the Lightroom MCP boundary", async () => {
    const fixture = await inMemoryLightroom("0.10.7");
    await fixture.adapter.connect();
    await fixture.adapter.handshake();

    const master = await fixture.adapter.readCurrentEdit("100");
    expect(master.identity).toEqual({
      catalog_id: "100",
      uuid: "uuid-master",
      master_id: "100",
      master_uuid: "uuid-master",
      is_virtual_copy: false,
    });
    const created = await fixture.adapter.createWorkflowCopy(
      "100",
      "uuid-master",
      "photoagent-vc-test-001",
    );
    expect(created).toMatchObject({
      result: "created",
      partial: false,
      copy: {
        catalog_id: "101",
        uuid: "uuid-copy",
        master_id: "100",
        master_uuid: "uuid-master",
        is_virtual_copy: true,
      },
      selection_restoration: { status: "restored", verified: true },
    });
    const copy = await fixture.adapter.readCurrentEdit("101");
    expect(copy.identity).toEqual(created.copy);
    expect(copy.develop_settings).toEqual(master.develop_settings);
    expect(fixture.calls).toEqual([
      "list_tools",
      "get_selected_photos",
      "get_photo_metadata",
      "create_virtual_copy",
      "get_photo_metadata",
    ]);

    await fixture.adapter.close();
    await fixture.close();
  });
});
