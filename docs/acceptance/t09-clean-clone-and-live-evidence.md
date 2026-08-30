# T09 clean-clone and live evidence pack

This document records the evidence boundary for PhotoAgent issue #14,
`[T09] Produce the v0.1 clean-clone and live evidence pack`. It deliberately
separates reproducible repository checks from Lightroom and human gates.

## Acceptance matrix

| Gate                                          | Status in this implementation pass | Evidence                                                                                                                          |
| --------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Clean-clone install, check, lint, test, build | Implemented                        | `.github/workflows/ci.yml` runs `npm ci`, `npm run check`, `npm run lint`, `npm test`, and `npm run build`.                       |
| Documented single-photo example               | Implemented                        | `npm run example` runs `examples/run-example.mjs` after build and includes a simulated interrupted-session recovery.              |
| Interrupted-session recovery                  | Implemented in smoke path          | The example creates an `APPLYING` session, runs `recover`, requires `REVIEW_REQUIRED`, and checks for a recovery report.          |
| Live Lightroom single-photo E2E               | Pending external/manual gate       | Must be run with Lightroom Classic and the intended MCP plug-in connected, using a non-critical photo.                            |
| Human inspection of the resulting render      | Pending external/manual gate       | Inspect the Lightroom-rendered `renderPath` and record the observed subject, framing, corruption, and relevant color limitations. |
| Preset export/re-import stability             | Experimental only                  | No stable preset claim is made until a real export and re-import round trip passes.                                               |

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

`npm run example` creates a non-delivery synthetic `.NEF` and a 1×1 JPEG in
the operating system temporary directory, invokes the built CLI with
`--backend mock --provider mock --apply --evaluator mock`, requires an
`ACCEPTED` result and a non-empty readable render, then creates an `APPLYING`
session and invokes the documented `recover` command. Recovery must return
`REVIEW_REQUIRED` with a JSON recovery artifact. The runner checks that the
source fixtures are byte-identical after both paths and removes the temporary
directory. The fixture RAW is only a non-empty extension-validated test file; it
is never presented as a real camera RAW or Lightroom proof.

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

## Current run boundary — 2026-08-30

The clean-clone path was implemented and locally verified. At the time this
pack was prepared, no Lightroom process was running and ports 58763/58764 were
not listening in the current environment. Therefore no Lightroom UI action,
live MCP request, catalog mutation, source mutation, render inspection, or
human visual acceptance is claimed by this pass. The prior read/render and
Workflow Copy artifacts remain historical evidence; they are not silently
relabelled as a PhotoAgent T09 end-to-end run.

The XMP fallback and any preset-export workflow remain experimental. A stable
preset claim requires a real export followed by import into a disposable
Lightroom/Camera Raw catalog and a read-back/render comparison.
