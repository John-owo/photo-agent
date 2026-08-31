import { describe, expect, it } from "vitest";

import {
  CODEX_PROVIDER_CAPABILITIES,
  MOCK_PROVIDER_CAPABILITIES,
  MockProvider,
  OPENAI_PROVIDER_CAPABILITIES,
} from "../src/providers.js";
import {
  PROVIDER_ANALYSIS_CAPABILITY,
  assessProviderCapabilities,
  assertProviderSupportsCapabilities,
  getProviderCapabilityManifest,
  validateProviderResult,
} from "../src/provider-contract.js";
import { ProviderCapabilityManifestSchema } from "../src/schemas.js";
import type { AnalysisProvider } from "../src/types.js";

describe("T52 provider capability contract", () => {
  it("gives built-in providers explicit sparse capability manifests", () => {
    expect(MOCK_PROVIDER_CAPABILITIES.capabilities).toEqual(["analysis"]);
    expect(CODEX_PROVIDER_CAPABILITIES.data_boundary.preview).toBe("local_only");
    expect(OPENAI_PROVIDER_CAPABILITIES).toMatchObject({
      provider_id: "openai",
      requires_cloud_preview: true,
      data_boundary: {
        raw: "local_only",
        exif: "local_only",
        gps: "local_only",
        preview: "sanitized_preview_to_cloud",
      },
    });
    expect(getProviderCapabilityManifest(new MockProvider()).provider_id).toBe("mock");
  });

  it("fails closed for unsupported or invalid provider capabilities", () => {
    expect(
      assessProviderCapabilities(MOCK_PROVIDER_CAPABILITIES, [PROVIDER_ANALYSIS_CAPABILITY]),
    ).toMatchObject({ outcome: "READY", missing_capabilities: [] });
    expect(assessProviderCapabilities(MOCK_PROVIDER_CAPABILITIES, ["comparison"])).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      missing_capabilities: ["comparison"],
    });
    expect(assessProviderCapabilities({}, ["analysis"])).toMatchObject({
      provider_id: "unknown-provider",
      outcome: "REVIEW_REQUIRED",
      missing_capabilities: ["analysis"],
    });
    expect(() =>
      assertProviderSupportsCapabilities(MOCK_PROVIDER_CAPABILITIES, ["ranking"]),
    ).toThrow(/does not declare: ranking/);
  });

  it("does not call an undeclared provider before capability refusal", () => {
    let calls = 0;
    const provider = {
      requiresCloudPreview: false,
      analyze: async () => {
        calls += 1;
        return new MockProvider().analyze();
      },
    } as AnalysisProvider;

    expect(() => getProviderCapabilityManifest(provider)).toThrow(/manifest is required/);
    expect(calls).toBe(0);
  });

  it("validates generic structured results without provider payloads or credentials", async () => {
    const result = await new MockProvider().analyze();
    const validated = validateProviderResult(result);

    expect(validated.metadata.provider).toBe("mock");
    expect(validated).not.toHaveProperty("request");
    expect(validated).not.toHaveProperty("credentials");
    expect(() =>
      ProviderCapabilityManifestSchema.parse(OPENAI_PROVIDER_CAPABILITIES),
    ).not.toThrow();
  });
});
