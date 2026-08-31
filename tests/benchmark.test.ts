import { describe, expect, it } from "vitest";

import {
  PHOTO_AGENT_BENCH_CONDITIONS,
  SCHEMA_VERSION,
  PHOTO_AGENT_BENCH_REGISTRY_VERSION,
} from "../src/schemas.js";
import {
  buildPhotoAgentBenchDataset,
  buildPhotoAgentBenchSplit,
  runPhotoAgentBench,
  runPhotoAgentBenchGoldenVectors,
} from "../src/benchmark.js";
import type {
  PhotoAgentBenchCase,
  PhotoAgentBenchCaseOutcome,
  PhotoAgentBenchDataset,
  PhotoAgentBenchSplit,
} from "../src/types.js";

const datasetSha256 = "a".repeat(64);
const splitSha256 = "b".repeat(64);

function benchmarkCase(
  caseId: string,
  shootId: string,
  condition: PhotoAgentBenchCase["condition"],
): PhotoAgentBenchCase {
  return {
    case_id: caseId,
    shoot_id: shootId,
    asset_id: `asset-${caseId}`,
    condition,
  };
}

function dataset(): PhotoAgentBenchDataset {
  const testCases = PHOTO_AGENT_BENCH_CONDITIONS.map((condition) =>
    benchmarkCase(`test-${condition}`, `shoot-${condition}`, condition),
  );
  return buildPhotoAgentBenchDataset("photoagent-bench", "dataset-r1", datasetSha256, [
    benchmarkCase("construction-reference", "construction-shoot", "portrait"),
    benchmarkCase("validation-reference", "validation-shoot", "landscape"),
    benchmarkCase("excluded-reference", "excluded-shoot", "street"),
    ...testCases,
  ]);
}

function split(): PhotoAgentBenchSplit {
  return buildPhotoAgentBenchSplit(
    "bench-split",
    "split-r1",
    splitSha256,
    ["construction-shoot"],
    ["validation-shoot"],
    PHOTO_AGENT_BENCH_CONDITIONS.map((condition) => `shoot-${condition}`),
    ["excluded-shoot"],
  );
}

function outcomes(): PhotoAgentBenchCaseOutcome[] {
  return [
    {
      case_id: "test-portrait",
      verdict: "pass",
      confidence: 0.9,
      evidence: ["fixture:portrait-reviewed"],
      failures: [],
      review_outcomes: [],
    },
    {
      case_id: "test-landscape",
      verdict: "fail",
      confidence: 0.8,
      evidence: ["fixture:landscape-mismatch"],
      failures: ["visual mismatch"],
      review_outcomes: [],
    },
    {
      case_id: "test-street",
      verdict: "review_required",
      confidence: 0.4,
      evidence: ["fixture:street-ambiguous"],
      failures: [],
      review_outcomes: ["human review required"],
    },
  ];
}

describe("T48 frozen versioned PhotoAgent Bench", () => {
  it("preserves every test case in the denominator and reports conditions", () => {
    const report = runPhotoAgentBench(dataset(), split(), "bench-run-001", outcomes());

    expect(report).toMatchObject({
      benchmark_registry_version: PHOTO_AGENT_BENCH_REGISTRY_VERSION,
      dataset_id: "photoagent-bench",
      dataset_revision: "dataset-r1",
      dataset_sha256: datasetSha256,
      split_id: "bench-split",
      split_revision: "split-r1",
      split_sha256: splitSha256,
      population: 10,
      sample_size: 10,
      pass_count: 1,
      failure_count: 1,
      review_required_count: 8,
    });
    expect(report.condition_coverage).toHaveLength(10);
    expect(report.condition_coverage.every((coverage) => coverage.population === 1)).toBe(true);
    expect(report.cases.map((benchmarkCase) => benchmarkCase.case_id)).not.toContain(
      "construction-reference",
    );
    expect(report.cases.map((benchmarkCase) => benchmarkCase.case_id)).not.toContain(
      "validation-reference",
    );
    expect(report.cases.map((benchmarkCase) => benchmarkCase.case_id)).not.toContain(
      "excluded-reference",
    );
    expect(report.failures).toEqual(["test-landscape: visual mismatch"]);
    expect(report.review_outcomes).toEqual(
      expect.arrayContaining(["human review required", "benchmark_case_outcome_missing"]),
    );
  });

  it("freezes shoot-level membership and rejects incomplete or overlapping splits", () => {
    expect(() =>
      buildPhotoAgentBenchSplit(
        "overlap",
        "r1",
        splitSha256,
        ["same-shoot"],
        ["same-shoot"],
        ["test-shoot"],
      ),
    ).toThrow(/may only appear once/);

    expect(() =>
      runPhotoAgentBench(
        dataset(),
        buildPhotoAgentBenchSplit(
          "incomplete",
          "r1",
          splitSha256,
          ["construction-shoot"],
          ["validation-shoot"],
          PHOTO_AGENT_BENCH_CONDITIONS.map((condition) => `shoot-${condition}`),
        ),
        "bench-run-002",
        [],
      ),
    ).toThrow(/assign each dataset shoot exactly once/);
  });

  it("rejects failed outcomes without evidence and keeps golden vectors isolated", () => {
    expect(() =>
      runPhotoAgentBench(dataset(), split(), "bench-run-003", [
        {
          case_id: "test-landscape",
          verdict: "fail",
          confidence: 0.1,
          evidence: ["fixture:failure"],
          failures: [],
          review_outcomes: [],
        },
      ]),
    ).toThrow(/require failure evidence/);

    const report = runPhotoAgentBench(dataset(), split(), "bench-vector-run", outcomes());
    const vector = {
      id: "bench-vector",
      control_group: "denominator",
      run_id: "bench-vector-run",
      dataset: dataset(),
      split: split(),
      outcomes: outcomes(),
      expected_report: report,
    };
    expect(runPhotoAgentBenchGoldenVectors([vector])[0]?.report).toEqual(report);
    expect(() => runPhotoAgentBenchGoldenVectors([vector, vector])).toThrow(
      /Duplicate PhotoAgent Bench golden vector/,
    );
  });

  it("keeps the dataset schema version explicit", () => {
    expect(dataset().schema_version).toBe(SCHEMA_VERSION);
    expect(dataset().benchmark_registry_version).toBe(PHOTO_AGENT_BENCH_REGISTRY_VERSION);
  });
});
