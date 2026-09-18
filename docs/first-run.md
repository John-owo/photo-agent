# Try PhotoAgent without a photo library

PhotoAgent is an MIT-licensed, developer-oriented photography workflow CLI.
It records an edit plan, tool operations, read-back evidence, renders, and
recovery decisions. It is currently `0.3.0-alpha.0`.

## Run a synthetic example

Use Node.js 24+ and npm. These commands use Windows PowerShell:

```powershell
git clone https://github.com/John-owo/photo-agent.git
Set-Location photo-agent
npm.cmd ci
npm.cmd run build
npm.cmd run example
```

No Lightroom installation, API key, account, or personal photo is needed for
the example. npm downloads dependencies during installation. The example itself
uses a deterministic mock provider and backend, with no Lightroom or model API call.
On other platforms use `npm`; that does not establish Lightroom compatibility.

The runner prints JSON containing:

```json
{
  "example": "single-photo",
  "state": "ACCEPTED",
  "recovery_state": "REVIEW_REQUIRED",
  "source_preserved": true,
  "external_backend": false
}
```

It also prints a render path and the retained artifact directory. Inspect the
session's plan, operation evidence, and recovery report. The interrupted example
stops for review instead of repeating a mutation.

**This is a workflow demonstration, not an image-quality demonstration.** The
RAW fixture is synthetic and the preview is a 1×1 JPEG. `ACCEPTED` here is a mock
state, not a human judgment of a photograph. Keep the generated evidence if you
want to compare later runs.

## What has actually been validated?

The [T09 evidence pack](acceptance/t09-clean-clone-and-live-evidence.md) records
one live Lightroom single-photo run and controlled interruption recovery on
2026-08-30, including the user's `render PASS`. That result applies to the
recorded environment and case. It is not certification of another installation,
batch culling, representative propagation, or evaluator/human agreement.

For real editing, follow the [README](../README.md), explicitly configure and
check the Lightroom MCP backend, and use a non-critical test photo. Automated
Develop changes target an identity-verified Workflow Copy, not the Master.

## Common questions

- **Is this a Lightroom plug-in?** PhotoAgent is the workflow controller.
  [Lightroom MCP](https://github.com/John-owo/lightroom-mcp) is the separate
  server and Lightroom Classic plug-in used by the Lightroom backend.
- **Does “Codex-local” mean an offline visual model?** No. The default provider
  writes a handoff for a Codex session; it does not itself call a visual-model
  API. The separate client's processing and privacy settings still matter.
- **Does it replace creative judgment?** No. It exposes plans and evidence for
  inspection. Batch quality and evaluator/human agreement remain unverified.
- **Is Photoshop supported?** No Photoshop backend is documented in this release.
- **Can I install it from npm?** Use the source checkout above; this package is
  marked private and is not presented as an npm release.

## Give useful feedback

Open a [GitHub issue](https://github.com/John-owo/photo-agent/issues/new) with:

1. Your goal and the step where the workflow became unclear or failed.
2. Commit/version, OS, Node version, and provider/backend selection.
3. Expected versus observed behavior, including the terminal state.
4. A minimal reproduction with synthetic inputs where possible.

Do not attach API keys, private catalog paths, RAW files, client photos, or
location metadata. Review and redact logs before sharing them. A useful first
contribution is reproducing this example on another supported Node environment,
improving an unclear installation step, or supplying a minimal recovery bug case.
