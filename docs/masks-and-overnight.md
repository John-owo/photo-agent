# Local masks and overnight batches (summary)

The full guide is in Traditional Chinese: [masks-and-overnight.zh-TW.md](masks-and-overnight.zh-TW.md).

## Masks

- Providers write semantic mask intent (`radial` / `linear` regions in frame
  fractions, up to 3 masks and 4 parameters each, `placement_certainty`). The
  deterministic translator owns every Lightroom value: `Flipped: true` acts
  inside an ellipse, `LocalExposure2012 = EV / 4`, local strength is capped.
- Writes go only to the photo-agent Workflow Copy. Corrections are named
  `photo-agent:<session>:<mask>`; every other correction is preserved by a
  read-merge-write. Non-geometric foreign masks, an `absent` or unreadable
  readback, or a write-only backend without consent degrade to global
  adjustments with a recorded reason.
- Each mask write records the full prior set (`masks/iteration-N-intent.json`)
  and its readback result; `recover` reports uncertain writes and never
  retries; `restore-masks` writes the recorded prior set back.
- Evaluators return `mask_feedback`: `too_strong` halves a mask, `unnecessary`
  removes it, `misplaced` stops for review (interactive) or removes it
  (unattended).
- Capability detection: mask write from the `set_develop_settings` input
  schema; mask readback from the `io.github.john-owo.lightroom-mcp/mask-readback`
  tool `_meta` (lightroom-mcp PR #15 plus the stacked readback PR).

## Overnight batch (agent-driven)

`batch` defaults to `--provider codex --evaluator handoff --mode unattended`.
Claude Code or Codex reads `worklist.md`, inspects each listed image locally,
writes the requested `SemanticIntentPlan` or `EvaluationResult` JSON, and runs
`batch --resume` until nothing waits. Per-photo isolation, a consecutive-failure
circuit breaker, idempotent resume (interrupted photos are only recovered, never
re-applied) and a Traditional Chinese `report.md` are built in. A single photo
can use the same loop with `--evaluator handoff` and `continue`.

Optional API path: `--provider claude --evaluator claude --allow-cloud-preview`
(default model `claude-opus-5-5`, server-side web search with
`--web-references`) or the existing OpenAI provider.

Brush and AI masks are out of scope; see the investigation notes in the
Traditional Chinese guide. Live Lightroom end-to-end verification is pending.
