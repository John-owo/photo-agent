# Changelog

## Unreleased

- Add geometric local masks (radial and linear gradients): semantic mask
  intent, deterministic Lightroom translation, read-merge-write that preserves
  existing masks, capability detection with a recorded degrade-to-global
  path, mask evidence for `recover`, and `restore-masks`.
- Add evaluator `mask_feedback` (halve, remove, or review a mask).
- Add the agent handoff evaluator, `EVALUATION_INPUT_REQUIRED`, and `continue`
  so Claude Code or Codex can judge every render locally.
- Add `batch` for unattended overnight runs with a worklist, resume, a
  consecutive-failure circuit breaker, and a Traditional Chinese morning
  report.
- Add an optional Claude API provider and evaluator.
- Requires lightroom-mcp PR #15 and the stacked mask-readback PR for masks;
  live Lightroom end-to-end verification is still pending.

## 0.3.0-alpha.0 - 2026-08-13

- Add bounded v0.2 evaluate/refine editing with durable iteration evidence.
- Add v0.3 RAW/preview indexing, culling and lighting review, clustering,
  resumable shoot jobs, representative orchestration, and guarded propagation.
- Require explicit consent before any cloud preview transfer or Lightroom
  mutation path.
- Verify a 153-RAW read-only shoot run and no-repeat resume.
- Verify one non-critical RAW through the live PhotoAgent Lightroom adapter and
  visually inspect the generated Lightroom JPEG without mutating develop state.

This is an alpha release. Subjective batch culling, live representative
edits/propagation, and evaluator-to-human agreement are not release claims.
