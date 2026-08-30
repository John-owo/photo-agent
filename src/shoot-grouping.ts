import { createHash } from "node:crypto";

import sharp from "sharp";

import type { ShootAsset, ShootDecision } from "./types.js";

type Fingerprint = {
  asset: ShootAsset;
  aspect: number;
  bits: Uint8Array;
};

const MAX_HAMMING_DISTANCE = 16;
const MAX_ASPECT_RATIO_DELTA = 0.02;

function decisionRank(decision: ShootDecision | undefined): number {
  switch (decision?.culling.selection_status) {
    case "select":
      return 4;
    case "keep":
      return 3;
    case "review":
      return 2;
    case "reject":
      return 1;
    default:
      return 0;
  }
}

export function rankAssetIds(
  assetIds: string[],
  decisions: ShootDecision[],
  assets: ShootAsset[],
): string[] {
  const decisionsById = new Map(decisions.map((decision) => [decision.asset_id, decision]));
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return [...assetIds].sort((left, right) => {
    const leftDecision = decisionsById.get(left);
    const rightDecision = decisionsById.get(right);
    const rankDifference = decisionRank(rightDecision) - decisionRank(leftDecision);
    if (rankDifference !== 0) return rankDifference;
    const confidenceDifference =
      (rightDecision?.culling.confidence ?? 0) - (leftDecision?.culling.confidence ?? 0);
    if (confidenceDifference !== 0) return confidenceDifference;
    return (
      assetsById
        .get(left)
        ?.relative_raw_path.localeCompare(assetsById.get(right)?.relative_raw_path ?? "") ??
      left.localeCompare(right)
    );
  });
}

async function fingerprint(asset: ShootAsset): Promise<Fingerprint> {
  if (!asset.preview_path) throw new Error("Near-duplicate fingerprint requires a preview");
  const { data, info } = await sharp(asset.preview_path)
    .resize(16, 16, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (data.length === 0 || info.width < 1 || info.height < 1) {
    throw new Error("Near-duplicate fingerprint has no pixels");
  }
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  const bits = Uint8Array.from(data, (value) => (value >= mean ? 1 : 0));
  return { asset, aspect: info.width / info.height, bits };
}

function distance(left: Fingerprint, right: Fingerprint): number {
  if (left.bits.length !== right.bits.length) return Number.POSITIVE_INFINITY;
  let result = 0;
  for (let index = 0; index < left.bits.length; index += 1) {
    if (left.bits[index] !== right.bits[index]) result += 1;
  }
  return result;
}

function compatible(left: Fingerprint, right: Fingerprint): boolean {
  return (
    Math.abs(left.aspect - right.aspect) <= MAX_ASPECT_RATIO_DELTA &&
    distance(left, right) <= MAX_HAMMING_DISTANCE
  );
}

export async function buildNearDuplicateGroups(
  assets: ShootAsset[],
  decisions: ShootDecision[],
): Promise<
  Array<{
    group_id: string;
    asset_ids: string[];
    basis: "preview_similarity";
    ranked_asset_ids: string[];
    ranking_rationale: string;
  }>
> {
  const fingerprints: Fingerprint[] = [];
  for (const asset of assets) {
    if (!asset.preview_path || asset.ingestion_errors.some((item) => item.source === "preview")) {
      continue;
    }
    try {
      fingerprints.push(await fingerprint(asset));
    } catch {
      // A single unreadable preview must not invalidate the rest of the report.
    }
  }

  const groups: Array<{
    group_id: string;
    asset_ids: string[];
    basis: "preview_similarity";
    ranked_asset_ids: string[];
    ranking_rationale: string;
  }> = [];
  for (let index = 0; index < fingerprints.length; index += 1) {
    const seed = fingerprints[index]!;
    const members = [seed];
    for (
      let candidateIndex = index + 1;
      candidateIndex < fingerprints.length;
      candidateIndex += 1
    ) {
      const candidate = fingerprints[candidateIndex]!;
      if (members.every((member) => compatible(member, candidate))) members.push(candidate);
    }
    if (members.length < 2) continue;
    const assetIds = members.map((member) => member.asset.id);
    const orderedIds = [...assetIds].sort();
    groups.push({
      group_id: createHash("sha256")
        .update("preview_similarity:" + orderedIds.join("|"))
        .digest("hex")
        .slice(0, 16),
      asset_ids: assetIds,
      basis: "preview_similarity",
      ranked_asset_ids: rankAssetIds(assetIds, decisions, assets),
      ranking_rationale:
        "Ranked by explicit culling status, confidence, and stable relative path; grouping is review-only.",
    });
    index += members.length - 1;
  }
  return groups;
}
