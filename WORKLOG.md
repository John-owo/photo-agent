# photo-agent work log

This is the first file every agent reads. Keep entries factual, append-only by
date, and scoped to material changes or verification. Prefer the named files and
targeted searches below over repository-wide scans.

## 2026-08-12 - v0.2 and v0.3 continuation

Baseline observed:

- Branch `codex/v0.1-alpha` was one local commit ahead of
  `origin/codex/v0.1-alpha` at `f8a1ab7`.
- Pre-existing uncommitted edits were present in `README.md` and
  `README.zh-TW.md`; preserve them.
- `npm.cmd run check`: passed.
- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed, 1 file and 12 tests.
- `npm.cmd run build`: passed.
- `npm.cmd run format:check`: failed on 19 pre-existing files. This is a known
  repository-wide formatting baseline, not a functional-test failure. Do not
  bulk-format unrelated files.

Updates in progress:

- Added `src/evaluation.ts` with evaluator contracts/helpers and deterministic
  evaluators for closed-loop tests.
- Added the initial `src/batch.ts` read-only shoot index/dry-run orchestration.
- Extended schemas/types/runtime for v0.2 evaluation states and v0.3 shoot
  manifests. These changes have not yet passed the post-change test suite.
- Updated `AGENTS.md` to require this work log and targeted searches.

Unverified boundaries:

- No live Lightroom MCP connection, Lightroom mutation, Lightroom render, human
  visual QA, or real-shoot run has been performed in this continuation yet.
- v0.2 and v0.3 are not complete until the later work-log entry records their
  tests and remaining limitations.

### Implementation checkpoint

- Extended the single-photo controller in `src/workflow.ts` with bounded
  `APPLYING -> RENDERING -> EVALUATING -> REFINING` iterations, terminal
  `ACCEPTED`/`REVIEW_REQUIRED` states, per-iteration checkpoints/read-backs,
  evaluator rationale artifacts, render/plan stall detection, a maximum of ten
  iterations, and `iteration-report.json` token/cost/time accounting.
- Added CLI opt-in `--evaluator mock --max-iterations <1-10>` and a read-only
  `shoot` command. No real Lightroom operation is enabled implicitly.
- Added v0.3 schemas and a conservative shoot dry run that indexes RAW/preview
  pairs, hashes sources, isolates per-photo analyzer failures, reports exact-file
  duplicates, groups lighting classifications, and emits `manifest.json`,
  `culling.csv`, `clusters.json`, and durable job records. With no configured
  visual analyzer, every image remains `review`; no subjective selection is
  invented and no Lightroom rating/label is written.
- Post-change type/lint/test/build verification has not run yet.

### Verification checkpoint 1

- `npm.cmd run check`: passed after v0.2/v0.3 implementation.
- `npm.cmd run lint`: passed.
- `npm.cmd test`: failed with 1 regression and 16 passes. All 5 new milestone
  tests passed, including the 120-pair dry run. The failing v0.1 test expected
  `checkpoints/before.json`, while the new controller only wrote
  `checkpoints/iteration-1-before.json`.
- Root cause: v0.2 versioned iteration artifacts unintentionally removed the
  stable v0.1 artifact alias. Fix must retain both, not weaken the old test.

### Verification checkpoint 2

- Added compatibility aliases for v0.1 while retaining v0.2 iteration artifacts:
  `checkpoints/before.json`, `backend-readback.json`, and `render.json` mirror the
  first iteration.
- Targeted regression command passed: 1 selected test passed, 11 skipped.
- `npm.cmd run check`: passed.
- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed, 2 files and 17 tests.
- `npm.cmd run build`: passed.
- Automated verification now covers accept, refine-then-accept, repeated-plan/render
  stall escalation, ambiguous/missing pairing, 120-pair indexing, and per-photo
  failure isolation.
- This validates mock/backend-independent behavior only. Live Lightroom, real VLM
  judgment, real-shoot quality, and human visual acceptance remain unverified.

### Documentation checkpoint

- Updated both README languages with a responsibility table and the one-way
  dependency `photo-agent -> lightroom-mcp`.
- Recorded that PhotoAgent was extracted during v0.1, Lightroom MCP remains a
  standalone backend, and new workflow-engine work belongs in this repository.
