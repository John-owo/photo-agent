---
name: photo-agent
description: Run the John-owo/photo-agent CLI (checkout at D:\work\photo-agent, run with `node D:\work\photo-agent\dist\src\cli.js`) for traceable RAW edits with the Lightroom MCP backend, including local radial/linear masks and unattended overnight batches where you (the agent) look at every preview and render yourself. Use for "修這批圖", "過夜修圖", "overnight edit this folder", edit-one, resume, continue, batch, recover, restore-masks, shoot or export-xmp.
---

# photo-agent

A thin wrapper around the repository CLI. Never implement a second workflow,
never upload RAW, EXIF or GPS data, and never edit a Master photo: every edit
lands on a photo-agent Workflow Copy (virtual copy) that the user can delete.

Paths used below:

- CLI: `node D:\work\photo-agent\dist\src\cli.js` (run `npm.cmd run build` in
  `D:\work\photo-agent` first if `dist` is missing or older than `src`).
- Lightroom MCP server entry: the `server\dist\index.js` of the lightroom-mcp
  checkout that has mask readback (until the PRs merge:
  `D:\work\lightroom-mcp-masks\server\dist\index.js`). Pass it with
  `--lightroom-mcp-entry` or `PHOTO_AGENT_LIGHTROOM_MCP_ENTRY`.

## Overnight batch (the default request: "睡前修這批圖")

The user gives a folder and goes to sleep. Do not ask follow-up questions you
can answer yourself; record doubts in the JSON rationale instead.

1. **Preflight** (stop and tell the user only if one of these cannot be fixed):
   - Lightroom Classic is running (start it with
     `Start-Process 'C:\Program Files\Adobe\Adobe Lightroom Classic\Lightroom.exe'`
     and wait about a minute) and the photos are in the open catalog.
   - The Lightroom bridge is free. photo-agent starts its own MCP server; if it
     fails with `Another Lightroom MCP bridge is already running ... (pid N)`,
     inspect PID N's parent. Stop it only if that parent is your own agent
     process (your own lightroom MCP connection, which this flow does not
     need). Never stop a bridge owned by another session; report it instead.
   - Keep the machine awake: use a keep-awake tool if you have one, otherwise
     tell the user before they leave that Windows sleep will pause the run.
2. **Start**: `batch --root <FOLDER> --backend lightroom --lightroom-mcp-entry <ENTRY>`
   (defaults: `--provider codex --evaluator handoff --mode unattended
--max-iterations 3`). Note the `batchDir` it prints.
3. **Loop** until `waiting_for_agent` is 0:
   - Read `<batchDir>\worklist.md`. For each item, read its `request` file and
     look at the listed image(s) yourself (and the `before` preview for
     evaluate items).
   - `analyze` item: write one `SemanticIntentPlan` JSON to `output`
     (contract below).
   - `evaluate` item: compare the render with the before preview and write one
     `EvaluationResult` JSON to `output`, with one `mask_feedback` entry per
     listed mask.
   - Run `batch --resume <batchDir> --backend lightroom --lightroom-mcp-entry <ENTRY>`.
   - For large folders you may hand single items to subagents (give them the
     request path, image paths and output path); only you run `batch --resume`.
4. **Finish**: read `<batchDir>\report.md` and summarise it for the user in
   Traditional Chinese: done / needs review / failed, and which masks were
   halved, removed or degraded.

If the batch stops early (`stoppedEarly`), fix the cause (Lightroom closed,
bridge lock) and run `batch --resume`; finished photos are skipped and an
interrupted photo is only read back with `recover`, never re-applied.

## Analysis rules (SemanticIntentPlan)

- `schema_version: "0.1.0"`, `creative_goal`, `adjustments` (at most one per
  parameter: exposure, temperature, tint, contrast, highlights, shadows,
  whites, blacks, texture, clarity, dehaze, vibrance, saturation; each with
  `direction` increase/decrease/unchanged, `strength` slight/medium/strong,
  `rationale`, `confidence`), `overall_confidence`, optional `masks`.
- Prefer global adjustments. Add a mask only when one region needs different
  treatment and a global change would hurt the rest (darken a bright sky with
  a linear gradient, lift a backlit face with a radial mask, a subtle
  inverted-radial vignette). At most 3 masks, at most 4 parameters each.
- Mask geometry is in fractions of the frame, x right and y down. Radial:
  `center_x, center_y, width, height, angle_deg, feather (50-90 looks natural),
invert (false = inside)`. Linear: effect 100% at `full_x/full_y`, 0% at
  `zero_x/zero_y`. Only `radial` and `linear` exist: no brush, subject, sky
  or other AI masks.
- `placement_certainty: "subjective"` when the location is a taste call or
  the edge is unclear; in unattended mode it is still applied and judged by
  your evaluation.
- Confidence below 0.65 is dropped by the translator; be honest.
- When unsure about a colour grade, you may search the web for how similar
  scenes are commonly graded and name the reference style in
  `creative_goal`. Do not scrape Instagram or other login-only sites, and do
  not copy a specific photographer's edit.

## Evaluation rules (EvaluationResult)

`{"schema_version":"0.2.0","verdict":"accept|refine|review","confidence":0-1,"rationale":"...","issues":[...],"refinement_plan"?:{...},"mask_feedback"?:[{"mask_id","assessment":"ok|too_strong|misplaced|unnecessary","note"}]}`

- `accept` only when nothing material remains and every mask is `ok`.
- `refine` needs `refinement_plan` with small global deltas
  (`{"schema_version":"0.1.0","operations":[{"parameter":"exposure_ev|temperature_k|tint|contrast|highlights|shadows|whites|blacks|texture|clarity|dehaze|vibrance|saturation","mode":"delta","value":n,"confidence":0-1,"rationale":"..."}],"warnings":[]}`).
  Never add masks here; adjust them only through `mask_feedback`.
- `too_strong` = halo, hard edge, blotch, brightness or colour step: the mask
  is halved. `unnecessary` removes it. `misplaced` removes it in unattended
  mode (stops for review in interactive mode).
- `review` for skin-tone, mixed-light or taste calls you cannot settle; the
  edit stays on the Workflow Copy and appears in the morning report.

## Single photo

1. `edit-one --raw <RAW> --preview <JPEG> --backend lightroom --provider codex`
   creates `codex-analysis-request.md`; write `codex-intent.json`.
2. `resume --session <DIR> --intent-file <DIR>\codex-intent.json --backend lightroom --apply --evaluator handoff [--mode unattended]`
   applies, renders and pauses in `EVALUATION_INPUT_REQUIRED`.
3. Write `evaluations\iteration-N-input.json`, then
   `continue --session <DIR> --evaluation-file <that file> --backend lightroom`.
   Repeat until the session ends `ACCEPTED` or `REVIEW_REQUIRED`.

Interactive mode (default for edit-one/resume) holds `subjective` masks until
`--approve-masks <ids|all>` and never writes masks when the backend cannot read
existing ones (`--allow-mask-replace` overrides for the Workflow Copy).

## Recovery and rollback

- After any interruption: `recover --session <DIR> --backend lightroom`. It
  only reads back state and never retries a mutation.
- Lightroom checkpoints cannot hold masks. To undo masks on the Workflow Copy:
  `restore-masks --session <DIR> --iteration N --backend lightroom`.
- The Master is never edited; deleting the Workflow Copy undoes everything.
