import { readdir, unlink } from "node:fs/promises";
import { extname, join } from "node:path";

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
  if (!allowCloudPreview) return PrivacyPolicySchema.parse(policy);
  return PrivacyPolicySchema.parse({
    ...policy,
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

async function removePreviewFiles(root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removePreviewFiles(path);
      continue;
    }
    if (
      entry.isFile() &&
      [".jpg", ".jpeg", ".png", ".webp"].includes(extname(entry.name).toLowerCase())
    ) {
      await unlink(path);
    }
  }
}

/** Remove generated session previews for ephemeral retention; source paths are never traversed. */
export async function removeEphemeralPreviews(sessionDir: string): Promise<void> {
  await Promise.all(
    ["inputs", "renders", "evaluations"].map((directory) =>
      removePreviewFiles(join(sessionDir, directory)),
    ),
  );
}
