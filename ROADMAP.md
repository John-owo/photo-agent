# Backend-Agnostic AI Photography Workflow Agent
## Future Direction & Open-Source Roadmap (v2.1)

> **Goal:** Build an open-source, backend-agnostic AI photography workflow agent that can understand photos, cull images, learn editing styles, operate editing backends, review rendered results, and iteratively refine RAW photo edits.

---

## Changelog vs. v2

This v2.1 revision keeps the v2 audit corrections and adds the runtime, interoperability, privacy, and evaluation details needed to turn the roadmap into an implementable architecture rather than only a product plan.

1. **Added a Workflow Runtime / State Machine** — explicit job states, resumability, checkpoints, crash recovery, and session-level progress are now first-class core concepts.
2. **Added operation side-effect semantics** — adapters must declare idempotency, reversibility, selection/foreground requirements, concurrency rules, retry safety, and resumability in addition to simple capability availability.
3. **Split semantic editing intent from backend parameters** — the reasoning layer produces an intent plan, a deterministic translation layer produces a normalized parameter plan, and adapters finally translate that into editor-native operations.
4. **Reduced the early milestone scope** — v0.1-alpha proves one-photo end-to-end execution before culling, clustering, batch orchestration, Style Memory, or multi-provider expansion.
5. **Made CLI the canonical early interface** — Codex and Claude skills should remain thin wrappers over the same core/CLI path instead of carrying separate workflow logic.
6. **Expanded Style Memory into a technical three-layer model** — explicit preferences, historical edit statistics, and retrieval examples are combined into a scene-aware style prior.
7. **Added preference-based evaluation** — blind pairwise human preference and held-out evaluation are tracked alongside technical metrics and VLM/human agreement.
8. **Added privacy/data-governance requirements** — cloud image transfer, EXIF/GPS metadata, previews vs. RAW files, provider disclosure, and local-only operation must be explicit and configurable.
9. **Added reproducibility metadata** — model/provider version, adapter version, schema version, config hash, prompt/workflow version, and source hashes belong in every session manifest.
10. **Expanded the Risk Register** — partial-run corruption, GUI-backend concurrency, cloud privacy, translation drift, eval leakage, provider nondeterminism, and plugin API drift are now tracked.

### Historical v2 audit notes (carried forward; milestone placement refined above)

This revision was produced after auditing the actual state of `John-owo/lightroom-mcp` (fork of `Automaat/lightroom-mcp`, v0.10.0, 18 MCP tools). The following corrections and additions were made:

1. **Capability matrix corrected** — Local mask marked `No` (not `Partial`) for Lightroom; `undo_or_revert` redefined as *versioned checkpoint*, not true undo, since the backend has no virtual copy / snapshot / undo access.
2. **`render_preview` split from `export_photos`** — the current adapter has no dedicated fast-preview path; reusing the delivery-export tool for iterative AI review risks polluting user export folders and using delivery-grade settings for throwaway renders.
3. **Ingestion/culling capabilities added to the contract** — `search`, `set_rating`, `set_label`, `set_keywords`, `manage_collections`, `import` were missing from the capability list even though the current backend already exposes them.
4. **v0.1 exit criteria now includes closing the known `.lrtemplate` round-trip validation gap** — the repo's own "Verified Scope" section admits this hasn't been tested end-to-end through the Lightroom UI.
5. **Added a Licensing & Provenance section** — the Lightroom adapter is and will remain a fork of an MIT-licensed upstream project; the "extract the core" plan must preserve that relationship correctly.
6. **Added a trust-boundary dimension to the capability matrix** — localhost+token, file-only, and future networked/cloud backends have different threat models; the workflow engine should adapt to this, not just to feature availability.
7. **Added a Risk Register** — VLM evaluation reliability, iteration cost/latency budget, and schema versioning discipline were previously undiscussed.

---

## 1. Project Vision

This project should not be positioned as:

- a Lightroom preset generator;
- a Lightroom-only automation script;
- a Codex/Claude skill collection;
- a wrapper around a single MCP server.

The long-term goal is a reusable **AI-native photography workflow layer** that sits above different editing backends.

```text
Photos / RAW files
        ↓
Visual Understanding
        ↓
Culling / Grouping / Scene Analysis
        ↓
Editing Plan
        ↓
Backend Adapter
        ↓
Actual Photo Editor
        ↓
Rendered Preview
        ↓
Visual Review
        ↓
Iterative Refinement
        ↓
Final Edit / Preset / Metadata / Export
```

> **The agent owns the workflow. The editing software is only a backend.**

---

## 2. Core Product Principles

### 2.1 Backend-Agnostic

Define a common internal interface that different editors implement, instead of hard-coding the workflow around Lightroom.

Potential backends:

- Lightroom Classic via MCP
- XMP sidecar generation
- Adobe Camera Raw
- Darktable
- RawTherapee
- Capture One, if an automation path becomes available
- Filesystem-only workflows
- Future photo editor MCP servers

```text
                 AI Photography Agent
                         │
              ┌──────────┼──────────┐
              │          │          │
            Culling    Editing    Evaluation
              │          │          │
              └──────────┼──────────┘
                         │
                  Workflow Engine
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
   Lightroom Adapter   XMP Adapter   Future Adapter
          │              │              │
          ▼              ▼              ▼
     Lightroom        RAW Editor      Other Editor
```

