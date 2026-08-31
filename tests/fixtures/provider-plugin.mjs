export const manifest = {
  plugin_type: "provider",
  plugin_id: "fixture-provider",
  plugin_version: "0.2.0",
  core_api_version: "0.1.0",
  capabilities: ["analysis"],
  trust_boundary: {
    transport: "in-process fixture",
    authentication: "none",
    cloud: false,
  },
  operations: {
    analysis: {
      supported: true,
      side_effect: "read_only",
      idempotent: true,
      reversible: "true_undo",
      scope: "photo",
      requires_active_selection: false,
      requires_editor_foreground: false,
      concurrency: "parallel_safe",
      retry_policy: "automatic",
      safe_to_resume: true,
    },
  },
};

export function create() {
  return { kind: "fixture-provider" };
}
