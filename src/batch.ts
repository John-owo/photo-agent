import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";

import sharp from "sharp";

import {
  PropagationPlanSchema,
  ShootDecisionSchema,
  ShootManifestSchema,
  ShootPlanSchema,
  ShootReviewFileSchema,
} from "./schemas.js";
import { sha256File } from "./ingest.js";
import { createSanitizedPreview } from "./preview.js";
import type {
  CullingDecision,
  LightingClassification,
  NormalizedEditPlan,
  PropagationPlan,
  ShootAnalyzer,
  ShootAsset,
  ShootDecision,
  ShootManifest,
  ShootPlan,
  ShootReviewFile,
} from "./types.js";

const RAW_EXTENSIONS = new Set([
  ".nef",
  ".nrw",
  ".cr2",
  ".cr3",
  ".arw",
  ".dng",
  ".rw2",
  ".raf",
  ".orf",
  ".pef",
  ".srw",
]);
const PREVIEW_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function walkFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function assetId(relativeRawPath: string): string {
  return createHash("sha256").update(relativeRawPath.toLowerCase()).digest("hex").slice(0, 16);
}

type IndexedFile = { path: string; dir: string; stem: string };

function isWithin(dir: string, ancestor: string): boolean {
  return ancestor === "" || dir === ancestor || dir.startsWith(`${ancestor}${sep}`);
}

/** Folders from the RAW's parent up to the shoot root ("" is the root). */
function ancestorsOf(dir: string): string[] {
  const result: string[] = [];
  let current = dir === "." ? "" : dir;
  while (current !== "") {
    const parent = dirname(current);
    current = parent === "." ? "" : parent;
    result.push(current);
  }
  return result;
}

/** Software that writes itself into a JPEG it exported (not camera firmware). */
// Case-sensitive full product names: camera maker notes are binary and can
// contain short letter runs such as "dxo" (seen live on Z5II JPEGs).
const EDITOR_SIGNATURES =
  /Adobe Photoshop|Lightroom|Camera Raw|Capture One|darktable|RawTherapee|Luminar|DxO PhotoLab|DxO PureRAW|Affinity Photo|GIMP \d|Snapseed|NX Studio/;

/**
 * True when the JPEG was exported by an editor, e.g. a "修好的" folder of
 * Lightroom exports with the camera's file names. Such a file is a finished
 * edit, not the camera's look, so it is never used as the "before" preview.
 */
async function isEditedExport(path: string, cache: Map<string, boolean>): Promise<boolean> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let edited = false;
  try {
    const metadata = await sharp(path).metadata();
    const text = Buffer.concat([
      metadata.exif ?? Buffer.alloc(0),
      metadata.xmp ?? Buffer.alloc(0),
    ]).toString("latin1");
    edited = EDITOR_SIGNATURES.test(text);
  } catch {
    edited = false;
  }
  cache.set(path, edited);
  return edited;
}

type PreviewChoice = {
  previewPath?: string;
  confidence: ShootAsset["source_confidence"];
  match?: "same_folder" | "nearby_folder";
};

/**
 * Pair every RAW with its camera JPEG. Same folder first (DSC_1.NEF beside
 * DSC_1.JPG). Otherwise search outward from the RAW's folder, nearest level
 * first, for an unclaimed preview with the same file name, whatever the
 * folders are called (raw\ + jpg\, RAW\ + JPEG\, per-day subfolders...). More
 * than one candidate at the nearest level, or one JPEG claimed by two RAWs, is
 * ambiguous and never guessed.
 */
