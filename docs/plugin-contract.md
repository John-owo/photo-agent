# PhotoAgent plugin contract

PhotoAgent plugins are admitted through a small, versioned manifest before a
workflow can use them. The same loader accepts `backend` and `provider`
plugins; a plugin may expose only the operations it really implements.

## Module shape

A plugin module exports two values:

```js
export const manifest = {
  plugin_type: "backend",
  plugin_id: "example-backend",
  plugin_version: "0.1.0",
  core_api_version: "0.1.0",
  capabilities: ["read_current_edit"],
  trust_boundary: {
    transport: "in-process fixture",
    authentication: "none",
    cloud: false,
  },
  operations: {
    read_current_edit: {
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
  return new ExampleBackend();
}
```

`plugin_version` identifies the adapter. `core_api_version` identifies the
PhotoAgent plugin API it was built against. The loader accepts the same core
API major version and rejects a different major before it invokes `create()`.
The manifest is strict: plugin type, versions, capabilities, trust boundary,
and operation semantics are all required.

## Sparse capabilities and fail-closed execution

Do not list an operation that the adapter cannot perform. Unsupported
operations may be absent from both `capabilities` and `operations`. Every
listed capability must have `supported: true` operation semantics. When a
workflow requires an operation that is absent, the loader stops with an
actionable error before the adapter factory is invoked:

```js
import { loadPluginFromPath } from "../dist/src/plugin-loader.js";

const plugin = await loadPluginFromPath("./my-plugin.mjs", {
  pluginType: "backend",
  expectedTrustBoundary: {
    transport: "in-process filesystem",
    authentication: "none",
    cloud: false,
  },
  requiredOperations: ["create_xmp_sidecar"],
});

const adapter = await plugin.create();
```

The caller chooses the expected trust boundary instead of trusting a plugin
to redefine it. `transport`, `authentication`, and `cloud` must match exactly.
Operation semantics describe side effects, reversibility, scope, concurrency,
retry policy, resume safety, and any supported setting allowlist. They are
authorization and safety data, not documentation-only metadata.

Backend plugins normally declare editor operations such as
`read_current_edit`, `create_checkpoint`, or `render_preview`. Provider
plugins can declare an operation such as `analysis` and should also publish the
shared provider capability/data-boundary manifest when they implement
`AnalysisProvider`. A provider or backend must not claim render, readback,
cloud, or mutation support merely because another adapter has it.

## Safety rules for adapters

- Keep source RAWs, previews, sidecars, and exports non-destructive. Create a
  new file or use an explicit backend checkpoint; never overwrite a source or
  pre-existing sidecar.
- Keep credentials, provider payloads, RAW data, EXIF, and GPS data out of
  durable PhotoAgent artifacts. Cloud preview transfer requires the active
  privacy policy and an explicitly allowed sanitized preview.
- If an adapter cannot render or read back an editor's interpretation, say so
  in its result/session artifact. Sidecar creation alone is
  `REVIEW_REQUIRED`, not visual acceptance.
- Never retry a non-idempotent mutation after an uncertain result without
  readback or manual review.

The checked-in community template and executable sample are
`examples/plugins/xmp-sidecar-plugin.mjs` and
`examples/run-plugin-example.mjs`. They use the production XMP backend and
synthetic files only.
