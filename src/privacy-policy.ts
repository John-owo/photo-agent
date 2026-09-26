import {
  PRIVACY_POLICY_VERSION,
  PrivacyPolicySchema,
  ProviderCapabilityManifestSchema,
  SessionPrivacyRecordSchema,
} from "./schemas.js";
import type { PrivacyPolicy, SessionPrivacy } from "./types.js";

export const DEFAULT_PRIVACY_POLICY = PrivacyPolicySchema.parse({
  schema_version: "0.1.0",
  policy_version: PRIVACY_POLICY_VERSION,
  local_only: true,
  allow_cloud_preview: false,
  allow_cloud_raw: false,
  allow_cloud_exif: false,
  allow_cloud_gps: false,
  preview_retention: "session",
});

const EPHEMERAL_RETENTION_ERROR =
  "Ephemeral preview retention is unsupported: PhotoAgent preserves image artifacts. " +
  'Start a new workflow with preview_retention: "session" explicitly; memory-only previews are not implemented.';

function assertSupportedPreviewRetention(policy: PrivacyPolicy): void {
  if (policy.preview_retention === "ephemeral") {
    throw new Error(EPHEMERAL_RETENTION_ERROR);
  }
}

/** Preserve the existing flag while allowing new callers to provide all boundaries explicitly. */
export function resolvePrivacyPolicy(
  policy: PrivacyPolicy | undefined,
  legacyAllowCloudPreview: boolean | undefined,
): PrivacyPolicy {
  if (policy === undefined) {
    const allowCloudPreview = legacyAllowCloudPreview ?? false;
    return PrivacyPolicySchema.parse({
      ...DEFAULT_PRIVACY_POLICY,
      local_only: !allowCloudPreview,
      allow_cloud_preview: allowCloudPreview,
    });
  }
  const parsed = PrivacyPolicySchema.parse(policy);
  assertSupportedPreviewRetention(parsed);
  if (
    legacyAllowCloudPreview !== undefined &&
    parsed.allow_cloud_preview !== legacyAllowCloudPreview
  ) {
    throw new Error("Privacy policy and --allow-cloud-preview disagree");
  }
  return parsed;
}

/** Reuse an existing session policy while honoring the legacy explicit cloud-preview consent. */
export function applyLegacyCloudPreviewConsent(
  policy: PrivacyPolicy,
  allowCloudPreview: boolean | undefined,
): PrivacyPolicy {
  const parsed = PrivacyPolicySchema.parse(policy);
  assertSupportedPreviewRetention(parsed);
  if (!allowCloudPreview) return parsed;
  return PrivacyPolicySchema.parse({
    ...parsed,
    local_only: false,
    allow_cloud_preview: true,
  });
}

export function sessionPrivacyPolicy(privacy: SessionPrivacy): PrivacyPolicy {
  return "policy" in privacy ? privacy.policy : DEFAULT_PRIVACY_POLICY;
}

export function buildSessionPrivacyRecord(
  policy: PrivacyPolicy,
  previewCloudTransfer = false,
): SessionPrivacy {
  return SessionPrivacyRecordSchema.parse({
    policy,
    raw_uploaded: false,
    exif_sent: false,
    gps_sent: false,
    preview_sanitized: true,
    preview_cloud_transfer: previewCloudTransfer,
  });
}

export function recordPreviewCloudTransfer(
  privacy: SessionPrivacy,
  previewCloudTransfer: boolean,
  policyOverride?: PrivacyPolicy,
): SessionPrivacy {
  const policy = policyOverride ?? ("policy" in privacy ? privacy.policy : DEFAULT_PRIVACY_POLICY);
  return SessionPrivacyRecordSchema.parse({
    ...privacy,
    policy,
    raw_uploaded: "raw_uploaded" in privacy ? privacy.raw_uploaded : false,
    exif_sent: "exif_sent" in privacy ? privacy.exif_sent : false,
    gps_sent: "gps_sent" in privacy ? privacy.gps_sent : false,
    preview_sanitized: true,
    preview_cloud_transfer: previewCloudTransfer,
  });
}

export function assertPrivacyPolicyAllowsCloudPreview(
  policy: PrivacyPolicy,
  required: boolean,
  subject: "provider" | "evaluator" | "shoot analyzer",
): void {
  assertSupportedPreviewRetention(policy);
  if (!required || policy.allow_cloud_preview) return;
  if (subject === "provider") {
    throw new Error("This provider requires --allow-cloud-preview; no image was sent");
  }
  if (subject === "evaluator") {
    throw new Error("This evaluator requires --allow-cloud-preview; no render was sent");
  }
  throw new Error("This shoot analyzer requires --allow-cloud-preview; no image was sent");
}

/** Fail closed before a provider call when any declared boundary exceeds policy. */
export function assertPrivacyPolicyAllowsProvider(
  policyInput: PrivacyPolicy,
  manifestInput: unknown,
  requiresCloudPreview: boolean,
): void {
  const policy = PrivacyPolicySchema.parse(policyInput);
  assertPrivacyPolicyAllowsCloudPreview(policy, requiresCloudPreview, "provider");
  if (manifestInput === undefined) return;

  const manifest = ProviderCapabilityManifestSchema.parse(manifestInput);
  if (manifest.requires_cloud_preview !== requiresCloudPreview) {
    throw new Error(
      `Privacy policy cannot trust provider ${manifest.provider_id}: cloud-preview declaration mismatch`,
    );
  }
  const crossings = {
    preview: manifest.data_boundary.preview === "sanitized_preview_to_cloud",
    raw: manifest.data_boundary.raw === "cloud",
    exif: manifest.data_boundary.exif === "cloud",
    gps: manifest.data_boundary.gps === "cloud",
  };
  const violations: string[] = [];
  if (crossings.preview && !policy.allow_cloud_preview) violations.push("cloud preview");
  if (crossings.raw && !policy.allow_cloud_raw) violations.push("cloud RAW");
  if (crossings.exif && !policy.allow_cloud_exif) violations.push("cloud EXIF");
  if (crossings.gps && !policy.allow_cloud_gps) violations.push("cloud GPS");
  if (policy.local_only && Object.values(crossings).some(Boolean)) {
    violations.push("local_only policy");
  }
  if (violations.length > 0) {
    throw new Error(
      `Privacy policy blocked provider ${manifest.provider_id}: ${violations.join(", ")}`,
    );
  }
}

/** @deprecated Preview deletion is unsupported; retained for an actionable legacy API error. */
export async function removeEphemeralPreviews(sessionDir: string): Promise<void> {
  void sessionDir;
  throw new Error(EPHEMERAL_RETENTION_ERROR);
}
