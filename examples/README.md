# v0.1 examples

After building, run the clean-clone smoke example. It creates synthetic files
in the OS temporary directory, exercises the documented single-photo CLI with
the mock provider/backend, checks the render artifact, verifies both source
fixtures are unchanged, and removes the temporary directory:

```powershell
npm.cmd run build
npm.cmd run example
```

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
