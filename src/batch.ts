import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, parse, relative, resolve, sep } from "node:path";

import {
  PropagationPlanSchema,
  ShootDecisionSchema,
  ShootManifestSchema,
  ShootPlanSchema,
  ShootReviewFileSchema,
} from "./schemas.js";
import { sha256File } from "./ingest.js";
import { createSanitizedPreview } from "./preview.js";
import { PARAMETER_REGISTRY_VERSION, selectPropagatableOperations } from "./parameter-registry.js";
import { readShootMetadata } from "./shoot-metadata.js";
import { buildNearDuplicateGroups, rankAssetIds } from "./shoot-grouping.js";
import type {
  CullingDecision,
  LightingClassification,
  NormalizedEditPlan,
  PropagationPlan,
  ShootAnalyzer,
  ShootAsset,
  ShootDecision,
  ShootIngestionError,
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
const MIN_AUTO_REJECT_CONFIDENCE = 0.65;

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

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function assetId(relativeRawPath: string): string {
  return createHash("sha256").update(relativeRawPath).digest("hex");
}

async function safeHash(
  path: string,
  source: ShootIngestionError["source"],
  errors: ShootIngestionError[],
): Promise<string | undefined> {
  try {
    return await sha256File(path);
  } catch (error) {
    errors.push({
      source,
      stage: "hash",
      message:
        "Failed to hash " + path + ": " + (error instanceof Error ? error.message : String(error)),
    });
    return undefined;
  }
}

function enforceCullingSafety(decision: CullingDecision, asset: ShootAsset): CullingDecision {
  if (
    decision.selection_status !== "reject" ||
    (decision.confidence >= MIN_AUTO_REJECT_CONFIDENCE && asset.high_value !== true)
  ) {
    return decision;
  }
  const reason = asset.high_value
    ? "Configured high-value asset cannot be automatically rejected"
    : "Reject confidence " + decision.confidence + " is below " + MIN_AUTO_REJECT_CONFIDENCE;
  return {
    ...decision,
    selection_status: "review",
    rationale: reason + "; manual review required. " + decision.rationale,
  };
}

export async function indexShoot(rootInput: string): Promise<ShootAsset[]> {
  const root = resolve(rootInput);
  const groups = new Map<string, { raws: string[]; previews: string[] }>();
  for (const path of await walkFiles(root)) {
    const extension = extname(path).toLowerCase();
    if (!RAW_EXTENSIONS.has(extension) && !PREVIEW_EXTENSIONS.has(extension)) continue;
    const pathRelativeToRoot = relativePath(root, path);
    const key = join(dirname(pathRelativeToRoot), parse(pathRelativeToRoot).name).toLowerCase();
    const group = groups.get(key) ?? { raws: [], previews: [] };
    if (RAW_EXTENSIONS.has(extension)) group.raws.push(path);
    else group.previews.push(path);
    groups.set(key, group);
  }

  const assets: ShootAsset[] = [];
  for (const group of groups.values()) {
    for (const rawPath of group.raws.sort((left, right) =>
      relativePath(root, left).localeCompare(relativePath(root, right)),
    )) {
      const relativeRawPath = relativePath(root, rawPath);
      const unambiguous = group.raws.length === 1 && group.previews.length === 1;
      const previewPath = unambiguous ? group.previews[0] : undefined;
      const ingestionErrors: ShootIngestionError[] = [];
      const rawSha = await safeHash(rawPath, "raw", ingestionErrors);
      const previewSha = previewPath
        ? await safeHash(previewPath, "preview", ingestionErrors)
        : undefined;
      const metadataResult = await readShootMetadata(rawPath, previewPath);
      ingestionErrors.push(...metadataResult.errors);
      assets.push({
        id: assetId(relativeRawPath),
        relative_raw_path: relativeRawPath,
        raw_path: rawPath,
        ...(previewPath
          ? {
              relative_preview_path: relativePath(root, previewPath),
              preview_path: previewPath,
              ...(previewSha !== undefined ? { preview_sha256: previewSha } : {}),
            }
          : {}),
        ...(rawSha !== undefined ? { raw_sha256: rawSha } : {}),
        ...metadataResult.metadata,
        source_confidence:
          group.previews.length === 0 ? "missing_preview" : unambiguous ? "high" : "ambiguous",
        high_value: false,
        ingestion_errors: ingestionErrors,
      });
    }
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

  private readonly reviewDecisions: ShootReviewFile["decisions"];
  private readonly byId = new Map<string, ShootReviewFile["decisions"][number]>();
  private readonly byPath = new Map<string, ShootReviewFile["decisions"][number]>();

  constructor(review: ShootReviewFile) {
    this.reviewDecisions = review.decisions;
    for (const decision of review.decisions) {
      if (decision.asset_id) this.byId.set(decision.asset_id, decision);
      if (decision.relative_raw_path) {
        this.byPath.set(normalizeRelativePath(decision.relative_raw_path), decision);
      }
    }
  }

  validateAssets(assets: ShootAsset[]): void {
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const assetsByPath = new Map(
      assets.map((asset) => [normalizeRelativePath(asset.relative_raw_path), asset]),
    );
    const seen = new Set<string>();
    for (const decision of this.reviewDecisions) {
      const byId = decision.asset_id ? assetsById.get(decision.asset_id) : undefined;
      const byPath = decision.relative_raw_path
        ? assetsByPath.get(normalizeRelativePath(decision.relative_raw_path))
        : undefined;
      if (decision.asset_id && !byId) {
        throw new Error("Review file references unknown asset id: " + decision.asset_id);
      }
      if (decision.relative_raw_path && !byPath) {
        throw new Error(
          "Review file references unknown relative path: " + decision.relative_raw_path,
        );
      }
      if (byId && byPath && byId.id !== byPath.id) {
        throw new Error("Review file asset id and relative path identify different assets");
      }
      const resolved = byId ?? byPath;
      if (!resolved) throw new Error("Review file decision does not identify an indexed asset");
      if (seen.has(resolved.id)) {
        throw new Error("Review file contains duplicate decision for asset: " + resolved.id);
      }
      seen.add(resolved.id);
    }
  }

  private decision(asset: ShootAsset): ShootReviewFile["decisions"][number] | undefined {
    return (
      this.byId.get(asset.id) ?? this.byPath.get(normalizeRelativePath(asset.relative_raw_path))
    );
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
      if (!asset.raw_sha256) return groups;
      (groups[asset.raw_sha256] ??= []).push(asset.id);
      return groups;
    }, {}),
  )
    .filter(([, ids]) => ids.length > 1)
    .map(([sha256, asset_ids]) => ({ sha256, asset_ids }));
}

