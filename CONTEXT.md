# PhotoAgent

PhotoAgent coordinates safe, auditable photography workflows while delegating editor-specific operations to independent backends.

## Language

**Workflow Orchestrator**:
The PhotoAgent core that owns workflow state, safety policy, recovery, evaluation, culling, clustering, and propagation decisions.
_Avoid_: Lightroom backend, MCP bridge

**Lightroom Backend**:
The independently usable `lightroom-mcp` server and Lightroom Classic plug-in that expose catalog and Develop operations to the Workflow Orchestrator.
_Avoid_: PhotoAgent core, workflow engine

**Master Photo**:
The Lightroom catalog photo selected as the source of an AI workflow. PhotoAgent must preserve both its source asset and its pre-existing Master Develop State.
_Avoid_: Working copy, mutation target

**Master Develop State**:
The Develop settings already associated with a Master Photo before PhotoAgent begins. Automated PhotoAgent workflows never mutate this state.
_Avoid_: Checkpoint, rollback state

**Workflow Copy**:
A new Lightroom Virtual Copy created from a Master Photo for one PhotoAgent workflow. It is the only valid target for automated Develop mutation, preview rendering, iterative refinement, and propagation.
_Avoid_: Master, source photo, temporary preview

**Checkpoint**:
A versioned record of a Workflow Copy's Develop settings used for workflow recovery and intermediate rollback. It does not replace the Workflow Copy boundary and is not Lightroom true undo.
_Avoid_: Virtual Copy, snapshot, Master backup

**Acceptance Gate**:
A cumulative evidence boundary that must pass before a version milestone is considered achieved. Feature presence in an alpha build does not satisfy the gate by itself.
_Avoid_: Feature checklist, alpha label
