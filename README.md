# photo-agent

Backend-agnostic AI photography workflow agent — v0.1-alpha.

This first version processes one explicit RAW/preview pair. It is designed to
prove the runtime, normalized edit contract, and Lightroom adapter boundary
before adding culling, batch work, or Style Memory.

## Install and verify

Requires Node.js 24+.

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

## Codex-local run (default)

The default provider does not call a visual-model API. It creates a local
handoff for the current Codex session. Codex can inspect the sanitized preview,
follow the `raw-photo-lightroom-preset` skill, optionally check a real
Lightroom/Camera Raw RAW render, and write a schema-validated intent file.

Start the handoff with an explicitly paired RAW/JPEG:

```powershell
node dist/src/cli.js edit-one `
  --raw 'C:\path\photo.NEF' `
  --preview 'C:\path\photo.JPG' `
  --backend mock `
  --provider codex
```

Read the emitted `codex-analysis-request.md`, inspect the referenced local
image in the active Codex session, and write `codex-intent.json` beside it.
Then resume the validated plan:

```powershell
node dist/src/cli.js resume `
  --session 'C:\path\to\.photo-agent\sessions\<session-id>' `
  --intent-file 'C:\path\to\.photo-agent\sessions\<session-id>\codex-intent.json' `
  --backend mock `
  --apply
```

Use `--backend lightroom` only with a confirmed local MCP connection and a
non-critical test photo. The handoff never uploads the RAW or EXIF/GPS data.

## Mock run

The mock path is safe for tests and does not contact OpenAI or Lightroom. Use
any explicitly paired RAW/JPEG files you are allowed to process:

```powershell
node dist/src/cli.js edit-one --raw 'C:\path\photo.NEF' --preview 'C:\path\photo.JPG' --backend mock --provider mock
```

## Optional API provider/backend run

OpenAI remains available only when explicitly selected. Use a non-critical photo
already imported into Lightroom. The preview is sanitized locally; the RAW is
never uploaded. Explicitly opt in to cloud preview transfer and mutation:

```powershell
$env:OPENAI_API_KEY = '...'
node dist/src/cli.js edit-one `
  --raw 'C:\path\photo.NEF' `
  --preview 'C:\path\photo.JPG' `
  --backend lightroom `
  --provider openai `
  --allow-cloud-preview `
  --apply
```

Set `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY` when the MCP entry is not at the local
default. The command writes all generated state and renders under the session
root; it never writes to the delivery folder or source photo.

See [AGENTS.md](AGENTS.md), [ROADMAP.md](ROADMAP.md), the active
[v0.1-alpha implementation record](docs/implementation/v0.1-alpha.md), and
[the Codex handoff contract](docs/codex-provider.md).