export async function indexShoot(rootInput: string): Promise<ShootAsset[]> {
  const root = resolve(rootInput);
  const raws: IndexedFile[] = [];
  const previews: IndexedFile[] = [];
  for (const path of await walkFiles(root)) {
    const extension = extname(path).toLowerCase();
    if (!RAW_EXTENSIONS.has(extension) && !PREVIEW_EXTENSIONS.has(extension)) continue;
    const relativePath = relative(root, path);
    const dir = dirname(relativePath).toLowerCase();
    const file = {
      path,
      dir: dir === "." ? "" : dir,
      stem: parse(relativePath).name.toLowerCase(),
    };
    (RAW_EXTENSIONS.has(extension) ? raws : previews).push(file);
  }
  const key = (file: IndexedFile) => `${file.dir}${sep}${file.stem}`;
  const rawsByKey = new Map<string, IndexedFile[]>();
  for (const raw of raws) rawsByKey.set(key(raw), [...(rawsByKey.get(key(raw)) ?? []), raw]);
  const previewsByKey = new Map<string, IndexedFile[]>();
  for (const preview of previews) {
    previewsByKey.set(key(preview), [...(previewsByKey.get(key(preview)) ?? []), preview]);
  }
  // A preview beside a RAW of the same name belongs to that folder's RAW.
  const unclaimedByStem = new Map<string, IndexedFile[]>();
  for (const preview of previews) {
    if (rawsByKey.has(key(preview))) continue;
    unclaimedByStem.set(preview.stem, [...(unclaimedByStem.get(preview.stem) ?? []), preview]);
  }

  const editedCache = new Map<string, boolean>();
  const choices = new Map<IndexedFile, PreviewChoice>();
  for (const raw of raws) {
    const sameFolderRaws = rawsByKey.get(key(raw)) ?? [];
    const sameFolder = previewsByKey.get(key(raw)) ?? [];
    if (sameFolder.length > 0) {
      const unambiguous = sameFolderRaws.length === 1 && sameFolder.length === 1;
      choices.set(raw, {
        ...(unambiguous ? { previewPath: sameFolder[0]!.path } : {}),
        confidence: unambiguous ? "high" : "ambiguous",
        match: "same_folder",
      });
      continue;
    }
    const candidates: IndexedFile[] = [];
    for (const preview of unclaimedByStem.get(raw.stem) ?? []) {
      if (!(await isEditedExport(preview.path, editedCache))) candidates.push(preview);
    }
    let choice: PreviewChoice = { confidence: "missing_preview" };
    for (const ancestor of ancestorsOf(raw.dir)) {
      const inScope = candidates.filter((preview) => isWithin(preview.dir, ancestor));
      if (inScope.length === 0) continue;
      choice =
        inScope.length === 1 && sameFolderRaws.length === 1
          ? { previewPath: inScope[0]!.path, confidence: "high", match: "nearby_folder" }
          : { confidence: "ambiguous", match: "nearby_folder" };
      break;
    }
    choices.set(raw, choice);
  }
  // One JPEG must never stand for two RAWs.
  const claims = new Map<string, IndexedFile[]>();
  for (const [raw, choice] of choices) {
    if (choice.previewPath) {
      claims.set(choice.previewPath, [...(claims.get(choice.previewPath) ?? []), raw]);
    }
  }
  for (const claimants of claims.values()) {
    if (claimants.length < 2) continue;
    for (const raw of claimants)
      choices.set(raw, { confidence: "ambiguous", match: "nearby_folder" });
  }

  const assets: ShootAsset[] = [];
  for (const raw of raws) {
    const choice = choices.get(raw)!;
    const relativeRawPath = relative(root, raw.path);
    assets.push({
      id: assetId(relativeRawPath),
      relative_raw_path: relativeRawPath,
      raw_path: raw.path,
      ...(choice.previewPath
        ? {
            relative_preview_path: relative(root, choice.previewPath),
            preview_path: choice.previewPath,
            preview_sha256: await sha256File(choice.previewPath),
          }
        : {}),
      raw_sha256: await sha256File(raw.path),
      source_confidence: choice.confidence,
      ...(choice.match && choice.confidence !== "missing_preview"
        ? { preview_match: choice.match }
        : {}),
    });
  }
  return assets.sort((a, b) => a.relative_raw_path.localeCompare(b.relative_raw_path));
}

export class ConservativeShootAnalyzer implements ShootAnalyzer {
  readonly requiresCloudPreview = false;

  async cull(asset: ShootAsset): Promise<CullingDecision> {
    return {
      selection_status: "review",
      confidence: 0,
      rationale:
        asset.source_confidence === "high"
          ? "No visual analyzer configured; human review required"
          : `Source pairing is ${asset.source_confidence}; automatic culling refused`,
    };
  }

