import {
  PROVIDER_BENCHMARK_REGISTRY_VERSION,
  PhotoAgentBenchReportSchema,
  PrivacyPolicySchema,
  ProviderBenchmarkComparisonSchema,
  ProviderBenchmarkRunSchema,
  ProviderCapabilityManifestSchema,
  ProviderResultSchema,
  SCHEMA_VERSION,
  SessionPrivacyRecordSchema,
} from "./schemas.js";
import { assertPrivacyPolicyAllowsProvider } from "./privacy-policy.js";
import type { PrivacyPolicy, ProviderBenchmarkComparison, ProviderBenchmarkRun } from "./types.js";

type ProviderBenchmarkRunStatus = "completed" | "blocked" | "review_required";
type ProviderBenchmarkLatencyStatus = "reported" | "partial" | "unknown";
type ProviderBenchmarkCostStatus = "reported" | "unknown";
type ProviderBenchmarkSchemaStatus = "compatible" | "incompatible" | "not_observed";

export type ProviderBenchmarkSchemaCompatibilityInput = {
  status: ProviderBenchmarkSchemaStatus;
  checkedCaseCount: number;
  failures?: readonly string[];
};

/**
 * Input to the report materializer. The provider result is parsed for the
 * shared contract and then discarded; only normalized metadata is persisted.
 */
export type ProviderBenchmarkRunInput = {
  providerCapabilities: unknown;
  providerRequiresCloudPreview: boolean;
  providerResult: unknown;
  benchmarkReport: unknown;
  privacy: unknown;
  latencyMs?: readonly number[];
  latencyStatus?: ProviderBenchmarkLatencyStatus;
  estimatedCostUsd?: number;
  costStatus?: ProviderBenchmarkCostStatus;
  schemaCompatibility: ProviderBenchmarkSchemaCompatibilityInput;
  status: ProviderBenchmarkRunStatus;
  failures?: readonly string[];
  reviewOutcomes?: readonly string[];
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function samePrivacyPolicy(left: PrivacyPolicy, right: PrivacyPolicy): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.policy_version === right.policy_version &&
    left.local_only === right.local_only &&
    left.allow_cloud_preview === right.allow_cloud_preview &&
    left.allow_cloud_raw === right.allow_cloud_raw &&
    left.allow_cloud_exif === right.allow_cloud_exif &&
    left.allow_cloud_gps === right.allow_cloud_gps &&
    left.preview_retention === right.preview_retention
  );
}

function benchmarkIdentity(report: ReturnType<typeof PhotoAgentBenchReportSchema.parse>) {
  return {
    benchmark_registry_version: report.benchmark_registry_version,
    dataset_id: report.dataset_id,
    dataset_revision: report.dataset_revision,
    dataset_sha256: report.dataset_sha256,
    split_id: report.split_id,
    split_revision: report.split_revision,
    split_sha256: report.split_sha256,
  };
}

