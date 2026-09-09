# PHOTOAGENT project instructions

Rule set: PHOTOAGENT-20260905.

## 必要照片安全

- Never delete, rename, or overwrite a photo, RAW, JPEG/HEIC/TIFF, sidecar,
  preview, or export. This includes derived images and Lightroom-managed storage.
- Automated Lightroom Develop mutations target only an identity-verified
  **Workflow Copy**. Verify Copy ID/UUID, its Master relationship, catalog identity,
  and operation/session identity; a shared file path is not identity proof.
- Preserve the source asset and **Master Develop State**. Never modify the Master.
  Read-only Master inspection is allowed; create a Copy only for an authorized,
  executable edit. Retain existing Copies and reconcile the exact Copy on resume.
- Missing capability, uncertain identity, selection restoration failure, or an
  uncertain mutation result means **REVIEW_REQUIRED**. Stop mutations; read back
  and reconcile before any further action. Never blindly retry or create a second
  Copy to resolve uncertainty. Serialize Lightroom operations.
- A **Checkpoint is recovery evidence, not true Lightroom undo**. It does not
  replace a Workflow Copy or prove restoration of catalog, masks, files, or UI.
- Actual Lightroom execution and human render acceptance are separate gates.
  Only a recorded user `render PASS` satisfies the human gate for that exact run.

## Authority, scope, and first read

- This `AGENTS.md` is the authoritative project instruction entry. Any `CLAUDE.md`
  is a one-way compatibility pointer, not another maintained rule source.
- When working under `D:\photo`, read `D:\photo\AGENTS.md` and consult
  `D:\photo\PHOTO_WORKSPACE.md` for local paths. Do not assume an outer rule file
  was automatically loaded by Codex. Read each rule source once per task; do not
  follow already-read parent/project references repeatedly. The safety rules above
  also apply elsewhere.
- Start with the short current-state source below, then inspect this checkout's
  branch, HEAD, package version and dirty status. Use a supplied handoff only if
  its worktree/commit matches; otherwise treat it as historical evidence.
- Read only the relevant `WORKLOG.md` sections using headings, targeted `rg`, or
  a bounded tail (normally 80-120 lines). Do not load the entire history by default.
- Keep status separate: implemented, local tests passed, live Lightroom passed,
  human render accepted, merged, and deployed. Each claim needs its worktree,
  branch/commit, date and evidence. A package version is not an acceptance verdict.
  Local remote-tracking refs are cached evidence, not current remote verification.
- Current user scope controls actions. In a read-only task, do not create/append
  files (including logs), stage changes, fetch refs, build, test with output, start
  services, or call mutating tools. Report findings in chat; log only after write
  authorization. Tool names such as "read/export" do not prove no side effects.
- When writes are authorized, append material changes and exact verification
  commands/results (including failures and unrun boundaries) to this checkout's
  `WORKLOG.md`. Batch related checks in one factual entry; never rewrite history
  except an explicitly authorized, backed-up encoding repair.
- Preserve unrelated staged, unstaged and untracked changes. Worktree copies are
  independent; do not copy completion claims or bulk-update historical snapshots.
- User-approved delivery policy (2026-09-06): autonomously complete the normal
  commit/push/PR/merge, evidence-backed issue closure and deployment steps needed
  for the assigned implementation, fix or delivery. Do not require separate approval
  for each step. Stay within the task and verified target; preserve unrelated work
  and satisfy checks, required review and acceptance gates. Current read-only,
  local-only or no-publication instructions take precedence. Do not force-push,
  bypass protections, publish unrelated changes/messages or change repository features.
- The user authorizes bounded autonomous delegation. Choose gpt-5.6-luna for
  straightforward or repetitive work and gpt-5.6-sol for complex work, with suitable
  reasoning effort. Investigate missing information before reporting a real blocker;
  the main agent retains integration and final verification.
- Source/docs/tests and necessary builds belong in their repository's established
  paths. Extra reviews, backups, exports and audit output go under
  `D:\photo\_agent_workspace`. This exception never permits photo deletion or
  overwriting source images, sidecars, previews or exports.
- Documentation-only edits need link, encoding, instruction/type and scoped diff
  checks. Run code tests/builds only when the changed behavior or repository gate
  requires them; a prior pass is historical, not a test run in this task.

First state source: [photo-agent-t09-t58-t60-final-validation-matrix-20260901-v1.md](D:/photo/_agent_workspace/lightroom/handoffs/photo-agent-t09-t58-t60-final-validation-matrix-20260901-v1.md); read only its current-state block first. If this local handoff is unavailable,
use the short index in [WORKLOG.md](WORKLOG.md), verify the local checkout/HEAD,
and treat the recorded snapshot as historical until matched.

## PhotoAgent development and architecture

- PhotoAgent owns orchestration, safety/recovery policy, evaluation, culling,
  clustering and propagation. Lightroom MCP independently owns server/plugin,
  editor transport, catalog/Develop operations and render/export transport.
- Never send RAW or EXIF/GPS to providers. Cloud use requires explicit opt-in and
  a sanitized JPEG. Prefer `--provider codex`; resume only validated
  `codex-intent.json`. OpenAI remains an opt-in compatibility provider.
- `recover` reads/reconciles and never automatically retries mutations. XMP
  fallback creates a new sidecar and refuses existing sidecar/source destinations.
- Use this repository's `docs/agents/domain.md` and relevant accepted ADRs when
  design/terminology changes; `docs/agents/issue-tracker.md` governs ticket work.
  ADRs describe accepted decisions, not proof that release steps were executed.
- Use an explicitly selected, capability-verified backend. Do not infer the
  running server or plugin from an old checkout path or handoff. See the local
  workspace path map; a backend change needs its own authorized scope.
- For code changes use `npm.cmd run check`, `npm.cmd run lint`, `npm.cmd test`,
  and `npm.cmd run build` as applicable. Automated tests use mock backends.
  A live Lightroom check requires separate recorded scope and a non-critical Copy.
- `ROADMAP.md` is planning; `docs/implementation/v0.1-v0.3-direction.zh-TW.md`
  contains historical sequence, not a current instruction to redo v0.2/v0.3.
