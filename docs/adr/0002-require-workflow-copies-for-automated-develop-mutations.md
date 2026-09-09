---
status: accepted
---

# Require Workflow Copies for automated Develop mutations

Before any AI-controlled Develop operation, `lightroom-mcp` must create a new Lightroom Virtual Copy from the selected Master Photo and return a verifiable identity for that Workflow Copy. All mutation, preview rendering, iterative refinement, and propagation target Workflow Copies only; the source asset and Master Develop State remain unchanged. Checkpoints remain for Workflow Copy recovery and intermediate rollback. There is no direct-Master mode, and Virtual Copy capability is P0 ahead of HSL, Color Grading, or other control-surface expansion.

## Consequences

If the backend cannot create or verify a Workflow Copy, the workflow stops without mutation and requires review. Every propagated target needs its own Workflow Copy before settings are applied.