function sameBenchmarkIdentity(
  left: ReturnType<typeof benchmarkIdentity>,
  right: ReturnType<typeof benchmarkIdentity>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLatency(
  samples: readonly number[],
  status: ProviderBenchmarkLatencyStatus | undefined,
  population: number,
): { status: ProviderBenchmarkLatencyStatus; measured_ms: number[] } {
  const measured = [...samples];
  const resolvedStatus =
    status ??
    (measured.length === 0 ? "unknown" : measured.length === population ? "reported" : "partial");
  return { status: resolvedStatus, measured_ms: measured };
}

function resolveCost(
  estimatedCostUsd: number | undefined,
  status: ProviderBenchmarkCostStatus | undefined,
): { status: ProviderBenchmarkCostStatus; estimated_usd?: number } {
  const resolvedStatus = status ?? (estimatedCostUsd === undefined ? "unknown" : "reported");
  return {
    status: resolvedStatus,
    ...(estimatedCostUsd !== undefined ? { estimated_usd: estimatedCostUsd } : {}),
  };
}

/** Materialize one provider run while enforcing its active privacy boundary. */
export function buildProviderBenchmarkRun(input: ProviderBenchmarkRunInput): ProviderBenchmarkRun {
  const capabilities = ProviderCapabilityManifestSchema.parse(input.providerCapabilities);
  const providerResult = ProviderResultSchema.parse(input.providerResult);
  const benchmark = PhotoAgentBenchReportSchema.parse(input.benchmarkReport);
  const privacy = SessionPrivacyRecordSchema.parse(input.privacy);

  assertPrivacyPolicyAllowsProvider(
    privacy.policy,
    capabilities,
    input.providerRequiresCloudPreview,
  );
  if (providerResult.metadata.provider !== capabilities.provider_id) {
    throw new Error("Provider benchmark result does not match its capability manifest");
  }
  if (providerResult.metadata.cloudPreview !== capabilities.requires_cloud_preview) {
    throw new Error("Provider benchmark result cloud-preview metadata does not match its manifest");
  }
  if (privacy.preview_cloud_transfer !== providerResult.metadata.cloudPreview) {
    throw new Error("Provider benchmark privacy audit does not match the provider result");
  }

  const reliability = {
    population: benchmark.population,
    sample_size: benchmark.sample_size,
    pass_count: benchmark.pass_count,
    failure_count: benchmark.failure_count,
    review_required_count: benchmark.review_required_count,
    review_rate:
      benchmark.population === 0 ? 0 : benchmark.review_required_count / benchmark.population,
  };
  const schemaCompatibility = {
    status: input.schemaCompatibility.status,
    checked_case_count: input.schemaCompatibility.checkedCaseCount,
    failures: [...(input.schemaCompatibility.failures ?? [])],
  };
  const failures = unique([
    ...benchmark.failures,
    ...schemaCompatibility.failures,
    ...(input.failures ?? []),
  ]);
  const reviewOutcomes = unique([
    ...benchmark.review_outcomes,
    ...(input.reviewOutcomes ?? []),
    ...(schemaCompatibility.status === "not_observed"
      ? ["provider_schema_compatibility_not_observed"]
      : []),
  ]);

  return ProviderBenchmarkRunSchema.parse({
    schema_version: SCHEMA_VERSION,
    provider_benchmark_registry_version: PROVIDER_BENCHMARK_REGISTRY_VERSION,
    provider: {
      provider_id: capabilities.provider_id,
      model: providerResult.metadata.model,
      adapter_version: capabilities.adapter_version,
      prompt_version: providerResult.metadata.promptVersion,
      prompt_hash: providerResult.metadata.promptHash,
    },
    capabilities,
    benchmark,
    privacy,
    reliability,
    latency: resolveLatency(input.latencyMs ?? [], input.latencyStatus, benchmark.sample_size),
    cost: resolveCost(input.estimatedCostUsd, input.costStatus),
    schema_compatibility: schemaCompatibility,
    status: input.status,
    failures,
    review_outcomes: reviewOutcomes,
  });
}

/**
 * Compare the required OpenAI, Anthropic, and local runs over one benchmark
 * identity and one active privacy policy. This function never calls a model.
 */
export function buildProviderBenchmarkComparison(
  comparisonId: string,
  activePrivacyPolicyInput: unknown,
  inputs: readonly ProviderBenchmarkRunInput[],
): ProviderBenchmarkComparison {
  if (inputs.length === 0) throw new Error("Provider benchmark comparison needs provider runs");
  const activePrivacyPolicy = PrivacyPolicySchema.parse(activePrivacyPolicyInput);
  const runs = inputs.map(buildProviderBenchmarkRun);
  const identity = benchmarkIdentity(runs[0]!.benchmark);
  for (const [index, run] of runs.entries()) {
    if (!sameBenchmarkIdentity(benchmarkIdentity(run.benchmark), identity)) {
      throw new Error(`Provider benchmark run ${index} does not use the same benchmark identity`);
    }
    if (!samePrivacyPolicy(run.privacy.policy, activePrivacyPolicy)) {
      throw new Error(`Provider benchmark run ${index} does not use the active privacy policy`);
    }
  }

  const compatibilityStatus: ProviderBenchmarkSchemaStatus = runs.some(
    (run) => run.schema_compatibility.status === "incompatible",
  )
    ? "incompatible"
    : runs.some((run) => run.schema_compatibility.status === "not_observed")
      ? "not_observed"
      : "compatible";
  const compatibilityFailures = unique(
    runs.flatMap((run) =>
      run.schema_compatibility.failures.map((failure) => `${run.provider.provider_id}: ${failure}`),
    ),
  );
  const status: ProviderBenchmarkRunStatus = runs.some((run) => run.status === "blocked")
    ? "blocked"
    : runs.some((run) => run.status === "review_required") || compatibilityStatus !== "compatible"
      ? "review_required"
      : "completed";

  return ProviderBenchmarkComparisonSchema.parse({
    schema_version: SCHEMA_VERSION,
    provider_benchmark_registry_version: PROVIDER_BENCHMARK_REGISTRY_VERSION,
    comparison_id: comparisonId,
    benchmark_identity: identity,
    active_privacy_policy: activePrivacyPolicy,
    runs,
    schema_compatibility: {
      status: compatibilityStatus,
      checked_provider_count: runs.filter(
        (run) => run.schema_compatibility.status !== "not_observed",
      ).length,
      failures: compatibilityFailures,
    },
    status,
    failures: unique(runs.flatMap((run) => run.failures)),
    review_outcomes: unique(runs.flatMap((run) => run.review_outcomes)),
  });
}

export function validateProviderBenchmarkRun(run: unknown): ProviderBenchmarkRun {
  return ProviderBenchmarkRunSchema.parse(run);
}

export function validateProviderBenchmarkComparison(
  comparison: unknown,
): ProviderBenchmarkComparison {
  return ProviderBenchmarkComparisonSchema.parse(comparison);
}
