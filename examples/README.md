# v0.1 examples

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
