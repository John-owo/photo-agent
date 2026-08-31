import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import {
  assertPrivacyPolicyAllowsCloudPreview,
  assertPrivacyPolicyAllowsProvider,
  DEFAULT_PRIVACY_POLICY,
  resolvePrivacyPolicy,
} from "../src/privacy-policy.js";
import {
  MOCK_PROVIDER_CAPABILITIES,
  MockProvider,
  OPENAI_PROVIDER_CAPABILITIES,
} from "../src/providers.js";
import { PrivacyPolicySchema } from "../src/schemas.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { runSinglePhoto } from "../src/workflow.js";

describe("T55 privacy policy runtime", () => {
  it("keeps local_only and the four cloud permissions mutually enforceable", () => {
    expect(() =>
      PrivacyPolicySchema.parse({
        ...DEFAULT_PRIVACY_POLICY,
        allow_cloud_preview: true,
      }),
    ).toThrow(/local_only/);
    expect(resolvePrivacyPolicy(undefined, false)).toMatchObject({
      local_only: true,
      allow_cloud_preview: false,
    });
    expect(resolvePrivacyPolicy(undefined, true)).toMatchObject({
      local_only: false,
      allow_cloud_preview: true,
      allow_cloud_raw: false,
      allow_cloud_exif: false,
      allow_cloud_gps: false,
    });
    expect(() =>
      resolvePrivacyPolicy(
        PrivacyPolicySchema.parse({
          ...DEFAULT_PRIVACY_POLICY,
          local_only: false,
          allow_cloud_preview: true,
        }),
        false,
      ),
    ).toThrow(/disagree/);
  });

  it.each([
    ["preview", "allow_cloud_preview", "cloud preview", true],
    ["raw", "allow_cloud_raw", "cloud RAW", false],
    ["exif", "allow_cloud_exif", "cloud EXIF", false],
    ["gps", "allow_cloud_gps", "cloud GPS", false],
  ] as const)("enforces the %s boundary independently", (boundary, policyKey, label, requires) => {
    const manifest = {
      ...(boundary === "preview" ? OPENAI_PROVIDER_CAPABILITIES : MOCK_PROVIDER_CAPABILITIES),
      requires_cloud_preview: requires,
      data_boundary: {
        ...(boundary === "preview"
          ? OPENAI_PROVIDER_CAPABILITIES.data_boundary
          : MOCK_PROVIDER_CAPABILITIES.data_boundary),
        ...(boundary === "preview" ? { preview: "sanitized_preview_to_cloud" } : {}),
        ...(boundary === "raw" ? { raw: "cloud" } : {}),
        ...(boundary === "exif" ? { exif: "cloud" } : {}),
        ...(boundary === "gps" ? { gps: "cloud" } : {}),
      },
    };
    expect(() =>
      assertPrivacyPolicyAllowsProvider(DEFAULT_PRIVACY_POLICY, manifest, requires),
    ).toThrow(boundary === "preview" ? /allow-cloud-preview|cloud preview/ : new RegExp(label));
    const allowedPolicy = PrivacyPolicySchema.parse({
      ...DEFAULT_PRIVACY_POLICY,
      local_only: false,
      [policyKey]: true,
    });
    expect(() =>
      assertPrivacyPolicyAllowsProvider(allowedPolicy, manifest, requires),
    ).not.toThrow();
  });

  it("refuses a cloud provider before ingest or provider execution", async () => {
    let calls = 0;
    const provider = {
      requiresCloudPreview: true,
      capabilities: OPENAI_PROVIDER_CAPABILITIES,
      analyze: async () => {
        calls += 1;
        return new MockProvider().analyze();
      },
    };
    await expect(
      runSinglePhoto({
        rawPath: "D:/photo/not-read.NEF",
        previewPath: "D:/photo/not-read.JPG",
        provider,
        backend: new MockBackend("D:/photo/not-read.NEF"),
        sessionRoot: join(tmpdir(), "photo-agent-t55-blocked"),
        apply: false,
      }),
    ).rejects.toThrow("allow-cloud-preview");
    expect(calls).toBe(0);
  });

  it("records an allowed preview crossing without credentials or secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-t55-cloud-"));
    const raw = join(root, "sample.NEF");
    const preview = join(root, "sample.JPG");
    await writeFile(raw, "synthetic raw fixture", "utf8");
    await writeFixtureJpeg(preview);
    const provider = {
      requiresCloudPreview: true,
      capabilities: OPENAI_PROVIDER_CAPABILITIES,
      analyze: async (sanitizedPreviewPath: string) => {
        expect(sanitizedPreviewPath).toContain("inputs");
        const result = await new MockProvider().analyze();
        return {
          ...result,
          metadata: { ...result.metadata, provider: "cloud-fixture", cloudPreview: true },
        };
      },
    };
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider,
      backend: new MockBackend(raw),
      sessionRoot: join(root, "sessions"),
      apply: false,
      privacyPolicy: PrivacyPolicySchema.parse({
        ...DEFAULT_PRIVACY_POLICY,
        local_only: false,
        allow_cloud_preview: true,
      }),
    });
    expect(result.manifest.privacy).toMatchObject({
      raw_uploaded: false,
      exif_sent: false,
      gps_sent: false,
      preview_cloud_transfer: true,
      policy: { allow_cloud_preview: true, allow_cloud_raw: false },
    });
    expect(result.manifest).not.toHaveProperty("credentials");
  });

  it("removes generated previews after an ephemeral local-only run", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-t55-ephemeral-"));
    const raw = join(root, "sample.NEF");
    const preview = join(root, "sample.JPG");
    await writeFile(raw, "synthetic raw fixture", "utf8");
    await writeFixtureJpeg(preview);
    const result = await runSinglePhoto({
      rawPath: raw,
      previewPath: preview,
      provider: new MockProvider(),
      backend: new MockBackend(raw),
      sessionRoot: join(root, "sessions"),
      apply: false,
      privacyPolicy: PrivacyPolicySchema.parse({
        ...DEFAULT_PRIVACY_POLICY,
        preview_retention: "ephemeral",
      }),
    });
    expect(result.manifest.privacy).toMatchObject({
      preview_sanitized: true,
      preview_cloud_transfer: false,
      policy: { preview_retention: "ephemeral", local_only: true },
    });
    await expect(access(join(result.sessionDir, "inputs", "analysis.jpg"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps evaluator cloud refusal separate from provider policy", () => {
    expect(() =>
      assertPrivacyPolicyAllowsCloudPreview(DEFAULT_PRIVACY_POLICY, true, "evaluator"),
    ).toThrow("evaluator requires --allow-cloud-preview");
  });
});
