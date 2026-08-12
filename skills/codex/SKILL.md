# photo-agent Codex handoff

This is a thin wrapper around the repository CLI. It does not implement a
second workflow and it must not upload RAW, EXIF, or GPS data.

1. Run `edit-one --provider codex` with one explicitly paired RAW and preview.
2. Read the generated `codex-analysis-request.md` in the active Codex session.
3. Inspect only the sanitized preview; use a local Lightroom/Camera Raw render
   for colour decisions when a confirmed local connection is available.
4. Write only the schema-validated `SemanticIntentPlan` to the requested
   `codex-intent.json` path.
5. Run `resume` and use `--backend lightroom --apply` only for a non-critical
   test photo after confirming the MCP connection.

If a process stops during a backend operation, use `recover` first. Recovery
reads the current backend state and moves the session to `REVIEW_REQUIRED`; it
never retries a mutation automatically.
