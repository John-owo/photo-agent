import { BackendCapabilityManifestSchema } from "./schemas.js";
import type { BackendAdapter, BackendCapabilityManifest } from "./types.js";

export const SINGLE_PHOTO_OPERATIONS = [
  "read_current_edit",
  "create_checkpoint",
  "apply_global_adjustment",
  "render_preview",
] as const;

export const RECOVERY_OPERATIONS = ["read_current_edit"] as const;

export const PROPAGATION_OPERATIONS = [
  "read_current_edit",
  "create_checkpoint",
  "apply_global_adjustment",
] as const;

export type BackendHandshakeRequirements = {
  expectedBackend: string;
  expectedVersion: string;
  expectedTrustBoundary: BackendCapabilityManifest["trust_boundary"];
  requiredOperations?: readonly string[];
};

function majorVersion(version: string): string {
  const match = /^(\d+)\./.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return match[1]!;
}

/**
 * Validate the backend's negotiated manifest at the trust boundary. This is
 * deliberately independent from adapter static defaults: callers must pass
 * the manifest returned by the backend handshake.
 */
export function validateBackendCapabilityManifest(
  value: unknown,
  requirements: BackendHandshakeRequirements,
): BackendCapabilityManifest {
  const parsed = BackendCapabilityManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Backend handshake rejected invalid capability manifest: ${parsed.error.message}`,
    );
  }
  if (parsed.data.backend !== requirements.expectedBackend) {
    throw new Error(
      `Backend handshake rejected wrong backend: expected ${requirements.expectedBackend}, received ${parsed.data.backend}`,
    );
  }
  if (majorVersion(parsed.data.version) !== majorVersion(requirements.expectedVersion)) {
    throw new Error(
      `Backend handshake rejected incompatible major version: expected ${requirements.expectedVersion}, received ${parsed.data.version}`,
    );
  }
  if (
    parsed.data.trust_boundary.transport !== requirements.expectedTrustBoundary.transport ||
    parsed.data.trust_boundary.authentication !==
      requirements.expectedTrustBoundary.authentication ||
    parsed.data.trust_boundary.cloud !== requirements.expectedTrustBoundary.cloud
  ) {
    throw new Error("Backend handshake rejected unexpected trust boundary");
  }
  if (requirements.requiredOperations) {
    assertBackendOperations(parsed.data, requirements.requiredOperations);
  }
  return parsed.data;
}

export function assertBackendOperations(
  manifest: BackendCapabilityManifest,
  requiredOperations: readonly string[],
): void {
  for (const operation of requiredOperations) {
    if (!manifest.capabilities.includes(operation)) {
      throw new Error(`Backend handshake rejected unsupported operation: ${operation}`);
    }
    const semantics = manifest.operations[operation];
    if (!semantics || semantics.supported !== true) {
      throw new Error(`Backend handshake rejected unsupported operation: ${operation}`);
    }
  }
}

export async function requireBackendHandshake(
  backend: BackendAdapter,
  requiredOperations: readonly string[],
): Promise<BackendCapabilityManifest> {
  return validateBackendCapabilityManifest(await backend.handshake(), {
    ...backend.handshakeRequirements,
    requiredOperations,
  });
}
