# T09 clean-clone and live evidence pack

This document records the evidence boundary for PhotoAgent issue #14,
`[T09] Produce the v0.1 clean-clone and live evidence pack`. It deliberately
separates reproducible repository checks from Lightroom and human gates.

## Acceptance matrix

| Gate                                          | Status in this implementation pass                 | Evidence                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Clean-clone install, check, lint, test, build | Implemented                                        | `.github/workflows/ci.yml` runs `npm ci`, `npm run check`, `npm run lint`, `npm test`, and `npm run build`.              |
| Documented single-photo example               | Implemented                                        | `npm run example` runs `examples/run-example.mjs` after build and includes a simulated interrupted-session recovery.     |
| Interrupted-session recovery                  | Implemented in smoke path and live controlled path | The example covers the simulated path; the live evidence below covers an actual process interruption and MCP disconnect. |
| Live Lightroom single-photo E2E               | Completed; human gate pending                      | A non-critical imported RAW was copied, mutated, read back, and rendered through the intended Lightroom MCP server.      |
| Human inspection of the resulting render      | Pending user                                       | The render is readable and the agent recorded its observable content; a human must still confirm the visual result.      |
| Preset export/re-import stability             | Experimental only                                  | No stable preset claim is made until a real export and re-import round trip passes.                                      |

## Final acceptance matrix — 2026-08-30

