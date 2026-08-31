import {
  ProviderCapabilityAssessmentSchema,
  ProviderCapabilityManifestSchema,
  ProviderCapabilityRequirementsSchema,
  ProviderResultSchema,
} from "./schemas.js";
import type {
  AnalysisProvider,
  ProviderCapability,
  ProviderCapabilityAssessment,
  ProviderCapabilityManifest,
  ProviderCapabilityRequirements,
  ProviderResult,
} from "./types.js";

export const PROVIDER_ANALYSIS_CAPABILITY = "analysis" as const;

function providerIdFromUnknown(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "provider_id" in value &&
    typeof value.provider_id === "string" &&
    value.provider_id.length > 0
  ) {
    return value.provider_id;
  }
  return "unknown-provider";
}

export function validateProviderCapabilityManifest(manifest: unknown): ProviderCapabilityManifest {
  return ProviderCapabilityManifestSchema.parse(manifest);
}

export function validateProviderCapabilityRequirements(
  requirements: unknown,
): ProviderCapabilityRequirements {
  return ProviderCapabilityRequirementsSchema.parse(requirements);
}

export function validateProviderResult(result: unknown): ProviderResult {
  return ProviderResultSchema.parse(result);
}

/** Return a review outcome instead of inventing support for an absent capability. */
export function assessProviderCapabilities(
  manifest: unknown,
  requiredCapabilities: readonly ProviderCapability[],
): ProviderCapabilityAssessment {
  const requirements = ProviderCapabilityRequirementsSchema.parse({
    required_capabilities: [...requiredCapabilities],
  });
  const parsedManifest = ProviderCapabilityManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    return ProviderCapabilityAssessmentSchema.parse({
      schema_version: "0.1.0",
      provider_id: providerIdFromUnknown(manifest),
      required_capabilities: requirements.required_capabilities,
      missing_capabilities: requirements.required_capabilities,
      outcome: "REVIEW_REQUIRED",
      reason: "Provider capability manifest is invalid or unavailable",
    });
  }
  const missingCapabilities = requirements.required_capabilities.filter(
    (capability) => !parsedManifest.data.capabilities.includes(capability),
  );
  return ProviderCapabilityAssessmentSchema.parse({
    schema_version: "0.1.0",
    provider_id: parsedManifest.data.provider_id,
    required_capabilities: requirements.required_capabilities,
    missing_capabilities: missingCapabilities,
    outcome: missingCapabilities.length === 0 ? "READY" : "REVIEW_REQUIRED",
    reason:
      missingCapabilities.length === 0
        ? "Provider declares every requested capability"
        : `Provider does not declare: ${missingCapabilities.join(", ")}`,
  });
}

/** Fail before a provider call when the declared capability set is insufficient. */
export function assertProviderSupportsCapabilities(
  manifest: unknown,
  requiredCapabilities: readonly ProviderCapability[],
): void {
  const assessment = assessProviderCapabilities(manifest, requiredCapabilities);
  if (assessment.outcome !== "READY") {
    throw new Error(
      `Provider capability check failed for ${assessment.provider_id}: ${assessment.reason}`,
    );
  }
}

export function getProviderCapabilityManifest(
  provider: AnalysisProvider,
): ProviderCapabilityManifest {
  if (!provider.capabilities) {
    throw new Error("Provider capability manifest is required before non-analysis execution");
  }
  return validateProviderCapabilityManifest(provider.capabilities);
}
