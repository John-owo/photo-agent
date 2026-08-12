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
  RENDERING: ["EVALUATING", "REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  EVALUATING: ["ACCEPTED", "REFINING", "REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  REFINING: ["APPLYING", "REVIEW_REQUIRED", "FAILED", "CANCELLED"],
  ACCEPTED: [],
  REVIEW_REQUIRED: [],
  FAILED: [],
  CANCELLED: [],
};

export const DEFAULT_MUTATION_LOCK_STALE_MS = 30 * 60 * 1000;

export type MutationLockOptions = {
  staleAfterMs?: number;
  now?: () => number;
  sessionId?: string;
  backend?: string;
};

type MutationLockRecord = {
  pid: number;
  created_at: string;
  session_id?: string;
  backend?: string;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockRecord(lockPath: string): Promise<MutationLockRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Partial<MutationLockRecord>;
    if (
      typeof record.pid !== "number" ||
      !Number.isInteger(record.pid) ||
      typeof record.created_at !== "string" ||
      Number.isNaN(Date.parse(record.created_at))
    ) {
      return undefined;
    }
    return {
      pid: record.pid,
      created_at: record.created_at,
      ...(record.session_id ? { session_id: record.session_id } : {}),
      ...(record.backend ? { backend: record.backend } : {}),
    };
  } catch {
    return undefined;
  }
}

function canReclaimLock(
  record: MutationLockRecord | undefined,
  now: number,
  staleAfterMs: number,
): boolean {
  if (!record || staleAfterMs < 0) return false;
  const ageMs = now - Date.parse(record.created_at);
  return ageMs >= staleAfterMs && !isProcessAlive(record.pid);
}

export async function acquireMutationLock(
  lockPath: string,
  options: MutationLockOptions = {},
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_MUTATION_LOCK_STALE_MS;
  const now = options.now ?? Date.now;
  const record: MutationLockRecord = {
    pid: process.pid,
    created_at: new Date(now()).toISOString(),
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return async () => {
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (handle) await handle.close();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`Unable to create mutation lock: ${lockPath}`, { cause: error });
      }
      const existing = await readLockRecord(lockPath);
      if (!canReclaimLock(existing, now(), staleAfterMs)) {
        const owner = existing
          ? `pid=${existing.pid}, created_at=${existing.created_at}`
          : "unknown owner";
        throw new Error(`Lightroom mutation lock is already held: ${lockPath} (${owner})`, {
          cause: error,
        });
      }
      await unlink(lockPath);
    }
  }
  throw new Error(`Unable to reclaim mutation lock safely: ${lockPath}`);
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
    await mkdir(join(dir, "evaluations"), { recursive: true });
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
