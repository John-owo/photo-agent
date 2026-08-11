# photo-agent agent instructions

## Current milestone

Implement and harden `v0.1`: one explicit RAW/preview pair through
`analyze -> plan -> apply -> render`, with durable session state, safe recovery,
and the constrained XMP fallback. The default analysis route is a Codex-local
handoff; the full direction is in [ROADMAP.md](ROADMAP.md), the v0.1 status is
in [docs/implementation/v0.1.md](docs/implementation/v0.1.md), and the next
milestones are in [docs/implementation/v0.1-v0.3-direction.zh-TW.md](docs/implementation/v0.1-v0.3-direction.zh-TW.md).

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
- Use `recover` after an interrupted mutation; it only reads back state and
  never retries the mutation automatically.
- XMP fallback must create a new sidecar and refuse to overwrite an existing
  sidecar or source file.
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
