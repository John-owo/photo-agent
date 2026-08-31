import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BackendCompatibilityCaseSchema,
  BackendCompatibilityResultSchema,
  ControlGroupSuiteDiscoverySchema,
  REGRESSION_GATE_REGISTRY_VERSION,
  RegressionGateReportSchema,
  SCHEMA_VERSION,
  WorkflowRegressionEvidenceSchema,
} from "./schemas.js";
import { validateBackendCapabilityManifest } from "./backend-handshake.js";
import type {
  BackendCompatibilityCase,
  BackendCompatibilityResult,
  ControlGroupSuiteDiscovery,
  RegressionGateReport,
  WorkflowRegressionEvidence,
} from "./types.js";

export const CONTROL_GROUP_SUITE_REQUIREMENTS = [
  {
    ticket_id: "T30",
    control_group: "color-mixer",
    suite_path: "tests/next-tickets.test.ts",
    regression_marker: 'describe("T30 Color Mixer planning"',
    golden_vector_marker: "runTranslatorGoldenVectors",
  },
  {
    ticket_id: "T32",
    control_group: "tone-curve",
    suite_path: "tests/tone-curve.test.ts",
    regression_marker: 'describe("T32 structured tone-curve planning"',
    golden_vector_marker: "runToneCurveGoldenVectors",
  },
  {
    ticket_id: "T34",
    control_group: "detail",
    suite_path: "tests/detail.test.ts",
    regression_marker: 'describe("T34 scene-aware detail planning"',
    golden_vector_marker: "runDetailGoldenVectors",
  },
  {
    ticket_id: "T36",
    control_group: "optics-geometry",
    suite_path: "tests/optics-geometry.test.ts",
    regression_marker: 'describe("T36 context-safe optics and geometry planning"',
    golden_vector_marker: "runOpticsGoldenVectors",
  },
  {
    ticket_id: "T38",
    control_group: "finishing",
    suite_path: "tests/finishing.test.ts",
    regression_marker: 'describe("T38 finishing and framing planning"',
    golden_vector_marker: "runFinishingGoldenVectors",
  },
  {
    ticket_id: "T40",
    control_group: "color-grading",
    suite_path: "tests/color-grading.test.ts",
    regression_marker: 'describe("T40 modern Color Grading planning"',
    golden_vector_marker: "runColorGradingGoldenVectors",
  },
  {
    ticket_id: "T42",
    control_group: "existing-mask",
    suite_path: "tests/mask-adjustment.test.ts",
    regression_marker: 'describe("T42 existing-mask adjustment planning"',
    golden_vector_marker: "runMaskGoldenVectors",
  },
] as const;

