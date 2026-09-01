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
  session; it never retries a mutation automatically. It targets the persisted
  Workflow Copy catalog identity when one is known, writes a new immutable
  recovery report for each attempt, and retains operation and Checkpoint
  evidence for review.
- Ctrl-C/SIGTERM cancellation is durable: cancellation during read-only work
  ends in `CANCELLED`; cancellation after a backend side effect ends in
  `REVIEW_REQUIRED` and never silently retries the mutation. Backend lease
  release is recorded in the session.
- Normalized plans are self-describing: they persist the complete Parameter
  Registry snapshot, use an explicit registry version, and migrate legacy
  unversioned/`0.1.0`/`0.2.0` plans to `0.3.0` before translation or mutation.
  Color Mixer channels are refused unless the backend declares every setting;
  common translator golden-vector runners keep control-group expectations
  isolated.
- Structured Tone Curve planning uses a separate `0.1.0` registry for master,
  RGB point, and parametric curves, with bounded points, explicit mode conflicts,
  deterministic readback reconciliation, and shared golden vectors. Backends
  must declare every requested curve variant; curve propagation is disabled by
  policy until per-photo readback and rendered proof exist. The current adapter
  has no structured curve mutation method, so this is a planning/refusal
  boundary only.
- Scene-aware detail planning carries scene and ISO context and bounds
  sharpening/noise-reduction controls, with conservative dependency checks,
  deterministic readback helpers, and complete capability declarations. AI
  Denoise is intentionally absent; detail propagation remains disabled until
  per-photo evidence exists, and the current adapter has no detail mutation
  method.
- Context-safe optics planning keeps lens correction, camera profiles, and
  geometry as separate bounded operations. Profile names and geometry variants
  require explicit backend declarations, read/checkpoint/render prerequisites,
  and concrete setting support before any future write; propagation remains
  disabled and the current adapter has no structured optics mutation method.
- Finishing and framing planning keeps vignette, grain, crop, and rotation as
  separate bounded controls with structured geometry readback. Crop and
  rotation always carry an explicit per-photo human-review requirement;
  propagation is disabled until unrelated-state preservation is proven by a
  real backend.
- Modern Color Grading planning is process-version scoped: shadows, midtones,
  highlights, global wheels, blending, and balance are separate bounded
  control groups. Legacy split toning has no fallback path; backends must
  declare the requested process version, controls, concrete settings, and
  read/checkpoint/render prerequisites before execution can be considered.
  Propagation remains disabled and unsupported intent returns an explicit
  manual handoff.
- Existing-mask planning keeps Master inspection separate from one verified
  Workflow Copy adjustment. Selectors may use a stable mask id or a unique
  name, local parameters are allowlisted and bounded, and readback verifies
  geometry, opaque fields, other masks, and global settings are preserved.
  Unsupported or uncertain existing-mask state still returns a manual handoff;
  that planning contract is separate from the executable new-mask bridge.
- New-mask creation exposes a narrow `executeMaskCreation` bridge for one
  identity-verified Workflow Copy. The Lightroom adapter requires the exact
  `create-mask.v2` contract revision and mutation safety semantics before any
  catalog access, sends at most one `create_mask` call, and validates the
  returned identity, requested kind/settings/Brush geometry, checkpoint, and
  preservation evidence. Timeout and malformed post-operation results stop at
  `REVIEW_REQUIRED` without blind retry; bounded transport evidence and the
  operation ID are retained for reconciliation. This bridge is not yet wired
  into the full session orchestrator or automatic recovery flow.
- Style Prior planning gives protected explicit preference rules precedence
  over learned history, records rule evidence/sample counts/confidence, and
  falls back to general guidance with capped confidence when history is too
  small. Conflicting or evidence-free outcomes remain review-required.
- Style Memory retrieval uses a versioned dataset hash and scene-conditioned
  metadata matching across lighting, subject, camera, lens, ISO, and delivery.
  Optional perceptual profiles produce relationships rather than copied raw
  settings; protected natural-skin references, failed examples, irrelevant
  matches, and low-confidence history are excluded with explicit outcomes.
- Style Memory held-out evaluation freezes construction and held-out membership
  at the shoot level, retrieves only from construction shoots, excludes failed
  or context-incomplete held-out cases from scoring, and reports population,
  sample size, evidence confidence, failures, and review outcomes.
- The PhotoAgent Bench contract freezes dataset and split identities, requires
  portrait, landscape, street, night, event, backlight, mixed-light, high-ISO,
  architecture, and action coverage in the test split, and preserves failures
  and `REVIEW_REQUIRED` cases in the denominator. Missing case outcomes become
  `REVIEW_REQUIRED`; this contract does not claim a live visual benchmark run.