| Acceptance item                                                           | Result                              | Evidence boundary                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T09 AC1 — clean-clone CI and documented example                           | PASS                                | Hosted run [33316341500](https://github.com/John-owo/photo-agent/actions/runs/33316341500) passed install, check, lint, tests, build, and example for `codex/roadmap-t09` at `e7d3ba4`; the local detached clean clone also passed. |
| T09 AC2 — live Lightroom E2E, human render, and source preservation       | FAIL / BLOCKED (human gate pending) | Live mutation, Copy-to-Master validation, render creation, and source preservation passed; human render confirmation is still missing. See the local evidence index recorded below.                                                 |
| T09 AC3 — preset export boundary                                          | PASS with experimental limitation   | No stable preset guarantee is claimed; export → re-import → round-trip remains required before any preset compatibility claim.                                                                                                      |
| T08 code-level read-only recovery invariant                               | PASS                                | The reviewed implementation and automated tests keep recovery read-only and fail closed to `REVIEW_REQUIRED`.                                                                                                                       |
| T08 live recovery: exact Copy reuse, duplicate prevention, no blind retry | PASS (controlled interruption)      | PhotoAgent and its MCP child were actually interrupted after mutation/readback; two recoveries read the exact Copy, created no duplicate, and recorded `mutation_retried=false`.                                                    |

The matrix uses `FAIL / BLOCKED` where required evidence is absent; it does not
convert an unrun external or human gate into a pass.

## Reproducible clean-clone path

The CI job is intentionally small and uses no photo or provider credentials:

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run example
```

The first hosted run for the published branch completed successfully:
[CI run 33316341500](https://github.com/John-owo/photo-agent/actions/runs/33316341500).
Its only annotation was GitHub's Node.js 20 deprecation notice for the v4
checkout/setup actions; no job step failed.

`npm run example` creates a non-delivery synthetic `.NEF` and a 1×1 JPEG in a
per-run scratch directory under `_agent_workspace` for the configured worktree,
invokes the built CLI with `--backend mock --provider mock --apply --evaluator
mock`, requires an `ACCEPTED` result and a non-empty readable render, then
creates an `APPLYING` session and invokes the documented `recover` command.
Recovery must return `REVIEW_REQUIRED` with a JSON recovery artifact. The runner
checks that the source fixtures are byte-identical after both paths and removes
the per-run directory. Hosted CI sets `PHOTO_AGENT_EXAMPLE_ROOT` to its
ephemeral runner directory as a CI-only equivalent. The fixture RAW is only a
non-empty extension-validated test file; it is never presented as a real camera
RAW or Lightroom proof.

## Live Lightroom procedure

The live gate must be run as a separate, explicitly recorded action:

1. Choose an imported, non-critical RAW and an explicitly matching preview.
2. Record the RAW and matching preview hashes, sizes, creation/last-write
   timestamps, adjacent sidecar state, delivery-folder state, and the Master
   Develop read-back before the run.
3. Confirm that the intended Lightroom MCP plug-in is connected and that the
   backend handshake advertises the required operations.
4. Build the repository, then run the single-photo command with the Lightroom
   backend and an explicit apply choice. Keep the session and render under a
   disposable directory inside `_agent_workspace` only.
5. Read back the resulting Workflow Copy, checkpoint, Develop settings, and
   render. Do not treat `REVIEW_REQUIRED` caused by the absence of an evaluator
   as a failed safety result; it is the expected terminal state for a live
   run that only proves apply/read-back/render.
6. Inspect the rendered JPEG manually and record what was actually seen.
7. Re-check the original RAW and preview hashes, sizes, timestamps, sidecar
   state, delivery-folder state, and Master Develop settings. Any mismatch
   stops the acceptance and requires review.

Suggested safe command shape (replace placeholders with a verified pair):

```powershell
node dist\src\cli.js edit-one `
  --raw '<NON_CRITICAL_RAW>' `
  --preview '<MATCHING_PREVIEW>' `
  --backend lightroom `
  --provider mock `
  --apply `
  --session-root 'D:\photo\_agent_workspace\photo-jobs\t09-live'
```

This command shape uses the deterministic mock provider only for the semantic
plan. The Lightroom backend remains the real system under test. It may create
and modify a verified Workflow Copy; the source Master and its files must stay
unchanged. The command must not be run until Lightroom and the MCP connection
are actually confirmed in the current session.

## Live evidence record — 2026-08-30

The local audit index is
`D:\photo\_agent_workspace\lightroom\verification\t09-live-20260830-dsc5343\README.md`.
It contains the detailed session locations, hashes, catalog identities, and
recovery report summary without committing provider credentials or camera
serial data.

The live backend was the integration worktree's `server/dist/index.js`, and the
real Lightroom MCP handshake identified `lightroom-mcp-server` version
`0.10.0`. Direct `initialize`, `ping`, and catalog readback calls succeeded
while Lightroom Classic was running. The checked-in legacy `manual-test.mjs`
was not used as pass/fail evidence because its standalone hello message does
not match the active per-message authentication protocol.

The test asset was `DSC_5343.NEF` with an explicitly matching preview. The
Master was catalog ID `976310` and had one pre-existing virtual copy. The first
live run created exactly one T09 Copy, read back the Copy-to-Master relation and
the requested `Exposure2012=0` / `Contrast2012=14`, then exported one render.
The run ended `REVIEW_REQUIRED` because no visual evaluator was configured;
this is the expected safety result for this apply/readback/render-only gate.

The Master remained `is_virtual_copy=false` and its full exposed Develop state
was unchanged before and after the live run:

```text
WhiteBalance=As Shot; Temperature=4450; Tint=-13
Exposure2012=-0.2; Contrast2012=6
Highlights2012=-62; Shadows2012=51; Whites2012=6; Blacks2012=-20
Texture=0; Clarity2012=0; Dehaze=0; Vibrance=20; Saturation=5
```

The RAW's SHA-256, size, creation time, and last-write time matched before and
after. The matching preview also matched byte-for-byte and timestamp-for-
timestamp. The adjacent XMP sidecar was absent before and after. No RAW,
Master, or sidecar write was performed.

For the recovery gate, a second live run was actually terminated after
`set_develop_settings` completed and its Develop readback artifact was durable,
with the session in `RENDERING`. Lightroom's log recorded the subsequent
client socket close. Both subsequent `recover` invocations returned
`REVIEW_REQUIRED` with `evidence_status=consistent`, targeted the same Copy,
and read back `Exposure2012=0` / `Contrast2012=14`. Both recovery reports set
`copy_creation_retried=false` and `mutation_retried=false`. The final Master
readback showed exactly one additional Copy for this interrupted run and no
fourth Copy after the second recovery.

The render was non-empty and readable; the agent observed an intact squirrel
subject and no obvious corruption. Human visual acceptance remains pending,
so the live gate is not silently promoted to a complete AC2 pass. This was a
controlled real process interruption plus MCP disconnect, not a claim of a
spontaneous Lightroom application crash or an unreliable network fault.

## Current run boundary — 2026-08-30

The clean-clone path and hosted CI are green, and the live Lightroom gate has
now been run with the intended integration server. T09 AC2 remains blocked only
by the required human render confirmation. No PR was created and Issue #14
remains open.

The XMP fallback and any preset-export workflow remain
`experimental / not part of validated v0.1 guarantees`. A stable preset claim
requires a real export followed by import into a disposable Lightroom/Camera
Raw catalog and a read-back/render comparison.