- README status now says v0.3 development while preserving the unreleased
  `0.1.0-alpha` package version and alpha warning.

### Verification checkpoint 3

- `npm.cmd run check`, `npm.cmd run lint`, `npm.cmd test` (17/17),
  `npm.cmd run build`, and `git diff --check`: passed.
- Targeted Prettier check failed on six files changed by this continuation:
  `src/evaluation.ts`, `src/batch.ts`, `tests/milestones.test.ts`,
  `src/workflow.ts`, `src/schemas.ts`, and `src/types.ts`.
- Only these six files will be mechanically formatted; the unrelated 19-file
  repository formatting baseline remains untouched.

### Verification checkpoint 4 - stop boundary

- Mechanically formatted only the six continuation-owned TypeScript/test files.
- Final `npm.cmd run check`: passed.
- Final `npm.cmd run lint`: passed.
- Final `npm.cmd test`: passed, 2 files and 17 tests.
- Final `npm.cmd run build`: passed.
- Final `git diff --check`: passed.
- Targeted Prettier check over continuation-owned source/tests plus
  `AGENTS.md`/`WORKLOG.md`: passed.
- v0.2 automated exit behavior is implemented and mock-verified. v0.3 has a
  functional read-only index/cull/classify/cluster/report path and 120-pair test,
  but the roadmap's real-shoot exit gate is not claimed: visual culling quality,
  representative Lightroom edits, crash-resume from a partially completed shoot,
  and a real hundreds-photo run remain future verification/implementation work.
- Stop here to honor the user's remaining-usage boundary. Do not mark the goal
  complete; continue from this entry without rescanning the repository.

## 2026-08-12 - v0.3 resume and propagation continuation

Implementation checkpoint:

- Added a durable `shoot-plan.json` before analysis begins and atomic JSON writes
  for plan, job, manifest, and cluster state.
- Added `resumeShootDryRun`: schema-valid completed or failed jobs are reused and
  never silently re-run; only missing/invalid job records are analyzed. The final
  report records reused versus newly analyzed counts.
- Added filename-sequence burst grouping alongside exact-content duplicate groups.
- Representative selection is now deterministic within each lighting cluster:
  highest-confidence `select`/`keep`; otherwise no representative is invented.
- Added `createSafePropagationPlan`: it requires an explicit parameter allowlist,
  excludes white balance/temperature/tint and non-shortlisted or ambiguous assets,
  and emits a plan with `requires_explicit_apply: true`. It does not mutate
  Lightroom.
- Post-change verification has not run yet.

Real-shoot and documentation checkpoint:

- Built the CLI and ran a read-only dry run on the bounded shoot folder
  `D:\photo\2026\2026.6.19 畢業典禮` (153 NEF, 135 JPG in the preflight count).
- Result: 153 assets/jobs, 0 failures, 153 `review`, 0 select/keep/reject, one
  conservative unknown-lighting cluster, 0 exact duplicate groups, and 10
  filename-sequence burst groups. No photo, sidecar, rating, label, or Lightroom
  state was modified.
- Resuming the same session reused all 153 jobs, analyzed 0, and completed in
  79 ms. Reports are under
  `D:\photo\_agent_workspace\photo-jobs\photo-agent-v0.3-validation\2026-08-12T13-17-16.296Z-2cabcbb0`.
- Changed shoot CLI output from the full manifest to a concise summary plus the
  report path to avoid terminal/context waste.
- Added `docs/implementation/v0.2.md` and `v0.3.md`, and documented mock closed
  loop plus shoot/resume commands in both README languages.
- Full post-documentation verification is pending.

Representative/editing checkpoint:

- Added `runRepresentativeEdits`, which sends only cluster representatives with
  high-confidence source pairing through the existing v0.2 closed loop and
  isolates failures per cluster.
- Added `applyPropagationPlan`, which refuses to run without
  `confirmApply=true`, serializes mutations under a lock, verifies the target RAW
  path, creates a per-photo checkpoint, applies only the filtered global plan,
  reads back every value, and escalates uncertain post-mutation state without a
  retry.
- Added schema-validated review-file input for explicit user/Codex culling and
  lighting decisions. Missing entries stay `review`; no selection is invented.
