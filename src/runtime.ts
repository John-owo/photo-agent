import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { SessionManifestSchema } from "./schemas.js";
import type { JobState, SessionManifest, SourceAssetPair } from "./types.js";

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  PENDING: ["ANALYZING", "CANCELLED", "FAILED"],
  ANALYZING: ["CODEX_INPUT_REQUIRED", "PLAN_READY", "CANCELLED", "FAILED"],
  CODEX_INPUT_REQUIRED: ["PLAN_READY", "CANCELLED", "FAILED"],
  PLAN_READY: ["APPLYING", "REVIEW_REQUIRED", "CANCELLED", "FAILED"],
  APPLYING: ["RENDERING", "REVIEW_REQUIRED", "CANCELLED", "FAILED"],
  RENDERING: ["REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  REVIEW_REQUIRED: [],
  FAILED: [],
  CANCELLED: [],
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function acquireMutationLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    if (handle) await handle.close();
    throw new Error(`Lightroom mutation lock is already held: ${lockPath}`, { cause: error });
  }
  await handle.close();
  return async () => {
    await unlink(lockPath).catch(() => undefined);
  };
}

export class SessionStore {
  readonly dir: string;
  private state: JobState = "PENDING";
  private manifest: SessionManifest;

  private constructor(dir: string, manifest: SessionManifest) {
    this.dir = dir;
    this.manifest = manifest;
  }

  static async create(
    root: string,
    source: SourceAssetPair,
    backendName: string,
  ): Promise<SessionStore> {
    const sessionId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
    const dir = join(resolve(root), sessionId);
    const manifest = SessionManifestSchema.parse({
      schema_version: "0.1.0",
      session_id: sessionId,
      created_at: new Date().toISOString(),
      source,
      provider: {
        name: "mock",
        model: "pending",
        prompt_version: "pending",
        prompt_hash: sha256("pending"),
        cloud_preview: false,
      },
      backend: { name: backendName, version: "pending" },
      config_hash: sha256(JSON.stringify({ backendName })),
      privacy: { raw_uploaded: false, exif_sent: false, preview_sanitized: true },
    });
    const store = new SessionStore(dir, manifest);
    await mkdir(join(dir, "inputs"), { recursive: true });
    await mkdir(join(dir, "renders"), { recursive: true });
    await mkdir(join(dir, "checkpoints"), { recursive: true });
    await atomicJsonWrite(join(dir, "manifest.json"), manifest);
    await atomicJsonWrite(join(dir, "state.json"), { state: store.state });
    await store.appendEvent("PENDING", { reason: "session_created" });
    return store;
  }

  static async open(dir: string): Promise<SessionStore> {
    const resolvedDir = resolve(dir);
    const manifest = SessionManifestSchema.parse(
      JSON.parse(await readFile(join(resolvedDir, "manifest.json"), "utf8")),
    );
    const stateValue = (
      JSON.parse(await readFile(join(resolvedDir, "state.json"), "utf8")) as {
        state?: unknown;
      }
    ).state;
    if (typeof stateValue !== "string" || !(stateValue in TRANSITIONS)) {
      throw new Error(`Invalid session state in ${join(resolvedDir, "state.json")}`);
    }
    const store = new SessionStore(resolvedDir, manifest);
    store.state = stateValue as JobState;
    return store;
  }

  get currentState(): JobState {
    return this.state;
  }

  get currentManifest(): SessionManifest {
    return this.manifest;
  }

  async updateManifest(patch: Partial<SessionManifest>): Promise<void> {
    this.manifest = SessionManifestSchema.parse({ ...this.manifest, ...patch });
    await atomicJsonWrite(join(this.dir, "manifest.json"), this.manifest);
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    await atomicJsonWrite(join(this.dir, relativePath), value);
  }

  async appendEvent(state: JobState, details: Record<string, unknown>): Promise<void> {
    const eventPath = join(this.dir, "session.log");
    const line = JSON.stringify({ at: new Date().toISOString(), state, ...details }) + "\n";
    await mkdir(dirname(eventPath), { recursive: true });
    await writeFile(eventPath, line, { encoding: "utf8", flag: "a" });
  }

  async transition(next: JobState, details: Record<string, unknown> = {}): Promise<void> {
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid state transition ${this.state} -> ${next}`);
    }
    this.state = next;
    await atomicJsonWrite(join(this.dir, "state.json"), {
      state: this.state,
      at: new Date().toISOString(),
    });
    await this.appendEvent(next, details);
  }

  async readJson<T>(relativePath: string): Promise<T> {
    return JSON.parse(await readFile(join(this.dir, relativePath), "utf8")) as T;
  }
}
