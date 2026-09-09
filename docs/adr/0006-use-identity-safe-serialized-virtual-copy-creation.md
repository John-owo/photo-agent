# ADR 0006: Use identity-safe, serialized Virtual Copy creation

- Status: Accepted
- Date: 2026-08-24

## Context

PhotoAgent must not apply automated Develop mutations to a Lightroom Master.
The workflow therefore depends on `lightroom-mcp` creating and returning a
verified Lightroom Virtual Copy before the first mutation.

Lightroom Classic's SDK does not create a Virtual Copy from an explicit photo
argument. `catalog:createVirtualCopies(copyName)` operates on the current
Lightroom selection, changes that selection to the newly created copies, and
returns those copies. The existing plugin dispatch can process overlapping
requests and does not provide a selection mutex. Master photos and Virtual
Copies also share the same source path, so path-based lookup is ambiguous.

The existing PhotoAgent pull request and historical alpha tag combine work from
multiple proposed milestones. They are useful as an experimental record but do
not demonstrate that the cumulative v0.1 acceptance gate has passed.

## Decision

### Virtual Copy tool contract

`lightroom-mcp` will add a single-photo `create_virtual_copy` capability with a
strict identity contract:

- require `source_photo_id`, `expected_source_uuid`, and `operation_id`;
- reject path-only lookup and fail closed when a path identifies both a Master
  and one or more Virtual Copies;
- reject a Virtual Copy as the source during P0;
- require callers to reuse the same `operation_id` when reconciling or retrying
  an uncertain result;
- include a stable operation marker in the copy name so a result can be
  reconciled after a response loss or process restart;
- return the source ID and UUID, Virtual Copy ID and UUID, Master ID and UUID,
  copy name, `is_virtual_copy`, creation or reconciliation status, and selection
  restoration status;
- verify the returned photo is a Virtual Copy of the expected Master before it
  can enter the mutation workflow.

Collection placement is a separate operation. PhotoAgent will use the returned
Virtual Copy ID with `add_to_collection`. If copy creation succeeds but
collection placement fails, the result is a partial failure: retain the copy,
record its identity, and require review. Do not report or simulate rollback.

### Selection ownership and serialization

The Lightroom plugin will serialize all MCP requests through one plugin-side
queue. Virtual Copy creation is additionally declared `exclusive_backend`.

Within the exclusive section, the handler will:

1. snapshot the current active photo and selected photos;
2. select exactly the expected Master;
3. read back and verify that selection;
4. create one Virtual Copy;
5. verify the returned copy and its Master relationship;
6. restore the previous selection in a finalization path.

If selection drifts, the creation result is uncertain, identity verification
fails, or selection restoration fails, the workflow stops with
`REVIEW_REQUIRED`. It must not blindly retry or continue to Develop mutation.
Plugin-side serialization cannot prevent direct user interaction with the
Lightroom UI, so read-back verification remains mandatory.

### Repository and release sequence

- Preserve the existing `v0.3.0-alpha.0` tag and feature branch as historical
  experimental evidence; do not delete or rewrite them.
- Close the stale mixed-scope PhotoAgent pull request with an explanatory note
  instead of merging or force-rewriting it.
- First create a narrow `lightroom-mcp` P0 pull request for identity read-back,
  ambiguous-path failure, Virtual Copy creation, serialization, and tests.
- Require live Lightroom verification of creation, identity, reconciliation,
  selection restoration, and failure handling before treating the backend
  capability as accepted.
- Then create a new PhotoAgent `v0.1.0-alpha.1` branch and pull request from
  current `main`, integrating the verified Virtual Copy lifecycle.
- Keep the version at `0.1.0-alpha.N` until all cumulative v0.1 acceptance gates
  pass.

## Consequences

- Automated edits remain non-destructive with respect to the Master Develop
  state.
- Virtual Copy creation is slower and reduces backend concurrency, but the
  selection-dependent SDK operation becomes observable and fail-closed.
- Persistent UUIDs and explicit operation IDs replace unsafe path identity and
  transport request IDs.
- A timeout can produce an uncertain result that requires reconciliation before
  retry, rather than silently producing duplicate copies.
- Backend work and orchestrator integration have independent, reviewable gates.
- Existing experimental code remains available for reference without being
  mistaken for an accepted release.

## Alternatives considered

### Use file paths as photo identity

Rejected because a Master and all of its Virtual Copies share the same source
path.

### Serialize only the Virtual Copy handler

Rejected because another concurrent request could observe or modify the
temporary selection while the handler is running.

### Rework the existing mixed-scope pull request in place

Rejected because it obscures milestone history and weakens the cumulative
acceptance-gate model.

### Add collection placement to the creation transaction

Rejected for P0 because Lightroom may create the copy successfully and then
fail to add it to a collection; that state cannot be represented as an atomic
rollback.