- The common regression gate discovers the T30/T32/T34/T36/T38/T40/T42 suites,
  checks that each retains its own regression and golden-vector tests, runs a
  backend compatibility matrix for capabilities, trust, operations, and major
  versions, and fails when workflow evidence or any required group is missing.
- Evaluator calibration keeps blinded randomized pairs, benchmark/dataset
  identity, provider/model, and human-label provenance explicit. Agreement,
  unacceptable-result, review, convergence, recovery, missing-label, and
  missing-observation metrics are reported without treating model output as
  human ground truth; real human calibration remains a separate acceptance
  gate.
- Provider adapters now expose a sparse, versioned capability manifest and a
  generic structured-result contract. Mock, Codex-local, and OpenAI analysis
  paths disclose their data boundary; unsupported comparison/ranking/planning/
  evaluation capabilities fail closed before provider execution, while the
  explicit OpenAI cloud-preview opt-in remains unchanged.
- The local-model experiment boundary accepts an injected local VLM runner that
  receives only the supplied sanitized-preview path, exposes analysis-only local
  capabilities, validates its structured intent, and records quality/latency/
  hardware limitations without inventing evidence. No local model runtime or
  quality result is claimed by this contract alone.
- Privacy policy is now a versioned runtime contract: `local_only`, cloud preview,
  RAW, EXIF, and GPS permissions are independent, provider boundary manifests are
  checked before ingest/provider execution, session manifests record only boolean
  crossings, and `ephemeral` retention removes generated preview images from the
  session after the workflow. Legacy `--allow-cloud-preview` remains an explicit
  preview-only compatibility path.
- The Anthropic adapter conforms to the shared structured provider contract and
  sends only a sanitized preview when cloud preview is explicitly allowed;
  provider payloads and credentials stay out of durable artifacts. Live Anthropic
  API and quality evidence remain unverified until an authorized experiment runs.
- Provider benchmark comparisons now require OpenAI, Anthropic, and the local
  experiment to use one frozen PhotoAgent Bench identity and one active privacy
  policy. Each run keeps provider/model and adapter/prompt versions, cost and
  latency status, schema compatibility, failures, review rate, and denominator
  metrics explicit; this contract does not claim that the three real runs have
  been executed.
- Third-party backend/provider plugins now use a strict versioned manifest and
  public `manifest`/`create()` module contract. Sparse capabilities are valid,
  but missing required operations, unexpected trust boundaries, and incompatible
  core API majors fail before the adapter is created. The XMP backend is a
  create-only example and records `REVIEW_REQUIRED` rather than visual
  acceptance.
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
npm.cmd ci
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run example
```

`npm.cmd run example` is the clean-clone smoke path. It generates synthetic
RAW/preview fixtures in a per-run scratch directory under `_agent_workspace`,
runs the documented single-photo workflow with the mock provider/backend,
recovers a simulated interrupted session, verifies an `ACCEPTED` result,
readable render, and recovery artifact, checks that both source fixtures remain
byte-identical, and removes the per-run directory. Hosted CI supplies its
ephemeral runner directory through `PHOTO_AGENT_EXAMPLE_ROOT`.

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

For the v0.1 clean-clone and live-evidence boundary, see [the T09 evidence pack](docs/acceptance/t09-clean-clone-and-live-evidence.md).

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

If Copy creation may have succeeded but no persistent Copy identity was
returned, recovery first reads the recorded Master, then calls the backend's
explicitly read-only `reconcile_workflow_copy` query with the same stable
operation ID and verifies that exactly one persistent Copy identity is returned.
If that read-only capability is unavailable or its evidence is insufficient,
recovery stops at `REVIEW_REQUIRED`; it never calls `create_virtual_copy` again.
When a Copy identity is already recorded, recovery reads that exact catalog ID
and verifies its UUID and Master relationship. Develop mutations and
Checkpoints are never retried. Each run writes a separate JSON report under
`recovery/`, leaving the original Copy, operation, Checkpoint, read-back, and
error artifacts intact. The report parses each iteration's operation intent,
Checkpoint, and saved read-back, then compares the last completed read-back to
the actual Copy state; missing evidence is `insufficient` and mismatches are
`contradictory`.

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
- [Plugin contract](docs/plugin-contract.md) — third-party adapter manifest,
  trust, capabilities, and fail-closed loading.
- [MIT License](LICENSE).
- [NOTICE.md](NOTICE.md) — `lightroom-mcp-john` third-party provenance.
