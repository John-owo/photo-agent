---
status: accepted
---

# Preserve alpha history and create Workflow Copies lazily

The historical `v0.3.0-alpha.0` tag remains immutable as an experimental feature snapshot and is not evidence that v0.1-v0.3 acceptance gates passed. Active development returns to `0.1.0-alpha.1`; no existing tag is deleted or rewritten.

PhotoAgent may read Master metadata, Master Develop State, and preview renders without creating a Workflow Copy. It creates a new copy only after apply is approved and an executable adjustment exists. The copy inherits the current Master Develop State, and all automated adjustments are bounded deltas against that inherited baseline; neutral reset is not a default mode.
