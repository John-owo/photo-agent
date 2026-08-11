# Codex-local provider contract

`CodexProvider` is the no-API analysis route for this alpha. The CLI does not
start another Codex process and does not upload an image. It creates a durable
session handoff so the active Codex session can run the local
`raw-photo-lightroom-preset` skill and return a small, auditable JSON artifact.

## Flow

1. Run `edit-one --provider codex` with one explicit RAW/preview pair.
2. The session writes `inputs/analysis.jpg`, `codex-analysis-request.md`, and
   the expected `codex-intent.json` path, then stops at
   `CODEX_INPUT_REQUIRED`.
3. The active Codex session reads the request, uses `view_image` for the local
   preview, and
   follows the skill's RAW-first/Lightroom closed-loop rules. A JPG may be used
   for composition/focus/expression triage, but it is not color truth.
4. Codex writes only a `SemanticIntentPlan` JSON object to `codex-intent.json`.
   The CLI validates it with the same Zod schema used by every provider.
5. Run `resume --intent-file ...`; only then can the deterministic translator,
   checkpoint, readback, and disposable render stages proceed.

## Safety boundary

- RAW, EXIF, and GPS are local-only.
- The handoff is read-only with respect to Lightroom and source photos.
- A malformed or ambiguous intent fails the session; it is never guessed.
- `--backend lightroom --apply` remains a separate explicit action and should
  use a non-critical test photo.
