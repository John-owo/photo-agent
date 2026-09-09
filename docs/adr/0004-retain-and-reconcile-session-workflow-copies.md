---
status: accepted
---

# Retain and reconcile session Workflow Copies

Each new PhotoAgent session creates a fresh Workflow Copy, while resume and recovery reuse that exact copy through a persistent Lightroom identity and never create another copy while creation outcome is uncertain. The initial implementation accepts only a Master Photo as input; selecting an existing Virtual Copy moves the workflow to `REVIEW_REQUIRED`.

Workflow Copies are retained, never automatically deleted, and grouped in a `PhotoAgent/<session-id>` Lightroom collection for user-managed cleanup. Every propagated target receives its own verified Workflow Copy. A clear per-photo creation failure isolates that photo as `REVIEW_REQUIRED`; uncertainty about copy existence, bridge ownership, or catalog identity stops the entire batch until reconciliation.
