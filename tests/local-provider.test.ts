import { describe, expect, it } from "vitest";

import {
  LOCAL_PROVIDER_CAPABILITIES,
  LocalVisionLanguageProvider,
  buildLocalProviderExperimentReport,
} from "../src/local-provider.js";
import { assertProviderSupportsCapabilities } from "../src/provider-contract.js";

const intent = {
  schema_version: "0.1.0" as const,
  creative_goal: "local fixture",
  adjustments: [],
  overall_confidence: 0.9,
};

describe("T54 local-model provider boundary", () => {
  it("passes only a sanitized preview path to an injected local runner", async () => {
    const requests: Array<{ sanitizedPreviewPath: string; model: string }> = [];
    const provider = new LocalVisionLanguageProvider(async (request) => {
      requests.push(request);
      return intent;
    }, "local-fixture-vlm");

    const result = await provider.analyze("D:/photo/_agent_workspace/sanitized-preview.jpg");

    expect(provider.requiresCloudPreview).toBe(false);
    expect(provider.capabilities).toEqual(LOCAL_PROVIDER_CAPABILITIES);
    expect(requests).toEqual([
      {
        sanitizedPreviewPath: "D:/photo/_agent_workspace/sanitized-preview.jpg",
        model: "local-fixture-vlm",
      },
    ]);
    expect(result.metadata).toMatchObject({
      provider: "local-experimental",
      model: "local-fixture-vlm",
      cloudPreview: false,
    });
    expect(result).not.toHaveProperty("raw");
    expect(result).not.toHaveProperty("credentials");
  });

  it("refuses missing capabilities and invalid local output", async () => {
    expect(() =>
      assertProviderSupportsCapabilities(LOCAL_PROVIDER_CAPABILITIES, ["comparison"]),
    ).toThrow(/does not declare: comparison/);
    const provider = new LocalVisionLanguageProvider(async () => ({ invalid: true }));
    await expect(provider.analyze("sanitized-preview.jpg")).rejects.toThrow();
  });

  it("records a blocked experiment without inventing quality or latency", () => {
    const report = buildLocalProviderExperimentReport({
      schema_version: "0.1.0",
      local_provider_registry_version: "0.1.0",
      experiment_id: "local-vlm-blocked-001",
      provider_id: "local-experimental",
      model: "not-discovered",
      hardware_assumptions: ["GPU/runtime not verified"],
      cloud_image_transfer: false,
      population: 1,
      sample_size: 0,
      latency_ms: [],
      quality_evidence: [],
      reproducibility_limits: ["No local vision model service responded during this run"],
      status: "blocked",
      failures: ["Local model runtime discovery was unavailable"],
    });

    expect(report.sample_size).toBe(0);
    expect(report.quality_evidence).toEqual([]);
    expect(report.cloud_image_transfer).toBe(false);
  });
});
