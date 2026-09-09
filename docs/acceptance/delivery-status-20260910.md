# Delivery status — 2026-09-10

## Stable baseline

PhotoAgent PR #55 merged the validated T09 clean-clone/live evidence baseline into main (merge 86d45d1). The package remains alpha; this is not stable v1.0 acceptance. The original 2026-08-30 live and human render evidence is scoped to that case.

## Pending validation branch

`codex/pending-validation-20260910` preserves the latest implementation from 60ae26c plus existing uncommitted workflow Copy safety, plugin example and architecture documentation changes. Original working directories and indexes are retained. This branch includes implementation that must not be treated as accepted solely because automated tests pass.

Fresh local validation: check, lint, build and 195 tests passed. The plugin example creates and retains a new XMP with source preservation; its result correctly reports render_verified=false and visual_acceptance=REVIEW_REQUIRED. No Lightroom operations or provider calls were performed for this delivery.

## Remaining development and acceptance

### Incomplete editor/backend capabilities

- Existing-mask adjustment has planning/schema/validation code; complete the actual supported editor operation and exact live acceptance before enabling it.
- Sky mask creation is not a supported verified path. Do not infer Sky support from the separate Brush/Subject cases.
- AI Denoise, Calibration and Point Color remain outside the verified automated editor controls. Modern Color Grading planning exists, but a truthful supported backend path must be proven rather than approximated with legacy controls.
- A separate full RAW editor integration beyond the limited create-only XMP backend is not delivered.

### Implemented, awaiting broader evidence

- T17–T27: shoot indexing, culling, scene clustering, representatives, propagation, resumable jobs and reports have source/tests. The hundreds-photo real-shoot gate needs the user's exact full shoot-folder path and live evidence.
- Brush/Subject and the 14-key XMP case have separately recorded human functional passes. These do not accept all masks, all files, aesthetic quality, general exposure-unit mapping or all editor paths. Preserve the historical failed Subject operation and later successful distinct operation.
- Style priors/history and held-out evaluation have code; real independent shoots, user preference evidence and perceptual evaluation remain.
- Benchmarks/evaluator calibration have contracts and tests; frozen real datasets, human comparison and cross-model measurements remain.
- Provider adapters, local provider boundary and privacy enforcement have code; real service/local-model and comparative benchmark validation remain.
- Plugin loading and XMP example exist; third-party end-to-end compatibility and broader production guarantees remain separate gates.
- Preset export/re-import compatibility remains experimental until a real target-editor round trip is accepted.

Open GitHub issues are acceptance work, not proof that no implementation exists. No milestone/version issue is closed by this branch publication.