/** Discover the existing control-group suites without copying their tests. */
export async function discoverControlGroupSuites(
  suiteRoot: string,
): Promise<ControlGroupSuiteDiscovery[]> {
  return Promise.all(
    CONTROL_GROUP_SUITE_REQUIREMENTS.map(async (requirement) => {
      const failures: string[] = [];
      let source: string | undefined;
      try {
        source = await readFile(resolve(suiteRoot, requirement.suite_path), "utf8");
      } catch (error) {
        failures.push(
          `${requirement.ticket_id}: unable to read ${requirement.suite_path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const sourceText = source ?? "";
      const discovered = source !== undefined;
      const regressionDiscovered = discovered && sourceText.includes(requirement.regression_marker);
      const goldenVectorsDiscovered =
        discovered && sourceText.includes(requirement.golden_vector_marker);
      if (discovered && !regressionDiscovered) {
        failures.push(`${requirement.ticket_id}: regression marker is missing`);
      }
      if (discovered && !goldenVectorsDiscovered) {
        failures.push(`${requirement.ticket_id}: golden-vector marker is missing`);
      }
      return ControlGroupSuiteDiscoverySchema.parse({
        ...requirement,
        discovered,
        regression_discovered: regressionDiscovered,
        golden_vectors_discovered: goldenVectorsDiscovered,
        failures,
      });
    }),
  );
}

export function assertControlGroupSuitesComplete(
  discoveries: readonly ControlGroupSuiteDiscovery[],
): void {
  const parsed = discoveries.map((discovery) => ControlGroupSuiteDiscoverySchema.parse(discovery));
  if (parsed.length !== CONTROL_GROUP_SUITE_REQUIREMENTS.length) {
    throw new Error(
      `Regression gate requires ${CONTROL_GROUP_SUITE_REQUIREMENTS.length} control-group suites`,
    );
  }
  const byTicket = new Map(parsed.map((discovery) => [discovery.ticket_id, discovery]));
  for (const requirement of CONTROL_GROUP_SUITE_REQUIREMENTS) {
    const discovery = byTicket.get(requirement.ticket_id);
    if (
      !discovery ||
      !discovery.discovered ||
      !discovery.regression_discovered ||
      !discovery.golden_vectors_discovered
    ) {
      throw new Error(
        `Regression gate is missing the complete ${requirement.ticket_id} ${requirement.control_group} suite`,
      );
    }
  }
}

export function runBackendCompatibilityCase(
  input: BackendCompatibilityCase,
): BackendCompatibilityResult {
  const parsed = BackendCompatibilityCaseSchema.parse(input);
  let observedOutcome: BackendCompatibilityResult["observed_outcome"] = "rejected";
  let reason = "Backend capability manifest was rejected";
  try {
    validateBackendCapabilityManifest(parsed.manifest, {
      expectedBackend: parsed.requirements.expected_backend,
      expectedVersion: parsed.requirements.expected_version,
      expectedTrustBoundary: parsed.requirements.expected_trust_boundary,
      requiredOperations: parsed.requirements.required_operations,
    });
    observedOutcome = "accepted";
    reason = "Manifest satisfied backend, trust, operation, and version requirements";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return BackendCompatibilityResultSchema.parse({
    case_id: parsed.case_id,
    adapter_id: parsed.adapter_id,
    expected_outcome: parsed.expected_outcome,
    observed_outcome: observedOutcome,
    passed: parsed.expected_outcome === observedOutcome,
    reason,
  });
}

/** Run compatibility cases without persisting manifests, credentials, or payloads. */
export function runBackendCompatibilityMatrix(
  cases: readonly BackendCompatibilityCase[],
): BackendCompatibilityResult[] {
  const seen = new Set<string>();
  return cases.map((input) => {
    const parsed = BackendCompatibilityCaseSchema.parse(input);
    if (seen.has(parsed.case_id)) {
      throw new Error(`Regression gate compatibility case may only appear once: ${parsed.case_id}`);
    }
    seen.add(parsed.case_id);
    return runBackendCompatibilityCase(parsed);
  });
}

/**
 * Build the common gate report from discovered group suites, compatibility
 * cases, and observable workflow evidence. Callers can assert the report to
 * make missing or failing inputs fail their full-suite command.
 */
export async function runRegressionGate(
  suiteRoot: string,
  compatibilityCases: readonly BackendCompatibilityCase[],
  workflowRegression: WorkflowRegressionEvidence,
): Promise<RegressionGateReport> {
  const suites = await discoverControlGroupSuites(suiteRoot);
  const compatibilityResults = runBackendCompatibilityMatrix(compatibilityCases);
  const workflow = WorkflowRegressionEvidenceSchema.parse(workflowRegression);
  const failures = suites.flatMap((suite) => suite.failures);
  for (const result of compatibilityResults) {
    if (!result.passed) failures.push(`${result.case_id}: ${result.reason}`);
  }
  if (!workflow.passed) failures.push(...workflow.failures);
  return RegressionGateReportSchema.parse({
    schema_version: SCHEMA_VERSION,
    regression_gate_registry_version: REGRESSION_GATE_REGISTRY_VERSION,
    passed: failures.length === 0,
    suites,
    compatibility_results: compatibilityResults,
    workflow_regression: workflow,
    failures,
  });
}

export function validateRegressionGateReport(report: unknown): RegressionGateReport {
  return RegressionGateReportSchema.parse(report);
}

export function assertRegressionGatePassed(report: unknown): void {
  const parsed = RegressionGateReportSchema.parse(report);
  if (!parsed.passed) {
    throw new Error(`Regression gate failed: ${parsed.failures.join("; ")}`);
  }
}