function burstGroups(
  assets: ShootAsset[],
  decisions: ShootDecision[],
): ShootManifest["burst_groups"] {
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
          ranked_asset_ids: rankAssetIds(
            run.map((item) => item.id),
            decisions,
            assets,
          ),
          ranking_rationale:
            "Ranked by explicit culling status, confidence, and stable relative path; grouping is review-only.",
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

function clustersFor(
  decisions: ShootDecision[],
  assets: ShootAsset[],
): {
  clusters: ShootManifest["clusters"];
  unclustered_asset_ids: string[];
} {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const clusterGroups = new Map<string, string[]>();
  const unclustered = new Set<string>();
  for (const decision of decisions) {
    const key = decision.lighting.lighting_type;
    if (
      decision.state === "failed" ||
      decision.lighting.confidence < MIN_AUTO_REJECT_CONFIDENCE ||
      key === "mixed" ||
      key === "unknown"
    ) {
      unclustered.add(decision.asset_id);
      continue;
    }
    const members = clusterGroups.get(key) ?? [];
    members.push(decision.asset_id);
    clusterGroups.set(key, members);
  }
  const clusters = [...clusterGroups.entries()].map(([lighting_type, member_ids], index) => {
    const members = decisions.filter((decision) => member_ids.includes(decision.asset_id));
    const outlierIds = members
      .filter((decision) => {
        const asset = assetsById.get(decision.asset_id);
        return (
          decision.state === "failed" ||
          decision.culling.selection_status === "review" ||
          decision.culling.selection_status === "reject" ||
          decision.culling.confidence < MIN_AUTO_REJECT_CONFIDENCE ||
          !asset ||
          asset.source_confidence !== "high" ||
          asset.ingestion_errors.length > 0
        );
      })
      .map((decision) => decision.asset_id);
    const outlierSet = new Set(outlierIds);
    const representative =
      members
        .filter(
          (decision) =>
            !outlierSet.has(decision.asset_id) &&
            (decision.culling.selection_status === "select" ||
              decision.culling.selection_status === "keep"),
        )
        .sort((left, right) => right.culling.confidence - left.culling.confidence)[0]?.asset_id ??
      null;
    return {
      cluster_id: "cluster-" + String(index + 1).padStart(3, "0"),
      lighting_type,
      member_ids,
      representative_id: representative,
      confidence:
        members.reduce((sum, decision) => sum + decision.lighting.confidence, 0) /
        Math.max(members.length, 1),
      strategy:
        "lighting:" + lighting_type + "; edit and accept one representative before propagation",
      outlier_ids: outlierIds,
    };
  });
  return {
    clusters,
    unclustered_asset_ids: [...unclustered].sort(),
  };
}

async function writeShootReports(
  sessionDir: string,
  plan: ShootPlan,
  decisions: ShootDecision[],
  started: number,
  resumedJobs: number,
  analyzedJobs: number,
): Promise<ShootManifest> {
  const clustered = clustersFor(decisions, plan.assets);
  const clusters = clustered.clusters;
  const nearDuplicateGroups = await buildNearDuplicateGroups(plan.assets, decisions);
  const manifest = ShootManifestSchema.parse({
    ...plan,
    decisions,
    duplicate_groups: duplicateGroups(plan.assets),
    burst_groups: burstGroups(plan.assets, decisions),
    near_duplicate_groups: nearDuplicateGroups,
    clusters,
    unclustered_asset_ids: clustered.unclustered_asset_ids,
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
  const header =
    "asset_id,raw,preview,status,confidence,lighting,technical_evidence,aesthetic_evidence,rationale";
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
      decision.culling.evidence?.technical.join(" | ") ?? "",
      decision.culling.evidence?.aesthetic.join(" | ") ?? "",
      decision.culling.rationale,
    ]
      .map(csvCell)
      .join(",");
  });
  await writeFile(join(sessionDir, "culling.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
  return manifest;
}

function applyHighValueConfiguration(assets: ShootAsset[], configuredIds: string[]): ShootAsset[] {
  const highValueIds = new Set(configuredIds);
  const knownIds = new Set(assets.map((asset) => asset.id));
  const unknownIds = [...highValueIds].filter((assetId) => !knownIds.has(assetId));
  if (unknownIds.length > 0) {
    throw new Error("Unknown high-value asset ids: " + unknownIds.join(", "));
  }
  return assets.map((asset) => ({ ...asset, high_value: highValueIds.has(asset.id) }));
}

export async function createShootSession(options: {
  shootRoot: string;
  sessionRoot: string;
  highValueAssetIds?: string[];
}): Promise<{ sessionDir: string; plan: ShootPlan }> {
  const assets = applyHighValueConfiguration(
    await indexShoot(options.shootRoot),
    options.highValueAssetIds ?? [],
  );
  const sessionId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const sessionDir = join(resolve(options.sessionRoot), sessionId);
  await mkdir(join(sessionDir, "jobs"), { recursive: true });
  const plan = ShootPlanSchema.parse({
    schema_version: "0.3.0",
    session_id: sessionId,
    shoot_root: resolve(options.shootRoot),
    created_at: new Date().toISOString(),
    mode: "dry_run",
    assets,
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
  options.analyzer.validateAssets?.(plan.assets);
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
      const previewHasErrors = asset.ingestion_errors.some((item) => item.source === "preview");
      const analyzer = asset.preview_path && !previewHasErrors ? options.analyzer : conservative;
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
        culling: enforceCullingSafety(culling, asset),
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
  highValueAssetIds?: string[];
}): Promise<{ sessionDir: string; manifest: ShootManifest }> {
  if (options.analyzer.requiresCloudPreview && !options.allowCloudPreview) {
    throw new Error("This shoot analyzer requires --allow-cloud-preview; no session was created");
  }
  const created = await createShootSession({
    shootRoot: options.shootRoot,
    sessionRoot: options.sessionRoot,
    ...(options.highValueAssetIds ? { highValueAssetIds: options.highValueAssetIds } : {}),
  });
  return resumeShootDryRun({
    sessionDir: created.sessionDir,
    analyzer: options.analyzer,
    ...(options.allowCloudPreview !== undefined
      ? { allowCloudPreview: options.allowCloudPreview }
      : {}),
  });
}

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
  const operations = selectPropagatableOperations(
    options.representativePlan,
    options.allowedParameters,
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
    if (cluster.outlier_ids.includes(assetId)) {
      excluded.push({ asset_id: assetId, reason: "cluster_outlier" });
      continue;
    }
    const asset = assetsById.get(assetId);
    if (!asset) {
      excluded.push({ asset_id: assetId, reason: "unknown_asset" });
      continue;
    }
    const decision = decisionsById.get(assetId);
    if (asset.source_confidence !== "high") {
      excluded.push({ asset_id: assetId, reason: `source_${asset.source_confidence}` });
    } else if (asset.ingestion_errors.length > 0) {
      excluded.push({ asset_id: assetId, reason: "ingestion_errors" });
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
    parameter_registry_version: PARAMETER_REGISTRY_VERSION,
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
