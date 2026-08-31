import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MOCK_CAPABILITIES } from "../src/backends.js";
import {
  CONTROL_GROUP_SUITE_REQUIREMENTS,
  assertControlGroupSuitesComplete,
  assertRegressionGatePassed,
  discoverControlGroupSuites,
  runBackendCompatibilityMatrix,
  runRegressionGate,
} from "../src/regression-gate.js";
import type { BackendCompatibilityCase } from "../src/types.js";

const suiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function compatibilityCase(
  caseId: string,
  manifest: unknown,
  expectedOutcome: BackendCompatibilityCase["expected_outcome"],
  requirements: Partial<BackendCompatibilityCase["requirements"]> = {},
): BackendCompatibilityCase {
  return {
    case_id: caseId,
    adapter_id: "mock",
    manifest,
    expected_outcome: expectedOutcome,
    requirements: {
      expected_backend: "mock",
      expected_version: "0.1.0",
      expected_trust_boundary: MOCK_CAPABILITIES.trust_boundary,
      required_operations: ["read_current_edit"],
      ...requirements,
    },
  };
}

function workflowEvidence(passed = true) {
  return {
    run_id: "workflow-regression-001",
    passed,
    evidence: ["workflow.test.ts full observable regression"],
    failures: passed ? [] : ["workflow regression failed"],
  };
}

describe("T49 common regression and backend compatibility gate", () => {
  it("discovers all owned control-group suites without duplicating their tests", async () => {
    const discoveries = await discoverControlGroupSuites(suiteRoot);

    expect(discoveries).toHaveLength(CONTROL_GROUP_SUITE_REQUIREMENTS.length);
    expect(discoveries.every((discovery) => discovery.discovered)).toBe(true);
    expect(discoveries.every((discovery) => discovery.regression_discovered)).toBe(true);
    expect(discoveries.every((discovery) => discovery.golden_vectors_discovered)).toBe(true);
    expect(() => assertControlGroupSuitesComplete(discoveries)).not.toThrow();
  });

  it("checks backend capability, trust, operation, and major-version compatibility", () => {
    const cases = [
      compatibilityCase("mock-compatible", MOCK_CAPABILITIES, "accepted"),
      compatibilityCase(
        "wrong-trust",
        {
          ...MOCK_CAPABILITIES,
          trust_boundary: { ...MOCK_CAPABILITIES.trust_boundary, cloud: true },
        },
        "rejected",
      ),
      compatibilityCase("missing-operation", MOCK_CAPABILITIES, "rejected", {
        required_operations: ["operation-not-advertised"],
      }),
      compatibilityCase("wrong-major", { ...MOCK_CAPABILITIES, version: "1.0.0" }, "rejected"),
    ];
    const results = runBackendCompatibilityMatrix(cases);

    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.map((result) => result.observed_outcome)).toEqual([
      "accepted",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(results[0]).not.toHaveProperty("manifest");
  });

  it("passes the full gate when suites, compatibility cases, and workflow evidence pass", async () => {
    const report = await runRegressionGate(
      suiteRoot,
      [compatibilityCase("mock-compatible", MOCK_CAPABILITIES, "accepted")],
      workflowEvidence(),
    );

    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(() => assertRegressionGatePassed(report)).not.toThrow();
  });

  it("fails closed on missing suites, failing compatibility, or workflow evidence", async () => {
    const missingSuiteReport = await runRegressionGate(
      resolve(suiteRoot, "missing-suite-root"),
      [compatibilityCase("mock-compatible", MOCK_CAPABILITIES, "accepted")],
      workflowEvidence(),
    );
    expect(missingSuiteReport.passed).toBe(false);
    expect(() => assertRegressionGatePassed(missingSuiteReport)).toThrow(/Regression gate failed/);

    const failingCompatibilityReport = await runRegressionGate(
      suiteRoot,
      [
        compatibilityCase(
          "unexpected-acceptance",
          { ...MOCK_CAPABILITIES, version: "1.0.0" },
          "accepted",
        ),
      ],
      workflowEvidence(),
    );
    expect(failingCompatibilityReport.passed).toBe(false);
    expect(failingCompatibilityReport.failures[0]).toMatch(/unexpected-acceptance/);

    const failingWorkflowReport = await runRegressionGate(
      suiteRoot,
      [compatibilityCase("mock-compatible", MOCK_CAPABILITIES, "accepted")],
      workflowEvidence(false),
    );
    expect(failingWorkflowReport.passed).toBe(false);
    expect(failingWorkflowReport.failures).toContain("workflow regression failed");
  });
});