  async classify(asset: ShootAsset): Promise<LightingClassification> {
    return {
      lighting_type: "unknown",
      confidence: 0,
      rationale: `No scene classifier configured for ${asset.relative_raw_path}`,
    };
  }
}

export class ReviewedShootAnalyzer implements ShootAnalyzer {
  readonly requiresCloudPreview = false;

  private readonly byId = new Map<string, ShootReviewFile["decisions"][number]>();
  private readonly byPath = new Map<string, ShootReviewFile["decisions"][number]>();

  constructor(review: ShootReviewFile) {
    for (const decision of review.decisions) {
      if (decision.asset_id) this.byId.set(decision.asset_id, decision);
      if (decision.relative_raw_path) {
        this.byPath.set(decision.relative_raw_path.toLowerCase(), decision);
      }
    }
  }

  private decision(asset: ShootAsset): ShootReviewFile["decisions"][number] | undefined {
    return this.byId.get(asset.id) ?? this.byPath.get(asset.relative_raw_path.toLowerCase());
  }

  async cull(asset: ShootAsset): Promise<CullingDecision> {
    return (
      this.decision(asset)?.culling ?? {
        selection_status: "review",
        confidence: 0,
        rationale: "No reviewed decision supplied for this asset",
      }
    );
  }

  async classify(asset: ShootAsset): Promise<LightingClassification> {
    return (
      this.decision(asset)?.lighting ?? {
        lighting_type: "unknown",
        confidence: 0,
        rationale: "No reviewed lighting decision supplied for this asset",
      }
    );
  }
}

