# v0.1 examples

After building, run the clean-clone smoke example. It creates synthetic files
in a per-run scratch directory under `_agent_workspace` for the configured
worktree, exercises the documented single-photo CLI with the mock
provider/backend, recovers a simulated interrupted session, checks the render
and recovery artifacts, verifies both source fixtures are unchanged, and
retains the per-run directory for inspection. Hosted CI sets `PHOTO_AGENT_EXAMPLE_ROOT` to its
ephemeral runner directory as the CI-only equivalent:

```powershell
npm.cmd run build
npm.cmd run example
```

Run the public plugin-contract example. It loads the community XMP backend
through the versioned manifest, creates a synthetic sidecar, checks that the
synthetic source is unchanged, and reports `REVIEW_REQUIRED` because this
backend cannot render or prove Camera Raw/Lightroom interpretation:

```powershell
npm.cmd run build
npm.cmd run example:plugin
```

The plugin example creates its scratch parent on first use and retains each
unique run directory, including failures. Its JSON result reports
`evidence_directory`; it never deletes the generated source or sidecar. Set
`PHOTO_AGENT_EXAMPLE_ROOT` to choose the parent. In the `D:\photo` workspace,
use a directory under `D:\photo\_agent_workspace\lightroom\verification`.

These JSON fixtures exercise the deterministic intent-to-parameter and XMP
fallback paths without shipping a RAW or preview photo in the repository.

```powershell
node dist/src/cli.js export-xmp `
  --raw 'C:\path\photo.NEF' `
  --intent-file examples\sample-intent.json `
  --current-settings examples\current-settings.json `
  --output .photo-agent\exports\photo.xmp
```

The output path must not already exist. The command never overwrites a source
RAW or an existing XMP sidecar. Inspect the generated sidecar in a disposable
Lightroom/Camera Raw test catalog before using it on a real photo.

The adapter manifest and loader contract are documented in
`docs/plugin-contract.md` and `docs/plugin-contract.zh-TW.md`. The reusable
community template is `examples/plugins/xmp-sidecar-plugin.mjs`.