- Targeted v0.3 suite passed with 8 tests after these changes. Full repository
  verification is pending.

Cloud-analyzer checkpoint:

- Added an opt-in OpenAI visual evaluator for the v0.2 render loop and an opt-in
  OpenAI culling/lighting analyzer for v0.3. Both require explicit cloud-preview
  authorization; PhotoAgent creates sanitized per-session JPEG inputs rather than
  sending source paths or source files directly. Default and review-file analyzers
  remain local and conservative.
- Added automated privacy-boundary coverage: cloud evaluators/analyzers are
  rejected before an image is sent unless cloud preview is explicitly allowed;
  allowed fakes receive only the sanitized session copy.
- Before the v0.3 analyzer addition, `npm.cmd run check`, `npm.cmd run lint`,
  `npm.cmd test` (21/21), and `npm.cmd run build` passed.
- The first post-v0.3-analyzer `npm.cmd run check` failed at `src/batch.ts:349`:
  TypeScript inferred a union containing `ConservativeShootAnalyzer`, whose
  concrete class did not declare the interface's optional
  `requiresCloudPreview` property. No runtime or photo operation ran.
- Root-cause fix: explicitly mark the conservative and review-file analyzers as
  `requiresCloudPreview = false`. Post-fix verification is pending.
- Targeted Prettier formatting reported all touched cloud-analyzer files
  unchanged, and the post-fix `npm.cmd run check` passed.
- Targeted cloud-boundary verification passed: 2 selected tests passed and 8
  unrelated milestone tests were skipped.
- `npm.cmd run lint`: passed.
- `npm.cmd test`: passed, 2 files and 22 tests.
- `npm.cmd run build`: passed.
- These tests use injected fakes. No OpenAI request, Lightroom mutation, photo
  modification, or subjective visual-quality claim was made.
- Documentation/CLI review then found that `resume` accepted an OpenAI evaluator
  but did not carry the `--allow-cloud-preview` consent flag into
  `resumeCodexSession`. That could bypass the intended explicit-consent boundary
  after a local Codex handoff. No live cloud call was made while finding it.
- Fixed the resume API and CLI to require and propagate the flag, reject before
  processing/changing the session or calling the backend/evaluator, and added a
  regression assertion that the evaluator and backend receive zero calls.
- Post-fix verification for this privacy repair is pending.
- Targeted formatting, `npm.cmd run check`, and the two workflow tests matching
  `cloud` passed after the resume repair; 10 unrelated workflow tests were
  skipped by the targeted run.
- Updated both README languages and the v0.2/v0.3 implementation records with
  the explicit opt-in commands, sanitization boundary, one-request-per-asset
  behavior, local conservative default, and honest live-verification limits.
- Final post-documentation `npm.cmd run check`: passed.
- Final `npm.cmd run lint`: passed.
- Final `npm.cmd test`: passed, 2 files and 22 tests.
- Final `npm.cmd run build`: passed.
- Final `git diff --check`: passed; Git emitted only existing line-ending
  normalization warnings.
- Targeted Prettier check over all continuation-owned source, tests, docs,
  READMEs, `AGENTS.md`, and this work log: passed.
- The implemented cloud paths remain fake-verified only. No live cloud request,
  Lightroom mutation/render, photo write, or human visual QA was performed.
- Updated the workspace-level `D:\photo\AGENTS.md` so every agent must read the
  active project's nearest work log first, use its targeted paths/searches, and
  append all material changes plus pass/fail checks. This reinforces the same
  repository-level rule without scanning the photo library.
- Workspace-policy literal checks confirmed the nearest-work-log, targeted-search,
  no-photo-root-scan, and append-pass/fail requirements are present.
- Post-instruction targeted Prettier check for this log and `git diff --check`
  passed; Git emitted only line-ending normalization warnings.
- Completion-audit documentation fix: `.env.example` and both README language
  tables now state that `OPENAI_API_KEY`/model configuration also applies to the
  opt-in edit evaluator and shoot analyzer, not only the original analysis
  provider. No runtime behavior changed.
- Completion audit found that a direct `runShootDryRun` call checked cloud consent
  only after creating its durable session. It still sent no image, but left an
  unnecessary empty/plan session on refusal.