The workflow engine should depend only on stable internal contracts — the normalized edit-plan contract in Section 6 and the backend capability/trust/operation contract in Section 7.

### 2.2 Agent-First, Not Prompt-First

Prompts and skills are interfaces; the project itself must contain reusable software components.

```text
photo-agent/
│
├── core/
│   ├── analysis/
│   ├── culling/
│   ├── grouping/
│   ├── editing/
│   ├── evaluation/
│   └── style_memory/
│
├── runtime/
│   ├── state_machine/
│   ├── jobs/
│   ├── checkpoints/
│   └── recovery/
│
├── adapters/
│   ├── lightroom/
│   ├── xmp/
│   └── filesystem/
│
├── providers/
│   ├── openai/
│   ├── anthropic/
│   └── local/
│
├── cli/
├── skills/
│   ├── codex/
│   └── claude/
│
├── schemas/
├── evals/
├── examples/
├── docs/
└── tests/
```

The agent interface may change; the internal workflow logic and runtime must remain portable. Skills should be thin integration layers, not alternate implementations of the workflow.

---

## 3. Licensing & Provenance *(new)*

The current Lightroom backend is a **fork of `Automaat/lightroom-mcp`** (MIT-licensed) — general catalog control (search, ratings, keywords, collections, import/export) is inherited from upstream, not authored in this project. The `raw-photo-lightroom-preset` skill and the v0.10.0 preset round-trip tools (`get_develop_preset`, `compare_develop_presets`, `create_develop_preset`, `export_develop_preset`) are the original contribution.

When "extracting the core" into an independent `photo-agent` repository (v0.1), this relationship must stay explicit:

- `photo-agent/core` and `photo-agent/schemas` are original work and can carry their own license (MIT recommended, matching upstream).
- The Lightroom adapter package should continue to depend on (or vendor with attribution to) the upstream fork rather than silently re-implementing its catalog tools, to keep bugfixes and security patches flowing from upstream.
- `NOTICE`/`THIRD_PARTY.md` should credit `Automaat/lightroom-mcp` and any other adapters that wrap third-party open-source tools (e.g. a future Darktable CLI adapter).
- Do not describe the Lightroom capability set as "built for this project" in marketing copy (README, launch posts) — describe it accurately as "built on top of an existing open-source Lightroom MCP server."

This matters for OSS credibility (Section 18) as much as for legal correctness.

---

## 4. Major Functional Areas

### 4.1 Photo Ingestion & Source Relationship

Responsibilities:

- enumerate RAW and JPEG files;
- detect RAW + preview relationships;
- preserve relative paths;
- avoid collisions caused by duplicated filenames;
- extract metadata;
- detect missing previews;
- track source confidence;
- never modify source files by default.

```json
{
  "raw_path": "shoot/day1/DSC_0012.NEF",
  "preview_path": "shoot/day1/DSC_0012.JPG",
  "capture_time": "...",
  "camera": "...",
  "lens": "...",
  "width": 6048,
  "height": 4024,
  "source_confidence": "high"
}
```

This layer should be backend-independent — it does not require a live editor connection at all, since it's a filesystem/metadata operation.

### 4.2 AI Culling Engine

Should eventually cover: technical quality, focus, motion blur, closed eyes, bad expressions, duplicates, burst similarity, composition, subject visibility, storytelling value, delivery value.

```text
selection_status: select | keep | reject | review
confidence: high | medium | low
```