export async function loadReviewedShootAnalyzer(path: string): Promise<ReviewedShootAnalyzer> {
  const review = ShootReviewFileSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
  return new ReviewedShootAnalyzer(review);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function readDecision(path: string): Promise<ShootDecision | undefined> {
  try {
    return ShootDecisionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
}

function duplicateGroups(assets: ShootAsset[]): ShootManifest["duplicate_groups"] {
  return Object.entries(
    assets.reduce<Record<string, string[]>>((groups, asset) => {
      (groups[asset.raw_sha256] ??= []).push(asset.id);
      return groups;
    }, {}),
  )
    .filter(([, ids]) => ids.length > 1)
    .map(([sha256, asset_ids]) => ({ sha256, asset_ids }));
}

function burstGroups(assets: ShootAsset[]): ShootManifest["burst_groups"] {
  const candidates = new Map<string, Array<{ sequence: number; id: string }>>();
  for (const asset of assets) {
    const relativePath = asset.relative_raw_path;
    const match = /^(.*?)(\d{2,})$/.exec(parse(relativePath).name);
    if (!match) continue;
    const key = join(dirname(relativePath), match[1]!).toLowerCase();
    const items = candidates.get(key) ?? [];
    items.push({ sequence: Number(match[2]), id: asset.id });
    candidates.set(key, items);
  }
  const groups: ShootManifest["burst_groups"] = [];
  for (const [key, items] of candidates) {
    const sorted = items.sort((a, b) => a.sequence - b.sequence);
    let run: typeof sorted = [];
    const flush = () => {
      if (run.length > 1) {
        groups.push({
          group_id: createHash("sha256")
            .update(`${key}:${run[0]!.sequence}`)
            .digest("hex")
            .slice(0, 16),
          asset_ids: run.map((item) => item.id),
          basis: "filename_sequence",
        });
      }
      run = [];
    };
    for (const item of sorted) {
      if (run.length > 0 && item.sequence - run[run.length - 1]!.sequence > 3) flush();
      run.push(item);
    }
    flush();
  }
  return groups;
}

function clustersFor(decisions: ShootDecision[]): ShootManifest["clusters"] {
  const clusterGroups = new Map<string, string[]>();
  for (const decision of decisions) {
    const key = decision.lighting.lighting_type;
    const members = clusterGroups.get(key) ?? [];
    members.push(decision.asset_id);
    clusterGroups.set(key, members);
  }
  return [...clusterGroups.entries()].map(([lighting_type, member_ids], index) => ({
    cluster_id: `cluster-${String(index + 1).padStart(3, "0")}`,
    lighting_type,
    member_ids,
    representative_id:
      decisions
        .filter(
          (item) =>
            member_ids.includes(item.asset_id) &&
            (item.culling.selection_status === "select" ||
              item.culling.selection_status === "keep"),
        )
        .sort((a, b) => b.culling.confidence - a.culling.confidence)[0]?.asset_id ?? null,
  }));
}

async function writeShootReports(
  sessionDir: string,
  plan: ShootPlan,
  decisions: ShootDecision[],
  started: number,
  resumedJobs: number,
  analyzedJobs: number,
): Promise<ShootManifest> {
  const clusters = clustersFor(decisions);
  const manifest = ShootManifestSchema.parse({
    ...plan,
    decisions,
    duplicate_groups: duplicateGroups(plan.assets),
    burst_groups: burstGroups(plan.assets),
    clusters,
    summary: {
      input: plan.assets.length,
      select: decisions.filter((item) => item.culling.selection_status === "select").length,
      keep: decisions.filter((item) => item.culling.selection_status === "keep").length,
      reject: decisions.filter((item) => item.culling.selection_status === "reject").length,
      review: decisions.filter((item) => item.culling.selection_status === "review").length,
      failed: decisions.filter((item) => item.state === "failed").length,
      resumed_jobs: resumedJobs,
      analyzed_jobs: analyzedJobs,
      elapsed_ms: Date.now() - started,
    },
  });
  await writeJsonAtomic(join(sessionDir, "manifest.json"), manifest);
  await writeJsonAtomic(join(sessionDir, "clusters.json"), clusters);
  const header = "asset_id,raw,preview,status,confidence,lighting,rationale";
  const assetsById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const rows = decisions.map((decision) => {
    const asset = assetsById.get(decision.asset_id)!;
    return [
      decision.asset_id,
      asset.relative_raw_path,
      asset.relative_preview_path ?? "",
      decision.culling.selection_status,
      String(decision.culling.confidence),
      decision.lighting.lighting_type,
      decision.culling.rationale,
    ]
      .map(csvCell)
      .join(",");
  });
  await writeFile(join(sessionDir, "culling.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
  return manifest;
}

export async function createShootSession(options: {
  shootRoot: string;
  sessionRoot: string;
}): Promise<{ sessionDir: string; plan: ShootPlan }> {
  const sessionId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const sessionDir = join(resolve(options.sessionRoot), sessionId);
  await mkdir(join(sessionDir, "jobs"), { recursive: true });
  const plan = ShootPlanSchema.parse({
    schema_version: "0.3.0",
    session_id: sessionId,
    shoot_root: resolve(options.shootRoot),
    created_at: new Date().toISOString(),
    mode: "dry_run",
    assets: await indexShoot(options.shootRoot),
  });
  await writeJsonAtomic(join(sessionDir, "shoot-plan.json"), plan);
  return { sessionDir, plan };
}

export async function resumeShootDryRun(options: {
  sessionDir: string;
  analyzer: ShootAnalyzer;
  allowCloudPreview?: boolean;
}): Promise<{ sessionDir: string; manifest: ShootManifest }> {
  const started = Date.now();
  const sessionDir = resolve(options.sessionDir);
  const plan = ShootPlanSchema.parse(
    JSON.parse(await readFile(join(sessionDir, "shoot-plan.json"), "utf8")),
  );
  if (options.analyzer.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This shoot analyzer requires --allow-cloud-preview; no image was sent");
  }
  const decisions: ShootDecision[] = [];
  let resumedJobs = 0;
  let analyzedJobs = 0;
  const conservative = new ConservativeShootAnalyzer();
  for (const asset of plan.assets) {
    const jobPath = join(sessionDir, "jobs", `${asset.id}.json`);
    const existing = await readDecision(jobPath);
    if (existing) {
      decisions.push(existing);
      resumedJobs += 1;
      continue;
    }
    let decision: ShootDecision;
    try {
      const analyzer = asset.preview_path ? options.analyzer : conservative;
      let analysisAsset = asset;
      if (asset.preview_path && analyzer.requiresCloudPreview) {
        const sanitizedPath = join(sessionDir, "inputs", `${asset.id}.jpg`);
        await createSanitizedPreview(asset.preview_path, sanitizedPath);
        analysisAsset = { ...asset, preview_path: sanitizedPath };
      }
      const [culling, lighting] = await Promise.all([
        analyzer.cull(analysisAsset),
        analyzer.classify(analysisAsset),
      ]);
      decision = ShootDecisionSchema.parse({
        asset_id: asset.id,
        culling,
        lighting,
        state: "completed",
      });
    } catch (error) {
      decision = ShootDecisionSchema.parse({
        asset_id: asset.id,
        culling: {
          selection_status: "review",
          confidence: 0,
          rationale: "Analyzer failed; isolated for manual review",
        },
        lighting: { lighting_type: "unknown", confidence: 0, rationale: "Analyzer failed" },
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    decisions.push(decision);
    analyzedJobs += 1;
    await writeJsonAtomic(jobPath, decision);
  }
  const manifest = await writeShootReports(
    sessionDir,
    plan,
    decisions,
    started,
    resumedJobs,
    analyzedJobs,
  );
  return { sessionDir, manifest };
}

export async function runShootDryRun(options: {
  shootRoot: string;
  sessionRoot: string;
  analyzer: ShootAnalyzer;
  allowCloudPreview?: boolean;
}): Promise<{ sessionDir: string; manifest: ShootManifest }> {
  if (options.analyzer.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This shoot analyzer requires --allow-cloud-preview; no session was created");
  }
  const created = await createShootSession(options);
  return resumeShootDryRun({
    sessionDir: created.sessionDir,
    analyzer: options.analyzer,
    ...(options.allowCloudPreview !== undefined
      ? { allowCloudPreview: options.allowCloudPreview }
      : {}),
  });
}

const SAFE_PROPAGATION_PARAMETERS = new Set([
  "exposure_ev",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
]);

export function createSafePropagationPlan(options: {
  manifest: ShootManifest;
  clusterId: string;
  representativePlan: NormalizedEditPlan;
  allowedParameters: string[];
}): PropagationPlan {
  const cluster = options.manifest.clusters.find((item) => item.cluster_id === options.clusterId);
  if (!cluster) throw new Error(`Unknown cluster: ${options.clusterId}`);
  if (!cluster.representative_id)
    throw new Error(`Cluster ${options.clusterId} has no representative`);
  const explicitlyAllowed = new Set(options.allowedParameters);
  const operations = options.representativePlan.operations.filter(
    (operation) =>
      explicitlyAllowed.has(operation.parameter) &&
      SAFE_PROPAGATION_PARAMETERS.has(operation.parameter),
  );
  if (operations.length === 0) {
    throw new Error("No explicitly allowed safe global operations remain for propagation");
  }
  const assetsById = new Map(options.manifest.assets.map((asset) => [asset.id, asset]));
  const decisionsById = new Map(
    options.manifest.decisions.map((decision) => [decision.asset_id, decision]),
  );
  const targets: PropagationPlan["targets"] = [];
  const excluded: PropagationPlan["excluded"] = [];
  for (const assetId of cluster.member_ids) {
    if (assetId === cluster.representative_id) continue;
    const asset = assetsById.get(assetId)!;
    const decision = decisionsById.get(assetId);
    if (asset.source_confidence !== "high") {
      excluded.push({ asset_id: assetId, reason: `source_${asset.source_confidence}` });
    } else if (
      !decision ||
      (decision.culling.selection_status !== "select" &&
        decision.culling.selection_status !== "keep")
    ) {
      excluded.push({ asset_id: assetId, reason: "not_in_structured_shortlist" });
    } else {
      targets.push({ asset_id: assetId, relative_raw_path: asset.relative_raw_path, operations });
    }
  }
  return PropagationPlanSchema.parse({
    schema_version: "0.3.0",
    cluster_id: options.clusterId,
    representative_id: cluster.representative_id,
    operation_parameters: operations.map((operation) => operation.parameter),
    targets,
    excluded,
    requires_explicit_apply: true,
  });
}

export async function loadShootManifest(sessionDir: string): Promise<ShootManifest> {
  return ShootManifestSchema.parse(
    JSON.parse(await readFile(join(resolve(sessionDir), "manifest.json"), "utf8")),
  );
}