- Added the consent guard before session creation and a regression assertion that
  the blocked session root does not exist. Resume keeps its own independent guard.
- Targeted Prettier invocation reported one expected tooling failure: Prettier
  cannot infer a parser for `.env.example`. It formatted/confirmed the five
  supported changed files; `.env.example` is a two-line comment/config change and
  was instead covered by `git diff --check`.
- Post-fix `npm.cmd run check`: passed.
- Targeted cloud-boundary tests: 2 passed, 8 unrelated milestone tests skipped.
- `npm.cmd run lint`: passed.
- Full `npm.cmd test`: passed, 2 files and 22 tests.
- `npm.cmd run build`: passed.
- `git diff --check`: passed with only line-ending normalization warnings.

## 2026-08-12 - authorized publish preparation

- User authorized pushing both repositories.
- Confirmed this worktree's complete tracked and untracked change set is the
  v0.2/v0.3 implementation, tests, documentation, agent rules, configuration
  example, and this append-only work log. It is the scope intended for the
  `photo-agent` commit.
- Current branch is `codex/v0.1-alpha`; remote is
  `https://github.com/John-owo/photo-agent.git`. No default-branch switch is
  required.
- Pre-push full checks were already recorded above: check, lint, 22 tests, build,
  diff check, and targeted formatting all passed. No photo or Lightroom state was
  changed.
- Fresh pre-push verification: `npm.cmd run check`, `npm.cmd run lint`,
  `npm.cmd test` (2 files, 22 tests), `npm.cmd run build`, `git diff --check`,
  and targeted Prettier check over the publish scope all passed. Git reported
  only its normal LF-to-CRLF normalization warnings.
- Staged-scope audit: exactly 19 confirmed v0.2/v0.3 implementation, test,
  documentation, configuration, agent-rule, and work-log paths are staged;
  `git diff --cached --check` passed.
- First authorized `git push origin codex/v0.1-alpha` failed before contacting
  GitHub because the restricted environment could not connect to `github.com:443`.
  The commit remained local and unchanged; an approved network retry is pending.

## 2026-08-12 - independent verification continuation

- Confirmed the active checkout remains `codex/v0.1-alpha` at `f8a1ab7`, with the v0.2/v0.3 implementation changes uncommitted and no changes in `lightroom-mcp-john`.
- `npm.cmd run check`: passed in the active worktree after re-running the verification for this task.
- `npm.cmd run lint`: passed in the active worktree after re-running the verification for this task.
- Network retry reached GitHub, but `origin/codex/v0.1-alpha` contains remote
  commits not present locally, so the push was rejected as non-fast-forward.
  No force-push was attempted; fetch-and-divergence review is required.
- Fetched `origin/codex/v0.1-alpha` at `6702c89`. It is a merge commit whose
  tree is identical to the local v0.1 base `f8a1ab7`; the remote-only history
  is the already-published v0.1 merge, not conflicting file content. A normal
  rebase of the new v0.2/v0.3 commit onto that remote branch is safe.
- `npm.cmd test`: passed; 2 test files and 22 tests passed, including the v0.2
  closed-loop and v0.3 shoot/resume/propagation/privacy milestone coverage.
- `npm.cmd run build`: passed; TypeScript emitted the production build without
  errors.
- `git diff --check`: passed with no whitespace errors in tracked changes.
- Targeted `npx.cmd prettier --check` over the v0.2/v0.3 source, tests,
  documentation, README, agent rules, and work log failed: Prettier reported
  style issues in all 18 requested files. This is a formatting-only failure;
  no formatter write was performed, so existing/unrelated formatting was
  preserved for review rather than bulk-reformatted during test verification.
- Publish follow-up: the current checkout's fresh targeted Prettier check over
  the actual publish scope passed before commit/push; the earlier formatting
  failure entry above is retained as historical evidence from the independent
  continuation and was not overwritten.
- Authorized push succeeded: `origin/codex/v0.1-alpha` advanced from `6702c89`
  to `f6bb3ef`. The GitHub branch now contains the v0.2/v0.3 publish scope.
- `node dist/src/cli.js --help`: passed and exposed the v0.2 edit/resume/recover/
  export-xmp commands plus the v0.3 shoot/resume commands, including explicit
  cloud-preview and analyzer options.
