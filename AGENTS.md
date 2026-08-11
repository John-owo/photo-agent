# photo-agent agent instructions

## Current milestone

Implement only `v0.1-alpha`: one explicit RAW/preview pair through
`analyze -> plan -> apply -> render`, with durable session state. The default
analysis route is a Codex-local handoff; the full
direction is in [ROADMAP.md](ROADMAP.md); the active checklist and acceptance
boundary are in [docs/implementation/v0.1-alpha.md](docs/implementation/v0.1-alpha.md).

## Non-negotiable safety

- Never delete, rename, or overwrite a photo, RAW, sidecar, preview, or export.
- Never send RAW files or EXIF/GPS metadata to a provider. Cloud preview use
  must be explicitly enabled and use a sanitized JPEG.
- Prefer `--provider codex`: it creates a local handoff and does not call a
  visual-model API. Resume only from a schema-validated `codex-intent.json`.
- Keep the OpenAI provider as an explicit opt-in compatibility path; never make
  it the default or imply that it ran during a Codex-local review.
- Never blindly retry a Lightroom mutation after a timeout; read back state
  first and escalate to `REVIEW_REQUIRED` when reconciliation is uncertain.
- Keep the existing `D:\photo\lightroom-mcp-john` checkout untouched. Use its
  configured server entry as an external MCP backend.
- Do not claim Lightroom connectivity or visual QA unless the current run
  actually performed it.

## Development

Run from this directory with `npm.cmd`:

```powershell
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Use the mock provider/backend for automated tests. A real Lightroom run is a
separate opt-in manual check and must use a non-critical test photo.
