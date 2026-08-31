import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_PROVIDER_CAPABILITIES,
  ANTHROPIC_PROMPT_VERSION,
} from "../src/anthropic-provider.js";
import {
  buildPhotoAgentBenchDataset,
  buildPhotoAgentBenchSplit,
  runPhotoAgentBench,
} from "../src/benchmark.js";
import { LOCAL_PROVIDER_CAPABILITIES, LOCAL_PROMPT_VERSION } from "../src/local-provider.js";
import { PHOTO_AGENT_BENCH_CONDITIONS, SCHEMA_VERSION } from "../src/schemas.js";
import { OPENAI_PROVIDER_CAPABILITIES, PROMPT_VERSION } from "../src/providers.js";
import {
  buildProviderBenchmarkComparison,
  buildProviderBenchmarkRun,
} from "../src/provider-benchmark.js";
import type { ProviderBenchmarkRunInput } from "../src/provider-benchmark.js";

const cloudPolicy = {
  schema_version: SCHEMA_VERSION,
  policy_version: "0.1.0" as const,
  local_only: false,
  allow_cloud_preview: true,
  allow_cloud_raw: false,
  allow_cloud_exif: false,
  allow_cloud_gps: false,
  preview_retention: "session" as const,
};

const intent = {
  schema_version: SCHEMA_VERSION,
  creative_goal: "benchmark fixture",
  adjustments: [],
  overall_confidence: 0.9,
};

const testSampleSize = PHOTO_AGENT_BENCH_CONDITIONS.length;

function benchmarkReport() {
  const cases = [
    {
      case_id: "construction-reference",
      shoot_id: "construction-shoot",
      asset_id: "asset-construction",
      condition: "portrait" as const,
    },
    {
      case_id: "validation-reference",
      shoot_id: "validation-shoot",
      asset_id: "asset-validation",
      condition: "landscape" as const,
    },
    {
      case_id: "excluded-reference",
      shoot_id: "excluded-shoot",
      asset_id: "asset-excluded",
      condition: "street" as const,
    },
    ...PHOTO_AGENT_BENCH_CONDITIONS.map((condition, index) => ({
      case_id: `case-${condition}`,
      shoot_id: `shoot-${condition}`,
      asset_id: `asset-${index}`,
      condition,
    })),
  ];
  const dataset = buildPhotoAgentBenchDataset(
    "photoagent-bench",
    "dataset-r1",
    "a".repeat(64),
    cases,
  );
  const split = buildPhotoAgentBenchSplit(
    "bench-split",
    "split-r1",
    "b".repeat(64),
    ["construction-shoot"],
    ["validation-shoot"],
    PHOTO_AGENT_BENCH_CONDITIONS.map((condition) => `shoot-${condition}`),
    ["excluded-shoot"],
  );
  return runPhotoAgentBench(dataset, split, "provider-benchmark-fixture", [
    {
      case_id: "case-street",
      verdict: "pass",
      confidence: 0.9,
      evidence: ["fixture:structured-result"],
      failures: [],
      review_outcomes: [],
    },
  ]);
}

function providerResult(
  provider: string,
  model: string,
  cloudPreview: boolean,
  promptVersion: string,
) {
  return {
    intent,
    metadata: {
      provider,
      model,
      promptVersion,
      promptHash: "c".repeat(64),
      cloudPreview,
    },
  };
}

function runInput(
  providerId: string,
  capabilities: unknown,
  model: string,
  cloudPreview: boolean,
  promptVersion: string,
  latencyMs: number[],
  estimatedCostUsd?: number,
): ProviderBenchmarkRunInput {
  return {
    providerCapabilities: capabilities,
    providerRequiresCloudPreview: cloudPreview,
    providerResult: providerResult(providerId, model, cloudPreview, promptVersion),
    benchmarkReport: benchmarkReport(),
    privacy: {
      policy: cloudPolicy,
      raw_uploaded: false,
      exif_sent: false,
      gps_sent: false,
      preview_sanitized: true,
      preview_cloud_transfer: cloudPreview,
    },
    latencyMs,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    schemaCompatibility: {
      status: "compatible",
      checkedCaseCount: testSampleSize,
    },
    status: "completed",
  };
}

