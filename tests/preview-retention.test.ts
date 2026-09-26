import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { createShootSession, resumeShootDryRun, runShootDryRun } from "../src/batch.js";
import { ingestPair } from "../src/ingest.js";
import { writeFixtureJpeg } from "../src/preview.js";
import {
  applyLegacyCloudPreviewConsent,
  DEFAULT_PRIVACY_POLICY,
  removeEphemeralPreviews,
  resolvePrivacyPolicy,
} from "../src/privacy-policy.js";
import { SessionStore } from "../src/runtime.js";
import { PrivacyPolicySchema } from "../src/schemas.js";
import { resumeCodexSession } from "../src/workflow.js";

const ephemeral = PrivacyPolicySchema.parse({
  ...DEFAULT_PRIVACY_POLICY,
  preview_retention: "ephemeral",
});

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    try {
      result[name] = (await readFile(join(root, name))).toString("base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
    }
  }
  return result;
}

describe("non-destructive preview retention", () => {
  it("keeps legacy policy readable without silently enabling execution", () => {
    expect(PrivacyPolicySchema.parse(ephemeral).preview_retention).toBe("ephemeral");
    expect(() => resolvePrivacyPolicy(ephemeral, undefined)).toThrow(/Ephemeral.*unsupported/);
    expect(() => applyLegacyCloudPreviewConsent(ephemeral, true)).toThrow(/Ephemeral.*unsupported/);
    expect(() => applyLegacyCloudPreviewConsent(ephemeral, false)).toThrow(
      /Ephemeral.*unsupported/,
    );
    expect(resolvePrivacyPolicy(DEFAULT_PRIVACY_POLICY, undefined)).toEqual(DEFAULT_PRIVACY_POLICY);
  });

  it.each(["create", "run"] as const)(
    "rejects direct shoot %s before indexing or creating session artifacts",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "photo-agent-retention-shoot-"));
      let calls = 0;
      const analyzer = {
        cull: async () => {
          calls += 1;
          throw new Error("analyzer must not run");
        },
        classify: async () => {
          calls += 1;
          throw new Error("analyzer must not run");
        },
      };
      const options = {
        shootRoot: join(root, "nonexistent-shoot"),
        sessionRoot: join(root, "sessions"),
        privacyPolicy: ephemeral,
      };
      await expect(
        entry === "create" ? createShootSession(options) : runShootDryRun({ ...options, analyzer }),
      ).rejects.toThrow(/Ephemeral.*unsupported/);
      expect(calls).toBe(0);
      await expect(access(options.sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses a legacy shoot resume without changing plan, previews, or jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-retention-resume-"));
    const shootRoot = join(root, "shoot");
    await mkdir(shootRoot);
    const { sessionDir, plan } = await createShootSession({
      shootRoot,
      sessionRoot: join(root, "sessions"),
    });
    await writeFile(
      join(sessionDir, "shoot-plan.json"),
      JSON.stringify({ ...plan, privacy_policy: ephemeral }),
    );
    await mkdir(join(sessionDir, "inputs"));
    await writeFile(join(sessionDir, "inputs", "preserved.jpg"), "synthetic protected preview", {
      flag: "wx",
    });
    const before = await snapshot(sessionDir);
    let calls = 0;
    const refused = async () => {
      calls += 1;
      throw new Error("analyzer must not run");
    };

    await expect(
      resumeShootDryRun({
        sessionDir,
        allowCloudPreview: true,
        analyzer: {
          cull: refused,
          classify: refused,
          validateAssets: () => {
            calls += 1;
          },
        },
      }),
    ).rejects.toThrow(/Ephemeral.*unsupported/);

    expect(calls).toBe(0);
    expect(await snapshot(sessionDir)).toEqual(before);
  });

  it("opens a legacy single-photo session but refuses resume before intent or backend access", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-retention-single-"));
    const raw = join(root, "sample.NEF");
    const preview = join(root, "sample.JPG");
    await writeFile(raw, "synthetic RAW fixture", { flag: "wx" });
    await writeFixtureJpeg(preview);
    const store = await SessionStore.create(
      join(root, "sessions"),
      await ingestPair(raw, preview),
      "mock",
      ephemeral,
    );
    await writeFile(join(store.dir, "inputs", "retained.jpg"), "synthetic retained preview", {
      flag: "wx",
    });
    const before = await snapshot(root);
    const reopened = await SessionStore.open(store.dir);
    expect(reopened.currentManifest.privacy).toMatchObject({
      policy: { preview_retention: "ephemeral" },
    });
    const backend = new MockBackend(raw);

    await expect(
      resumeCodexSession({
        sessionDir: store.dir,
        intentFile: join(root, "does-not-exist.json"),
        backend,
        apply: true,
        allowCloudPreview: false,
      }),
    ).rejects.toThrow(/Ephemeral.*unsupported/);

    expect(backend.calls).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("refuses legacy cleanup while retaining nested image evidence byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-retention-cleanup-"));
    for (const path of [
      "inputs/input.jpg",
      "renders/nested/preview.png",
      "evaluations/review.webp",
    ]) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `synthetic preserved bytes: ${path}`, { flag: "wx" });
    }
    const before = await snapshot(root);

    await expect(removeEphemeralPreviews(root)).rejects.toThrow(/Ephemeral.*unsupported/);

    expect(await snapshot(root)).toEqual(before);
  });
});