The culling engine must **not** silently convert these states into Lightroom stars, flags, or colors — that mapping is a backend-adapter responsibility, driven by explicit user configuration (see Section 7's `set_rating` / `set_label` / `set_keywords` capabilities).

### 4.3 Scene & Lighting Clustering

Group photos by scene/lighting rather than forcing one preset onto a whole shoot.

Possible clusters: outdoor daylight, outdoor shade, golden hour, blue hour, indoor tungsten, mixed lighting, stage lighting, high ISO, backlight, night street, flash, silhouette.

```text
cluster_id
representative_image
lighting_type
confidence
recommended_edit_strategy
outliers
```

Editing decisions should be learned from a representative image before propagating to the group.

---

## 5. Closed-Loop Editing

This is the project's defining feature. The system must not stop after generating slider values.

```text
Analyze RAW → Create Editing Plan → Apply Edit → Render Preview
    → Inspect Result → Evaluate Problems → Adjust → Render Again
```

Evaluation dimensions: exposure, highlight clipping, shadow detail, white balance, skin tone, saturation, local contrast, subject separation, color harmony, consistency with requested style, consistency with learned style.

Loop ends when:

- the result passes acceptance thresholds;
- the iteration budget is reached;
- confidence falls below a threshold;
- the workflow requires manual intervention.

**Reliability caveat (new):** the evaluation step depends on a VLM judging subjective qualities (skin tone accuracy, color harmony, "cinematic feel"). Treat this as advisory, not ground truth, until calibrated:

- keep a small human-labeled benchmark set (see Section 14) to periodically check whether VLM judgments correlate with actual photographer preference;
- log every automated "pass/fail" evaluation with the image and rationale so disagreements are auditable, not just the final decision;
- do not let the loop silently converge on a plausible-looking but wrong result — a stalled loop (repeated small adjustments with no convergence) should escalate to `review`, not exhaust the iteration budget silently.

**Cost/latency budget (new):** each iteration costs one backend render + one VLM call. For a full shoot (hundreds of RAW files) even limited to representative images, iteration count multiplies quickly. `editing.max_iterations` (Section 17) should have a sane low default (e.g. 3), and the workflow engine should report iteration count and wall-clock/token cost per session so cost is visible before scaling to "propagate to whole shoot."

---

## 6. Editing Plan Model *(revised: intent → normalized parameters → backend operations)*

The reasoning layer should **not** directly emit Lightroom slider names as the project's stable contract. A backend-agnostic system needs three distinct representations.

### 6.1 Semantic Intent Plan

The model first describes *what should change and why* in a human-auditable form.

```json
{
  "technical_correction": {
    "exposure": "slightly darker",
    "white_balance": "slightly cooler",
    "highlight_recovery": "medium"
  },
  "tone_shape": {
    "contrast": "soft",
    "shadow_depth": "moderate"
  },
  "color_direction": {
    "skin_tone_priority": true,
    "greens": "slightly muted",
    "blues": "deeper"
  },
  "creative_goal": "cinematic blue-hour",
  "confidence": "medium"
}
```

This representation is useful for reasoning, review, and explanation, but it is **not** precise enough to execute directly.

### 6.2 Normalized Parameter Plan

A deterministic translator converts semantic intent into a typed, versioned parameter plan with explicit units, ranges, delta/absolute semantics, and validation.

```json
{
  "schema_version": "0.1.0",
  "operations": [
    {
      "parameter": "exposure_ev",
      "mode": "delta",
      "value": -0.20,
      "confidence": 0.82
    },
    {
      "parameter": "temperature_k",
      "mode": "delta",
      "value": -350,
      "confidence": 0.71
    },
    {
      "parameter": "green_saturation",
      "mode": "delta",
      "value": -12,
      "confidence": 0.67
    }
  ]
}
```

The normalized schema must define:

- units and legal ranges;
- whether a value is absolute or relative;
- missing/null semantics;
- parameter dependencies and conflicts;
- safe propagation rules;
- schema version and migration policy.

### 6.3 Backend Translation

Only the adapter translates normalized parameters into editor-native operations.

```text
User intent / VLM reasoning
          ↓
Semantic Intent Plan
          ↓
Deterministic Normalizer
          ↓
Normalized Parameter Plan
          ↓
Backend Adapter
          ↓
Lightroom / XMP / Future Editor operations
```

This separation prevents model wording changes from becoming backend API changes and makes cross-backend behavior testable. Adapter translation must be covered by golden-vector tests so that a schema or backend upgrade cannot silently change the meaning of existing edit plans.

---

## 7. Backend Adapter Layer & Capability Contract *(revised)*

Each backend publishes a normalized capability contract along **two axes**: what it can *do*, and what *trust model* it operates under.

### 7.1 Functional capabilities

```text
# Discovery / organization (needed by Culling, Section 4.2)
search
read_metadata
set_rating
set_label
set_keywords
manage_collections
import

# Editing
read_current_edit
apply_global_adjustment
copy_settings
apply_local_mask        # capability, not assumed available

# Preview & delivery (kept distinct — see rationale below)
render_preview           # fast, disposable, low-res, auto-cleaned
export_final              # delivery-grade, user-controlled destination

# Preset / checkpoint lifecycle
create_checkpoint
export_preset
read_preset
compare_presets

# Safety
rollback                  # see semantics note below
```

**Why `render_preview` and `export_final` are separate capabilities:** the current Lightroom adapter only exposes a generic `export_photos` tool. If the closed-loop editor (Section 5) reuses it directly for every iteration, throwaway preview renders can land in the same folder, at the same resolution, as the user's real deliverables. `render_preview` should be a thin, opinionated wrapper — small JPEG, temp directory, deterministic naming, deleted after the session (or moved into `session/renders/`, see Section 13) — never the same code path a human would use for final export.

**`rollback` semantics note:** for backends without true undo/snapshot access (this includes the current Lightroom adapter — no virtual copy, no snapshot, no undo through MCP), `rollback` means *"produce a new checkpoint equal to a prior known-good state,"* not *"revert in place."* Adapters must declare which behavior they implement; the workflow engine and any human-facing UI must not describe both as "undo" interchangeably, since the safety guarantees differ (an in-place revert can't be raced by concurrent edits; a new-checkpoint rollback can).

### 7.2 Trust boundary / authentication model

Different backends have different attack surfaces, and the adapter contract should say so explicitly rather than treating this purely as a feature-availability question:

| Backend | Transport | Auth | Notes |
|---|---|---|---|
| Lightroom MCP | localhost TCP (two ports) | 256-bit token, generated per Start Server | No remote surface today; workflow engine should still avoid embedding the token in logs/checkpoints |
| XMP adapter | direct filesystem write | OS file permissions only | No network; safety rests entirely on atomic writes + no-overwrite rules |
| Future networked/cloud adapter | TBD | TBD | Must be threat-modeled before being added — this is explicitly out of scope until an adapter actually needs it |

### 7.3 Capability matrix *(corrected)*

| Capability | Lightroom | XMP | Future Editor |
|---|---:|---:|---:|
| Read current edit | Yes | Partial | TBD |
| Apply global edit | Yes | Yes | TBD |
| Render preview (fast/disposable) | Yes, via wrapped export | No | TBD |
| Export final (delivery-grade) | Yes | N/A | TBD |
| Create checkpoint | Yes (versioned, never overwritten) | File-based | TBD |
| Local mask | **No** | No | TBD |
| AI denoise | Manual (hand off to Lightroom UI) | No | TBD |
| Rollback | New-checkpoint only, not true undo | New-file only | TBD |
| Ratings / keywords / collections | Yes | N/A | TBD |

The workflow engine must adapt to available capabilities *and* trust models instead of assuming every backend can do everything the same way.

### 7.4 Operation Semantics, Side Effects & Concurrency *(new)*

A boolean `supported: true` is not enough for a GUI-backed or stateful editor. Every operation should also declare how safely the workflow runtime can invoke, retry, resume, or parallelize it.

Recommended per-operation metadata:

```yaml
apply_global_adjustment:
  supported: true
  side_effect: mutating
  idempotent: false
  reversible: checkpoint_only
  scope: selected_photo
  requires_active_selection: true
  requires_editor_foreground: false
  concurrency: exclusive_backend
  retry_policy: only_after_state_readback
  safe_to_resume: conditional
```

Minimum semantics to declare:

- `side_effect`: read-only, temporary, mutating, delivery/export;
- `idempotent`: whether an identical retry produces the same state;
- `reversible`: true undo, checkpoint-only restore, new-file restore, or irreversible;
- `scope`: photo, selection, collection, catalog, filesystem, session;
- `requires_active_selection`: whether editor UI state affects the result;
- `requires_editor_foreground`: whether focus/UI state matters;
- `concurrency`: parallel-safe, per-photo serialized, or exclusive-backend;
- `retry_policy`: automatic, readback-before-retry, or manual-review only;
- `safe_to_resume`: whether a crashed job can continue without first reconciling backend state.

For Lightroom, the first implementation should assume **exclusive backend ownership for mutating operations** unless proven otherwise. The runtime should use a backend lease/lock so two jobs cannot concurrently change selection or Develop settings and corrupt each other's assumptions.

Before retrying any non-idempotent mutation after a timeout, the runtime must read the actual backend state and reconcile it with the last recorded checkpoint rather than blindly issuing the same command again.

---

## 8. Lightroom MCP Adapter *(revised for accuracy)*

The existing fork can remain an important backend, and should gradually become just one adapter among several.

**Currently available (18 tools, v0.10.0):**

- catalog/organization: `search_photos`, `get_selected_photos`, `get_photo_metadata`, `list_collections`, `create_collection`, `add_to_collection`, `set_keywords`, `set_rating`, `import_photos`, `export_photos`;
- preset lifecycle: `list_develop_presets`, `get_develop_preset`, `compare_develop_presets`, `create_develop_preset`, `export_develop_preset`, `apply_develop_preset`;
- direct editing: `copy_develop_settings`, `set_develop_settings`.

**Known, currently-acknowledged gaps (must be tracked, not assumed solved):**

- No virtual copy, snapshot, or undo access — safety for master edits depends entirely on the user working on representative photos/virtual copies by convention, not on anything the MCP server enforces.
- No local adjustment/masking, AI Denoise, Calibration, Color Grading panel, or Point Color control — these remain manual-only.
- `.lrtemplate` round-trip has been verified for creation/export/no-overwrite behavior, but **not** for actually re-importing through the Lightroom UI on a target machine, and visual-style correctness after export has not been independently confirmed. Do not claim "Lightroom-compatible presets" until this is closed.

```text
photo-agent
    ↓
LightroomAdapter
    ↓
Lightroom MCP (fork of Automaat/lightroom-mcp)
    ↓
Lightroom Classic
```

Keeping upstream MCP development independent from `photo-agent` core logic is still the right call — it lets bugfixes flow in both directions without coupling the workflow engine's release cycle to Lightroom-specific plugin work.

---

## 9. XMP Fallback Backend

Important because it provides a backend path even when Lightroom MCP is unavailable, and because it has no network trust-boundary questions (Section 7.2).

Goals: generate safe sidecar files; never overwrite existing edits without permission; use atomic writes; validate schema; maintain versioned checkpoints; support predictable mappings from normalized edit parameters. Start with global adjustments only — add advanced features once semantics are well understood.

---

## 10. Style Memory

One of the project's major differentiators. The system learns from a photographer's historical edits.

```text
RAW files + finished images + XMP / Lightroom metadata / presets
```

Extracted patterns: preferred white balance direction, contrast style, highlight behavior, black point, curve shape, color relationships, skin-tone handling, saturation preferences, scene-specific decisions.

```json
{
  "name": "john-v1",
  "outdoor_shade": {
    "wb_bias": "slightly warm",
    "contrast": "medium-soft",
    "greens": "muted",
    "blues": "deep"
  },
  "night_city": {
    "wb_bias": "cool",
    "black_point": "deep",
    "highlight_color": "cyan-blue"
  }
}
```

```text
Generic photography knowledge + Current photo analysis + User intent + Style Memory
= Personalized editing decision
```

### 10.1 Style Memory Must Be Scene-Aware

Condition on lighting, subject type, location type, time of day, ISO range, camera, lens, and intended delivery — never learn one global preset.

```text
Current Photo → Scene Classification → Retrieve Relevant Historical Edits
    → Generate Style Prior → Create Candidate Edit
```

### 10.2 Reference Image Matching

Allow a user-provided reference image ("make these feel closer to this, but preserve natural skin tones"). Derive tone distribution, color relationships, saturation, white balance, contrast, mood — estimate perceptual similarity, don't blindly copy numerical settings.


### 10.3 Technical Style Memory Model *(new)*

Style Memory should not collapse into a single JSON preset. Treat it as three complementary evidence layers:

1. **Explicit preferences** — stable user-authored rules such as `preserve_skin_tones`, `prefer_deep_blues`, `avoid_crushed_blacks`, or delivery-specific constraints.
2. **Historical edit statistics** — scene-conditioned distributions and deltas learned from prior RAW → final edit pairs, e.g. median exposure delta, WB bias, highlight behavior, curve tendencies, and color adjustments.
3. **Retrieved examples** — a small set of historically similar edits selected by scene, lighting, subject, camera/lens, ISO range, and intended delivery.

```text
Current Photo
    ↓
Scene / Subject / Technical Features
    ↓
┌────────────────────┬────────────────────────┬──────────────────────┐
│ Explicit Rules     │ Historical Statistics  │ Retrieved Examples   │
└────────────────────┴────────────────────────┴──────────────────────┘
                         ↓
                    Style Prior
                         ↓
                 Semantic Edit Intent
```

A `StylePrior` should contain both the proposed tendency and the evidence behind it, including sample count and confidence. Low-data regions must fall back toward generic photographic guidance instead of pretending the photographer has a learned preference.

Training/evaluation separation matters: photos used to build a style profile must not also be used to report personalization quality. Hold out entire shoots where possible, not merely adjacent burst frames from the same event.

---

## 11. Batch Workflow

```text
800 RAW photos → Pair/index → Cull → Detect duplicates → Group by lighting
    → Pick representative images → Edit representatives → Closed-loop refinement
    → Propagate safe settings → Review outliers → Export/handoff
```

Produce a structured session report:

```text
Input: 823 photos
Select: 162
Review: 31
Reject: 630

Lighting clusters: 9
Representative edits: 12
Manual review required: 18
Editing confidence: 0.86
```

---

## 12. Human-in-the-Loop, Safety & Non-Destructive Editing

The system should never assume AI decisions are always correct.

Important checkpoints: ambiguous culling, high-value images, skin tone uncertainty, mixed lighting, extreme edits, destructive operations, unsupported local adjustments.

```text
Modes: Conservative | Balanced | Autonomous
```

Conservative mode requires more approvals; Autonomous mode still preserves non-destructive checkpoints.

**Default safety rules:**

- never delete RAW files;
- never rename originals;
- never overwrite master edits;
- never overwrite presets silently;
- never apply crop / WB / profile / lens settings to a batch without explicit logic;
- preserve checkpoints;
- record all automated decisions;
- roll back means *"restore to a known-good checkpoint,"* per Section 7.1 — state this plainly to the user rather than implying an in-place undo, since some backends (current Lightroom adapter included) cannot actually do the latter.

Every workflow produces an audit trail (Section 13).

---

## 13. Workflow Runtime, State & Audit Log *(expanded)*

The runtime is a first-class subsystem, not just a folder of logs. It owns state transitions, checkpointing, cancellation, retries, recovery, backend locking, and resumability.

### 13.1 Job State Machine

A single-photo edit job should move through explicit states such as:

```text
PENDING
  ↓
ANALYZING
  ↓
PLAN_READY
  ↓
APPLYING
  ↓
RENDERING
  ↓
EVALUATING
  ├──→ RETRYING ─────┐
  ├──→ REVIEW_REQUIRED
  ├──→ ACCEPTED
  └──→ FAILED

Any active state may also transition to CANCELLED.
```

State transitions must be validated; jobs must not jump directly from `PENDING` to `ACCEPTED` or silently overwrite a prior terminal state.

### 13.2 Resumability & Crash Recovery

A full-shoot workflow may run for a long time and interact with a stateful desktop editor. The system therefore needs durable progress rather than an in-memory loop.

On restart, the runtime should:

1. load the last durable session/job state;
2. inspect any incomplete operation;
3. read back backend state when the last operation may have mutated it;
4. compare that state with the last known-good checkpoint;
5. resume automatically only when the operation contract says it is safe; otherwise escalate to `REVIEW_REQUIRED`.

A failed photo or cluster should not force the entire shoot to restart. Batch orchestration should isolate jobs and preserve successful results.

### 13.3 Session Layout

```text
session/
├── manifest.json          # versions, config, hashes, provider/backend identity
├── state.json             # session-level state + progress
├── jobs/                  # durable per-photo/per-cluster job states
├── culling.csv
├── clusters.json
├── edit_plans/
├── renders/               # disposable render_preview outputs; never user delivery folders
├── evaluations/           # VLM judgments + rationale
├── checkpoints/
└── session.log
```

### 13.4 Reproducibility Metadata

Every session manifest should record enough information to explain *why the same inputs may produce a different result later*:

- source file hashes or stable source identifiers;
- schema versions;
- workflow/runtime version;
- adapter name and version;
- backend/editor version when discoverable;
- model provider + model identifier/version;
- prompt/skill/workflow template version or hash;
- configuration hash;
- random seed when the provider exposes one;
- timestamps and iteration count;
- whether images/previews were sent to a cloud provider.

The goal is not perfect determinism — multimodal providers may still be nondeterministic — but **auditable reproducibility**: a developer should be able to identify what changed between two runs.

---

## 14. Evaluation Framework

Include objective evals from early development.

**Culling:** sharp vs blurred, eyes open vs closed, duplicates, burst ranking, composition, subject prominence.
**Classification:** indoor/outdoor, daylight/shade, tungsten, mixed light, backlight, high ISO.
**Editing:** exposure correction, WB correction, preset reproduction, style consistency, edit convergence.
**Workflow:** pairing accuracy, backend failure recovery, checkpoint safety, iteration count, successful completion rate.
**Evaluator reliability (new, ties to Section 5):** agreement rate between VLM judgments and a small human-labeled benchmark, tracked as its own metric — not assumed to be 100% by construction.

### 14.1 PhotoAgent Bench

A public benchmark across categories: Portrait, Landscape, Street, Night, Event, Backlight, Indoor Mixed Light, High ISO, Architecture, Action.

| Metric | v0.1 | v0.2 | v0.3 |
|---|---:|---:|---:|
| RAW/JPG pairing | TBD | TBD | TBD |
| Culling precision | TBD | TBD | TBD |
| Lighting classification | TBD | TBD | TBD |
| Preset reproduction | TBD | TBD | TBD |
| Closed-loop success | TBD | TBD | TBD |
| Evaluator/human agreement | TBD | TBD | TBD |


### 14.2 Preference Evaluation *(new)*

Technical correctness is not identical to photographic preference. Add a blind pairwise evaluation path for subjective quality:

```text
A = baseline / previous workflow / human edit
B = PhotoAgent edit

Reviewer sees randomized A/B without labels
        ↓
Prefer A | Prefer B | Tie | Both unacceptable
```

Track at minimum:

- pairwise preference win rate;
- tie rate;
- unacceptable-result rate;
- preference by scene/lighting category;
- preference vs. generic preset baseline;
- preference vs. the photographer's own historical edit where an appropriate held-out pair exists.

Do not market a single aggregate preference score without reporting sample size and evaluation population. A style-learning model evaluated only by the same photographer who supplied its history is useful for personalization, but it is not evidence of universal aesthetic superiority.

### 14.3 Evaluation Hygiene *(new)*

To avoid inflated benchmark results:

- split by shoot/event, not only by individual image;
- keep test images out of Style Memory construction;
- freeze benchmark versions and publish changes;
- record the model/provider used by the evaluator;
- distinguish human-labeled ground truth, preference labels, and model-generated pseudo-labels;
- report failures and `review` outcomes rather than excluding them from denominators.

---

## 15. Model Provider Independence

Avoid binding to one model provider — define a model abstraction layer requesting capabilities (`analyze_image`, `compare_images`, `rank_images`, `generate_edit_plan`, `evaluate_render`) rather than depending on provider-specific APIs throughout the codebase. Candidate providers: OpenAI, Anthropic, local vision-language models, future multimodal models.

### 15.1 Privacy & Data Governance *(new)*

Photography workflows frequently contain identifiable people, private locations, client work, and EXIF/GPS metadata. Provider independence must therefore include a **data-path decision**, not only an API abstraction.

Default design goals:

- filesystem indexing and metadata extraction remain local;
- never upload original RAW files to a cloud provider unless a workflow explicitly requires and the user enables it;
- prefer purpose-built preview renders for VLM analysis when full RAW data is unnecessary;
- do not send EXIF/GPS metadata to a model provider unless that metadata is required for the requested task;
- clearly disclose which provider receives which images or metadata;
- provide a `local-only` mode that refuses network model calls rather than silently falling back to cloud;
- never persist provider credentials/tokens in session logs, checkpoints, or exported manifests;
- make temporary preview retention configurable and cleanable.

Suggested configuration:

```yaml
privacy:
  mode: local_preferred       # local_only | local_preferred | cloud_allowed
  allow_cloud_images: false
  allow_cloud_raw: false
  include_exif_in_model_context: false
  include_gps_in_model_context: false
  retain_preview_renders: session
```

Adapters/providers should expose their data boundary so the runtime can reject a workflow whose privacy requirements cannot be satisfied.

---

## 16. Agent Interface Support

Possible integrations: CLI, Codex skill, Claude skill, MCP server, desktop UI, Python SDK, REST API.

For early development, **CLI + core/runtime should be the canonical execution path**. Codex and Claude skills should call the same CLI/core APIs and contain only interface-specific instructions. They must not duplicate culling, editing, safety, retry, or Style Memory logic.

```text
Codex Skill ─┐
Claude Skill ├──→ CLI / Core API → Workflow Runtime → Adapters
Future UI ───┘
```

This keeps one source of truth for behavior and makes workflows testable without depending on any particular agent host.

---

## 17. CLI & Configuration

```bash
photo-agent cull ./shoot
photo-agent cluster ./shoot
photo-agent edit ./shoot --backend lightroom
photo-agent learn-style ./history --name john-v1
photo-agent edit ./shoot --style john-v1 --backend lightroom
photo-agent eval ./benchmark
```

```yaml
agent:
  mode: balanced

backend:
  type: lightroom

culling:
  duplicate_detection: true
  closed_eye_detection: true

editing:
  max_iterations: 3        # lowered default — see Section 5 cost/latency note
  preserve_skin_tones: true

style_memory:
  enabled: true
  profile: john-v1

runtime:
  resume: true
  backend_lock: exclusive_mutations

safety:
  overwrite_originals: false
  overwrite_presets: false

privacy:
  mode: local_preferred
  allow_cloud_images: false
  allow_cloud_raw: false
  include_gps_in_model_context: false
```

---

## 18. Plugin System & OSS Positioning

Future third-party modules: backend plugins, culling plugins, style extractors, exporters, model providers, evaluation modules.

```text
photo-agent
   ├── built-in plugins
   └── community plugins
```

**Positioning:** avoid "AI Lightroom preset generator." Better: *"Open-source agentic photography workflow for RAW culling, editing, style learning, and photo-editor automation."* Tagline options: *"An open-source AI agent that learns how you edit photos"* or *"Cull, edit, review, and refine RAW photos with an AI agent that works across editing backends."*

**Differentiators:** backend-agnostic; agentic closed-loop editing; RAW-aware workflows; style memory; full-shoot batch workflow; non-destructive editing; real editor integration; reproducible eval framework; human-in-the-loop safety; open-source extensibility — plus, honestly stated, transparent about what's inherited from upstream open-source work (Section 3) and what's original.

Third-party plugins should publish a machine-readable manifest containing at least `plugin_type`, `plugin_version`, `core_api_version`, capabilities, trust boundary, and operation semantics. The core must reject incompatible major API versions rather than best-effort loading a plugin and failing halfway through a shoot.

---

## 19. Risk Register *(new)*

| Risk | Impact | Mitigation |
|---|---|---|
| VLM evaluation judgments treated as ground truth | Silent convergence on wrong edits at scale | Human-labeled benchmark + agreement metric (Section 14); log rationale, not just verdicts |
| Iteration cost/latency unbounded at shoot scale | Slow/expensive full-shoot runs | Low default `max_iterations`; report cost per session before batch propagation |
| `.lrtemplate` round-trip unverified | False claim of "Lightroom-compatible" presets | Keep `export_preset` experimental until actual re-import + visual validation is closed; do not block unrelated core milestones |
| Schema drift across v0.x as adapters evolve | Breaking changes without a migration path | Semver schemas from first public release; explicit migrations/golden vectors |
| Adapter capability/trust conflation | Safety assumptions leak across backends | Capability + trust + operation-semantics contract (Section 7) |
| Non-idempotent retry after timeout | Duplicate or compounded edits | Backend state readback before retry; checkpoint reconciliation; state-machine guard |
| Concurrent jobs mutate GUI/editor selection | Jobs edit the wrong photo or corrupt each other's state | Exclusive backend lease for unsafe mutations; explicit concurrency semantics |
| Partial run/crash after hundreds of photos | Lost progress or inconsistent shoot state | Durable per-job state, checkpoints, resume/reconcile path (Section 13) |
| Cloud model receives private photos/EXIF unexpectedly | Privacy/client trust failure | Explicit privacy mode, provider disclosure, local-only mode, preview-first transfer (Section 15.1) |
| Semantic→parameter translator changes meaning | Same intent produces materially different edits after upgrade | Version translator, golden-vector tests, record translator/schema version |
| Style Memory benchmark leakage | Inflated personalization metrics | Hold out entire shoots; separate memory construction and eval data |
| Provider/model nondeterminism | Runs are hard to reproduce/debug | Record model/provider/config/workflow versions and hashes; compare distributions, not assume bitwise determinism |
| Plugin API drift | Third-party backend breaks mid-workflow | Plugin manifest + core API version handshake; reject incompatible major versions |
| Upstream fork drift (`Automaat/lightroom-mcp`) | Losing fixes or attribution confusion | Track upstream explicitly; document fork relationship and merge strategy |

---

## 20. Suggested Development Roadmap *(re-scoped)*

### v0.1-alpha — Core Extraction & One-Photo Baseline

Deliverables:

- standalone repository + license/provenance docs;
- versioned schemas;
- workflow runtime/state machine;
- filesystem ingestion for a single RAW/preview pair;
- semantic intent → normalized parameter translation;
- Lightroom adapter with capability/trust/operation-semantics declaration;
- CLI as the canonical execution path;
- one-photo `analyze → plan → apply → render` workflow;
- durable session manifest/log/checkpoint;
- basic golden-vector and integration tests.

**Success condition:** from a clean clone, a developer can run one documented command against one test photo and produce a traceable edited preview through the Lightroom backend, with the entire operation recorded in session state. No culling, clustering, Style Memory, full-shoot orchestration, or second provider is required yet.

### v0.1 — First Publicly Usable Core

Deliverables: hardened single-photo workflow; configuration; failure reconciliation; backend lease/locking; XMP fallback for the supported global-edit subset; reproducible example fixtures; README demo; thin Codex skill wrapping the same CLI/core path.

The `.lrtemplate` export/re-import gap should be closed **before `export_preset` is advertised as stable**. It does not need to block the rest of v0.1 if preset export is clearly marked experimental and the core workflow does not depend on it.

**Success condition:** a non-author user can clone the repo, follow the README, process a sample or their own single RAW non-destructively, and recover safely from an interrupted run.

### v0.2 — Closed-Loop Editing

Deliverables: dedicated `render_preview`; image evaluation with logged rationale; iterative edits; stall detection; acceptance/review states; checkpoint-aware rollback semantics; per-session iteration/cost reporting; human-review escalation.

**Success condition:** the agent applies an edit, inspects its own render, identifies issues, refines the photo, and reaches `ACCEPTED` or `REVIEW_REQUIRED` without silently exhausting retries.

### v0.3 — Culling, Clustering & Full-Shoot Workflow

Deliverables: RAW/JPEG pairing at scale; duplicate/burst grouping; culling; scene-aware clustering; representative selection; safe batch propagation; job isolation; resumable batch orchestration; session report.

**Success condition:** a real shoot of hundreds of RAW files reduces to a structured shortlist with representative initial edits, and a crash or failed photo does not invalidate completed work.

### v0.4 — Style Memory

Deliverables: explicit preference rules; historical edit statistics; similarity retrieval; scene-conditioned `StylePrior`; held-out personalization evaluation; reference-image matching.

**Success condition:** the system demonstrates repeatable personalization on held-out shoots and reports the evidence/confidence behind each style prior.

### v0.5 — Evaluation & Reliability

Deliverables: PhotoAgent Bench; frozen benchmark versions; evaluator/human agreement; pairwise preference evaluation; regression tests; backend compatibility tests; translator golden vectors; model comparison tests.

**Success condition:** releases can demonstrate measurable quality/reliability changes rather than only feature growth.

### v0.6 — Multi-Provider Support

Deliverables: provider abstraction; OpenAI integration; Anthropic integration; at least one local-model experiment; privacy-mode enforcement; provider benchmarking.

**Success condition:** the workflow can change model provider without changing core workflow semantics, and `local_only` correctly rejects cloud-dependent execution.

### v0.7 — Ecosystem Expansion

Deliverables: versioned plugin API; additional RAW-editor backend; plugin manifest/API handshake; third-party adapter docs; community templates; sample workflows.

**Success condition:** an external developer can add a backend/provider module without modifying the core, and incompatible plugins fail at load time rather than mid-session.

### v1.0 — Stable Photography Agent Platform

Reliable culling; reliable RAW grouping; resumable workflow runtime; closed-loop editing with calibrated evaluators; Style Memory; Lightroom backend; at least one non-Lightroom backend; stable versioned schemas; CLI; eval framework; documented plugin API; privacy modes; production-quality recovery and safety; complete licensing/attribution documentation.

---

## 21. Near-Term Priorities *(v2.1 order)*

```text
1. Split the original workflow/skill into an independent repo + preserve provenance
2. Define versioned core schemas
3. Build Workflow Runtime / State Machine + durable session/job state
4. Define adapter capability + trust + side-effect/concurrency contract
5. Define Semantic Intent → Normalized Parameter translation
6. Build Lightroom Adapter around that contract
7. Build the canonical CLI path
8. Run one RAW end-to-end: analyze → plan → apply → render
9. Add checkpoint/reconcile/resume behavior and backend locking
10. Preserve a constrained XMP fallback
11. Separate render_preview from export_final
12. Add first real-photo technical + human preference evals
13. Add closed-loop evaluator + stall/review logic
14. Add culling/clustering and then batch orchestration
15. Add Style Memory only after the basic edit/eval loop is measurable
16. Add a second model provider/backend after contracts are proven
17. Begin larger public launch/community growth
```

Do not spend early development time on a large desktop UI, cloud infrastructure, many backends/providers, account systems, proprietary hosting, or a complex plugin marketplace. Prove the single-photo runtime, safety model, and measurable edit loop first.

---

## 22. Open-Source Growth Strategy

Best growth mechanism is visual demonstration. Start with the smallest demo that proves the architecture before advertising shoot-scale autonomy.

**Demo 0 — One-photo auditable loop:** one RAW → semantic plan → normalized parameters → Lightroom edit → preview → session trace.

**Demo A — Culling:** 800 RAW files → 160 selects → duplicate groups → closed-eye rejection → confidence report.
**Demo B — Closed-Loop Edit:** RAW → first AI edit → rendered preview → AI critique → second edit → final result (with cost/iteration count shown, per Section 19's risk mitigation).
**Demo C — Style Memory:** previous edited photos → learn style → new RAW → personalized edit.

Channels: GitHub README GIFs, Reddit, Hacker News, X, Threads, YouTube, photography communities, MCP communities, AI agent communities.

---

## 23. Repository Quality Goals

```text
README.md
README.zh-TW.md
LICENSE
NOTICE.md / THIRD_PARTY.md   ← new, per Section 3
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
PRIVACY.md
CHANGELOG.md
ROADMAP.md
ARCHITECTURE.md
docs/
  adr/
examples/
tests/
evals/
.github/
```

Also: CI; release tags; semantic versioning (schemas + plugin/core API included); issue templates; PR template; golden-vector tests; resumability/crash tests; automated tests; screenshots; demo GIF; architecture diagram; adapter capability manifests.

---

## 24. Long-Term OSS Goal

The project should stay valuable even if the original author stops using Lightroom. The real asset is not "Lightroom automation" — it's:

```text
AI-native photography workflow logic
+ resumable workflow runtime / state machine
+ backend abstraction (capability + trust + operation semantics)
+ semantic-intent → normalized-parameter translation
+ style learning
+ calibrated technical + preference evaluation
+ privacy-aware provider abstraction
+ community adapters
+ honest provenance (what's original vs. inherited from upstream)
```

---

## 25. North Star

> A photographer points the agent at a shoot and says:
>
> **"Pick the best photos, group them by lighting, edit them in my style, and show me anything you're unsure about."**
>
> The agent performs that workflow safely, resumably, transparently, and across different photo-editing backends — while showing what changed, what data left the machine, and what it is actually confident in.