describe("T56 provider benchmark comparison contract", () => {
  it("compares the required providers on one benchmark and preserves denominators", () => {
    const comparison = buildProviderBenchmarkComparison("comparison-001", cloudPolicy, [
      runInput(
        "openai",
        OPENAI_PROVIDER_CAPABILITIES,
        "gpt-fixture",
        true,
        PROMPT_VERSION,
        Array.from({ length: testSampleSize }, (_, index) => 100 + index),
        0.02,
      ),
      runInput(
        "anthropic",
        ANTHROPIC_PROVIDER_CAPABILITIES,
        "claude-fixture",
        true,
        ANTHROPIC_PROMPT_VERSION,
        Array.from({ length: testSampleSize }, (_, index) => 120 + index),
        0.03,
      ),
      runInput(
        "local-experimental",
        LOCAL_PROVIDER_CAPABILITIES,
        "local-fixture",
        false,
        LOCAL_PROMPT_VERSION,
        Array.from({ length: testSampleSize }, (_, index) => 80 + index),
        0,
      ),
    ]);

    expect(comparison.status).toBe("completed");
    expect(comparison.schema_compatibility).toEqual({
      status: "compatible",
      checked_provider_count: 3,
      failures: [],
    });
    expect(comparison.runs.map((run) => run.provider.provider_id)).toEqual([
      "openai",
      "anthropic",
      "local-experimental",
    ]);
    expect(comparison.runs[0]?.reliability).toMatchObject({
      population: testSampleSize,
      sample_size: testSampleSize,
      pass_count: 1,
      failure_count: 0,
      review_required_count: testSampleSize - 1,
      review_rate: (testSampleSize - 1) / testSampleSize,
    });
    expect(comparison.runs.map((run) => run.cost.estimated_usd)).toEqual([0.02, 0.03, 0]);
    expect(comparison.runs.every((run) => run.privacy.policy.allow_cloud_raw === false)).toBe(true);
  });

  it("refuses a cloud provider before report materialization under local-only policy", () => {
    expect(() =>
      buildProviderBenchmarkRun({
        ...runInput(
          "anthropic",
          ANTHROPIC_PROVIDER_CAPABILITIES,
          "claude-fixture",
          true,
          ANTHROPIC_PROMPT_VERSION,
          [],
          0.03,
        ),
        privacy: {
          policy: {
            ...cloudPolicy,
            local_only: true,
            allow_cloud_preview: false,
          },
          raw_uploaded: false,
          exif_sent: false,
          gps_sent: false,
          preview_sanitized: true,
          preview_cloud_transfer: false,
        },
      }),
    ).toThrow(/requires --allow-cloud-preview/);
  });

  it("keeps incomplete local evidence reviewable and rejects mixed benchmark identities", () => {
    const blockedLocal: ProviderBenchmarkRunInput = {
      ...runInput(
        "local-experimental",
        LOCAL_PROVIDER_CAPABILITIES,
        "local-fixture",
        false,
        LOCAL_PROMPT_VERSION,
        [],
        undefined,
      ),
      costStatus: "unknown",
      schemaCompatibility: {
        status: "not_observed",
        checkedCaseCount: 0,
      },
      status: "blocked",
      failures: ["local model runtime unavailable"],
      reviewOutcomes: ["quality and latency not observed"],
    };
    const comparison = buildProviderBenchmarkComparison("comparison-blocked", cloudPolicy, [
      runInput(
        "openai",
        OPENAI_PROVIDER_CAPABILITIES,
        "gpt-fixture",
        true,
        PROMPT_VERSION,
        Array.from({ length: testSampleSize }, () => 100),
        0.02,
      ),
      runInput(
        "anthropic",
        ANTHROPIC_PROVIDER_CAPABILITIES,
        "claude-fixture",
        true,
        ANTHROPIC_PROMPT_VERSION,
        Array.from({ length: testSampleSize }, () => 120),
        0.03,
      ),
      blockedLocal,
    ]);
    expect(comparison.status).toBe("blocked");
    expect(comparison.schema_compatibility.status).toBe("not_observed");
    expect(comparison.runs[2]?.latency).toEqual({ status: "unknown", measured_ms: [] });
    expect(comparison.runs[2]?.cost).toEqual({ status: "unknown" });
    expect(comparison.runs[2]?.failures).toContain("local model runtime unavailable");

    const mismatchedReport = { ...benchmarkReport(), dataset_revision: "dataset-other" };
    expect(() =>
      buildProviderBenchmarkComparison("comparison-mismatch", cloudPolicy, [
        runInput(
          "openai",
          OPENAI_PROVIDER_CAPABILITIES,
          "gpt-fixture",
          true,
          PROMPT_VERSION,
          Array.from({ length: testSampleSize }, () => 100),
          0.02,
        ),
        {
          ...runInput(
            "anthropic",
            ANTHROPIC_PROVIDER_CAPABILITIES,
            "claude-fixture",
            true,
            ANTHROPIC_PROMPT_VERSION,
            Array.from({ length: testSampleSize }, () => 120),
            0.03,
          ),
          benchmarkReport: mismatchedReport,
        },
        runInput(
          "local-experimental",
          LOCAL_PROVIDER_CAPABILITIES,
          "local-fixture",
          false,
          LOCAL_PROMPT_VERSION,
          Array.from({ length: testSampleSize }, () => 80),
          0,
        ),
      ]),
    ).toThrow(/same benchmark identity/);
  });
});
