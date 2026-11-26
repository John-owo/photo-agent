import { createHash } from "node:crypto";

import { MAX_ADJUSTMENTS_PER_MASK, MAX_MASKS_PER_PHOTO } from "./schemas.js";

/**
 * Prompts shared by every visual-model provider. The models only describe
 * intent (direction, strength, mask geometry in frame fractions); the
 * deterministic translator owns every Lightroom value and strength cap.
 */

const MASK_RULES = `Local masks are optional (at most ${MAX_MASKS_PER_PHOTO} per photo). Use one only when a region clearly needs different treatment from the rest of the frame and a global change would hurt other areas: for example darken a bright sky with a linear gradient, lift a shadowed subject or face with a radial mask, or add a subtle vignette with an inverted radial mask. Prefer global adjustments; return an empty masks array when global edits are enough.
Only two mask types exist: "radial" (ellipse) and "linear" (gradient). Never describe brush, subject, sky, people or other AI masks.
Coordinates are fractions of the full frame: x = 0 is the left edge and 1 the right edge; y = 0 is the top edge and 1 the bottom edge.
- radial: center_x/center_y, ellipse width/height as fractions of the frame, angle_deg (0 = axis-aligned), feather 0-100 (50-90 gives a natural falloff), invert=false applies the effect inside the ellipse, invert=true outside it.
- linear: the effect is 100% at full_x/full_y and fades to 0% at zero_x/zero_y; points may sit slightly outside the frame.
Each mask has at most ${MAX_ADJUSTMENTS_PER_MASK} parameters. Use slight or medium strength unless the problem is severe; the translator caps local strength anyway.
Set placement_certainty to "subjective" whenever the position is an aesthetic choice or the region boundary is not clearly visible in the preview; use "clear" only for unambiguous regions such as a sky above a straight horizon. Give each mask a short lowercase id (letters, digits, hyphens) and a concrete target description.`;

export const PROMPT_VERSION = "semantic-intent-v0.2.0";
export const PROMPT = `You are a photography editing assistant. Inspect the supplied sanitized preview and return a conservative semantic edit intent.

Global adjustments: use no more than one adjustment per parameter and choose unchanged when no correction is justified.

${MASK_RULES}

Do not request crops, presets, ratings, metadata changes or delivery actions. Keep confidence honest: confidence below 0.65 is ignored by the deterministic translator.`;
export const PROMPT_HASH = createHash("sha256").update(PROMPT).digest("hex");

export const REFERENCE_RESEARCH_PROMPT = `When you are unsure which colour grade suits this scene, you may use web search (at most 3 searches) to look up how photographers commonly grade similar scenes, for example "blue hour street photography colour grading" or "warm film look backlit portrait". Use the text of the results only as general style guidance: do not copy a specific photographer's edit, and name the reference style you followed in creative_goal. Never search for, identify or describe the people in the photo.`;

export const CODEX_PROMPT_VERSION = "codex-local-v0.2.0";
export const CODEX_PROMPT = `Use the raw-photo-lightroom-preset skill to inspect one explicit RAW/preview pair and return a conservative SemanticIntentPlan JSON object.

Use the sanitized preview only for composition, focus, and expression triage. For colour and tonal decisions, prefer a Lightroom or Camera Raw render of the RAW when the local Lightroom workflow is available. Do not mutate Lightroom during analysis.

${MASK_RULES}

Never invent crops, ratings, presets, delivery actions, or metadata changes. Keep confidence honest; the deterministic translator ignores confidence below 0.65.`;
export const CODEX_PROMPT_HASH = createHash("sha256").update(CODEX_PROMPT).digest("hex");

export const EVALUATION_PROMPT_VERSION = "edit-evaluation-v0.3.0";
export const EVALUATION_PROMPT = `Inspect the sanitized edited-photo render and evaluate it conservatively. Return accept only when no material issue remains. Return review for subjective skin-tone, mixed-lighting, or low-confidence decisions. Return refine only with a small normalized global-delta plan in refinement_plan.operations; never add masks, crops, metadata, ratings, deletion, or export.

When masks are listed in the request, judge every one and return mask_feedback with one entry per mask id:
- ok: the local change looks natural and helps the photo.
- too_strong: a visible halo, hard edge, blotch, or an unnatural brightness or colour step, or the region now pulls the eye in the wrong way.
- misplaced: the effect lands on the wrong region or cuts through the subject.
- unnecessary: the mask adds nothing a viewer would notice.
accept requires every mask to be ok. Explain each verdict in rationale and issues.`;
