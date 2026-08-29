# photo-agent

繁體中文文件：[README.zh-TW.md](README.zh-TW.md)。

## What is this?

`photo-agent` is a backend-agnostic AI photography workflow agent that turns one
explicit RAW/preview pair into a traceable `analyze → plan → apply → render`
session. It owns the workflow plus its safety and recovery boundaries;
`lightroom-mcp-john` is the external Lightroom MCP backend used to apply edits
and read back/render state, not the definition of the whole agent. The current
`0.3` alpha adds bounded closed-loop editing, shoot indexing, culling and
lighting review, representative orchestration, and guarded propagation on top
of the recoverable v0.1 workflow.

### Relationship to `lightroom-mcp`

| Repository                                                            | Owns                                                                                                                                   | Does not own                                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`John-owo/photo-agent`](https://github.com/John-owo/photo-agent)     | Workflow state, safety/recovery policy, semantic plans, closed-loop evaluation, culling, clustering, and shoot orchestration.          | Lightroom catalog transport or the Lightroom Classic plug-in.                         |
| [`John-owo/lightroom-mcp`](https://github.com/John-owo/lightroom-mcp) | The standalone MCP server and Lightroom Classic Lua plug-in: catalog reads/writes, develop settings, checkpoints, and renders/exports. | PhotoAgent's iteration policy, culling decisions, scene grouping, or batch job state. |

PhotoAgent was extracted from the earlier combined Lightroom fork during v0.1.
The dependency is one-way: PhotoAgent may use Lightroom MCP as one backend;
Lightroom MCP remains independently usable by any MCP client and does not depend
on PhotoAgent. The bundled `raw-photo-lightroom-preset` in the older fork is
historical workflow guidance; new workflow-engine development belongs here.

## Status: v0.3 alpha (`0.3.0-alpha.0` package version)

> **Alpha/testing only.** v0.2 and v0.3 automated gates pass, and one
> non-critical RAW completed a live Lightroom adapter read/render plus human
> visual check without a develop mutation. Subjective batch culling, live
> representative edits/propagation, and evaluator-to-human agreement remain
> unverified. Do not point this release at production photos or an
> irreplaceable photo library before reviewing it for your setup.

## Platform assumptions

All command examples below are written for Windows PowerShell. `npm.cmd`,
backslash paths, PowerShell environment-variable syntax, and backtick line
continuations are intentional. The Node.js CLI is not deliberately Windows-only,
but non-Windows Lightroom integration has not been validated for this alpha, so
Windows + PowerShell is the supported setup. For CLI/mock use on another
platform, replace `npm.cmd` with `npm`, adapt environment-variable syntax and
path separators, and set `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY` to a
platform-appropriate executable; treat Lightroom use there as unvalidated.

## Safety guarantees

- Never delete, rename, or overwrite any source photo, RAW file, sidecar,
  preview, or export file.
- RAW files and EXIF/GPS metadata are never uploaded. Cloud preview transfer is
  disabled unless `--allow-cloud-preview` is explicitly supplied, and only the
  locally sanitized preview is eligible for transfer.
- The default `--provider codex` path creates a local handoff and does not call
  a visual-model API. The OpenAI provider remains an explicit opt-in path.
- Never blindly retry a Lightroom mutation after a timeout. Read back backend
  state first; if reconciliation is uncertain, stop at `REVIEW_REQUIRED`.
- After an interruption, `recover` only reads back state and reconciles the
  session; it never retries a mutation automatically.
- A single-photo apply reads and verifies the Master first, then lazily creates
  one session-marked Workflow Copy only when apply is approved and the plan has
  an executable adjustment. Checkpoints, Develop mutation, read-back, and render
  target only the verified Copy. Dry runs and no-op plans create no Copy;
  Virtual Copy input or uncertain identity stops at `REVIEW_REQUIRED`.
- Before any backend read, checkpoint, mutation, or render on an apply/recover/
  propagation path, PhotoAgent performs a versioned MCP capability handshake.
  It derives the server version, advertised tools, trust boundary, and
  operation-semantics metadata from the connected server; incompatible majors,
  unexpected identity/trust, malformed manifests, and unsupported required
  operations fail closed. Automated coverage uses Mock and an in-memory fake
  MCP server; live Lightroom handshake acceptance remains unverified.
- XMP fallback writes a new sidecar and refuses to overwrite an existing
  sidecar or source file.
- `lightroom-mcp-john` is an external backend checkout; a photo workflow does
  not modify that checkout. Use a non-critical test photo for real Lightroom
  runs.

## Install and verify

Requires Node.js 24+.

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

## Environment variables

These four variables are the values documented by `.env.example`:

| Variable                          | Purpose                                                                                                            | Default                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `OPENAI_API_KEY`                  | Credential for an explicitly selected OpenAI provider, evaluator, or shoot analyzer when cloud preview is allowed. | Unset (empty)                                      |
| `PHOTO_AGENT_OPENAI_MODEL`        | Model name used by OpenAI analysis and evaluation paths.                                                           | `gpt-5.6-terra`                                    |
| `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY` | Executable entry for the local `lightroom-mcp-john` MCP server.                                                    | `D:\photo\lightroom-mcp-john\server\dist\index.js` |
| `PHOTO_AGENT_SESSION_ROOT`        | Root directory for generated session state and renders.                                                            | `.photo-agent\sessions`                            |

## v0.2/v0.3 commands

Run the deterministic closed loop against fixtures or a non-critical test pair:

```powershell
node dist\src\cli.js edit-one --raw <RAW> --preview <JPEG> --backend mock --provider mock --apply --evaluator mock --max-iterations 3
```

`--evaluator openai --allow-cloud-preview` replaces the mock evaluator with the
opt-in structured visual evaluator. The same consent flag is required when an
OpenAI evaluator is selected on `resume`. Only a fresh sanitized session JPEG is
eligible for transfer; no OpenAI request is made by the default or mock paths.

Create a conservative, read-only shoot report and resume the same durable job set:

```powershell
node dist\src\cli.js shoot --root <SHOOT_DIR> --session-root .photo-agent\shoots --analysis-file <REVIEW_JSON>
node dist\src\cli.js shoot --resume <SESSION_DIR> --analysis-file <REVIEW_JSON>
node dist\src\cli.js shoot --root <SHOOT_DIR> --session-root .photo-agent\shoots --analyzer openai --allow-cloud-preview
```

The optional review file contains schema-validated user/Codex culling and
lighting decisions and is mutually exclusive with `--analyzer openai`. Without
either opt-in source, every image remains `review`. The OpenAI analyzer uses one
structured request per preview asset and only a sanitized session copy. The
shoot command does not write ratings, labels, edits, or source files. See the [v0.2 record](docs/implementation/v0.2.md)
and [v0.3 record](docs/implementation/v0.3.md).

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

## Recover an interrupted session

If the process stops during a backend operation, reconcile the session before
running anything again. Recovery reads the current backend state and moves the
session to `REVIEW_REQUIRED`; it never retries a mutation automatically:

```powershell
node dist/src/cli.js recover `
  --session 'C:\path\to\.photo-agent\sessions\<session-id>' `
  --backend lightroom
```

## XMP fallback

For the supported global develop settings, export a new XMP sidecar from a
validated intent and an explicit current-settings snapshot. Existing files are
never overwritten:

```powershell
node dist/src/cli.js export-xmp `
  --raw 'C:\path\photo.NEF' `
  --intent-file examples\sample-intent.json `
  --current-settings examples\current-settings.json `
  --output .photo-agent\exports\photo.xmp
```

## References

- [AGENTS.md](AGENTS.md) — repository safety and development rules.
- [ROADMAP.md](ROADMAP.md) — project goals and milestones.
- [v0.1 implementation record](docs/implementation/v0.1.md).
- [v0.1–v0.3 direction](docs/implementation/v0.1-v0.3-direction.zh-TW.md).
- [Codex handoff contract](docs/codex-provider.md).
- [Examples](examples/README.md) — reproducible fixture commands.
- [MIT License](LICENSE).
- [NOTICE.md](NOTICE.md) — `lightroom-mcp-john` third-party provenance.
