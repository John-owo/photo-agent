/**
 * Nikon recipe (Picture Control / Nikon Imaging Cloud recipe) support.
 *
 * Lightroom ignores the recipe stored in a NEF. The `nikon-recipe-acr-profile`
 * skill builds an Adobe "Look" profile (.xmp with a fitted LUT) per recipe and
 * installs it under Camera Raw's Settings folder. lightroom-mcp cannot set a
 * profile directly, but it can apply a develop preset, so photo-agent wraps each
 * recipe profile in a preset that sets only that profile (`crs:Look`).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RECIPE_PRESET_GROUP = "photo-agent";
export const RECIPE_PRESET_FOLDER = "photo-agent";

export type RecipeProfile = {
  /** Profile name shown in Lightroom, e.g. "Z5II VitalityFilm Pmango". */
  name: string;
  uuid: string;
  group: string;
  /** ACR camera name the profile is restricted to ("" = any camera). */
  cameraRestriction: string;
  file: string;
};

export type PhotoRecipe = {
  /** Camera model from EXIF, e.g. "NIKON Z5_2". */
  model: string;
  /** Picture Control / recipe name, e.g. "VitalityFilm_Pmango". */
  recipe: string;
  /** Base Picture Control, e.g. "Flexible Color". */
  base?: string;
};

export type RecipeMatch =
  | { status: "matched"; recipe: PhotoRecipe; profile: RecipeProfile }
  | { status: "no_profile"; recipe: PhotoRecipe }
  | { status: "builtin"; recipe: PhotoRecipe }
  | { status: "unknown"; reason: string };

/** Nikon's own Picture Controls that Adobe already ships as Camera profiles. */
const BUILTIN_PICTURE_CONTROLS = new Set(
  [
    "Auto",
    "Standard",
    "Neutral",
    "Vivid",
    "Monochrome",
    "Portrait",
    "Landscape",
    "Flat",
    "Flexible Color",
    "Rich Tone Portrait",
    "Deep Tone Monochrome",
    "Flat Monochrome",
  ].map(normalizeKey),
);

export function defaultCameraRawSettingsDir(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "Adobe", "CameraRaw", "Settings");
}

export function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cameraKey(value: string): string {
  return normalizeKey(value).replace(/^nikon/, "");
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\scrs:${name}="([^"]*)"`).exec(tag);
  return match?.[1];
}

function altText(xml: string, element: string): string | undefined {
  const match = new RegExp(`<crs:${element}>\\s*<rdf:Alt>\\s*<rdf:li[^>]*>([^<]*)</rdf:li>`).exec(
    xml,
  );
  return match?.[1]?.trim();
}

/** The opening tag of the top-level crs Description, attributes included. */
function descriptionTag(xml: string): string | undefined {
  const start = xml.indexOf("<rdf:Description");
  if (start < 0) return undefined;
  const end = xml.indexOf(">", start);
  return end < 0 ? undefined : xml.slice(start, end + 1);
}

export function parseLookProfile(xml: string, file: string): RecipeProfile | undefined {
  const tag = descriptionTag(xml);
  if (!tag || attribute(tag, "PresetType") !== "Look") return undefined;
  const uuid = attribute(tag, "UUID");
  const name = altText(xml, "Name");
  if (!uuid || !name) return undefined;
  return {
    name,
    uuid,
    group: altText(xml, "Group") ?? "",
    cameraRestriction: attribute(tag, "CameraModelRestriction") ?? "",
    file,
  };
}

async function listXmp(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listXmp(path, depth + 1)));
    else if (/\.xmp$/i.test(entry.name)) files.push(path);
  }
  return files;
}

/** Installed Look profiles that can stand for a camera recipe. */
export async function scanRecipeProfiles(
  settingsDir = defaultCameraRawSettingsDir(),
): Promise<RecipeProfile[]> {
  const profiles: RecipeProfile[] = [];
  for (const file of await listXmp(settingsDir)) {
    let xml: string;
    try {
      xml = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const profile = parseLookProfile(xml, file);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

export function matchRecipeProfile(
  recipe: PhotoRecipe,
  profiles: readonly RecipeProfile[],
): RecipeMatch {
  const recipeKey = normalizeKey(recipe.recipe);
  if (!recipeKey) return { status: "unknown", reason: "empty_picture_control_name" };
  if (BUILTIN_PICTURE_CONTROLS.has(recipeKey)) return { status: "builtin", recipe };
  const camera = cameraKey(recipe.model);
  const candidates = profiles.filter((profile) => {
    const names = [normalizeKey(profile.name), normalizeKey(basename(profile.file, ".xmp"))];
    const nameMatches = names.some((name) => name.includes(recipeKey));
    const cameraMatches =
      profile.cameraRestriction === "" || cameraKey(profile.cameraRestriction) === camera;
    return nameMatches && cameraMatches;
  });
  if (candidates.length === 1) return { status: "matched", recipe, profile: candidates[0]! };
  if (candidates.length > 1) {
    return {
      status: "unknown",
      reason: `ambiguous_profiles:${candidates.map((p) => p.name).join("|")}`,
    };
  }
  return { status: "no_profile", recipe };
}

export function findExiftool(): string | undefined {
  const configured = process.env.PHOTO_AGENT_EXIFTOOL;
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    ...(localAppData ? [join(localAppData, "Programs", "ExifTool", "ExifTool.exe")] : []),
    "C:\\Program Files\\ExifTool\\exiftool.exe",
  ];
  return candidates.find((path) => existsSync(path)) ?? "exiftool";
}

/**
 * Read camera model and recipe from a NEF with exiftool. Paths go through a
 * UTF-8 argfile because exiftool mangles non-ASCII Windows argv paths.
 */
export async function readPhotoRecipes(
  rawPaths: readonly string[],
  exiftool = findExiftool(),
): Promise<Map<string, PhotoRecipe | undefined>> {
  const result = new Map<string, PhotoRecipe | undefined>();
  if (rawPaths.length === 0 || !exiftool) return result;
  const dir = await mkdtemp(join(tmpdir(), "photo-agent-exif-"));
  try {
    const argfile = join(dir, "args.txt");
    await writeFile(
      argfile,
      [
        "-charset",
        "filename=utf8",
        "-j",
        "-Model",
        "-PictureControlName",
        "-PictureControlBase",
        ...rawPaths,
      ].join("\n") + "\n",
      "utf8",
    );
    const { stdout } = await execFileAsync(exiftool, ["-@", argfile], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const rows = JSON.parse(stdout) as {
      SourceFile?: string;
      Model?: string;
      PictureControlName?: string;
      PictureControlBase?: string;
    }[];
    const byPath = new Map(rows.map((row) => [normalizePath(row.SourceFile ?? ""), row]));
    for (const raw of rawPaths) {
      const row = byPath.get(normalizePath(raw));
      result.set(
        raw,
        row?.Model && row.PictureControlName
          ? {
              model: String(row.Model),
              recipe: String(row.PictureControlName),
              ...(row.PictureControlBase ? { base: String(row.PictureControlBase) } : {}),
            }
          : undefined,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return result;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

export function recipePresetName(profile: RecipeProfile): string {
  return `photo-agent recipe ${profile.name}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A develop preset whose only setting is the recipe profile (`crs:Look`). */
export function recipePresetXmp(profileXml: string, profile: RecipeProfile): string {
  const tag = descriptionTag(profileXml);
  if (!tag) throw new Error(`Recipe profile has no rdf:Description: ${profile.file}`);
  const read = (name: string) => attribute(tag, name);
  const tableId = read("RGBTable");
  const tableName = tableId ? `Table_${tableId}` : undefined;
  const parameters: [string, string | undefined][] = [
    ["Version", read("Version")],
    ["ProcessVersion", read("ProcessVersion")],
    ["ConvertToGrayscale", read("ConvertToGrayscale")],
    ["CameraProfile", read("CameraProfile")],
    ["RGBTable", tableId],
    ...(tableName ? ([[tableName, read(tableName)]] as [string, string | undefined][]) : []),
  ];
  if (tableName && !read(tableName)) {
    throw new Error(`Recipe profile is missing its LUT ${tableName}: ${profile.file}`);
  }
  const supports = [
    "SupportsAmount",
    "SupportsColor",
    "SupportsMonochrome",
    "SupportsHighDynamicRange",
    "SupportsNormalDynamicRange",
    "SupportsSceneReferred",
    "SupportsOutputReferred",
  ];
  const presetUuid = createHash("md5")
    .update(`photo-agent-recipe-preset:${profile.uuid}`)
    .digest("hex")
    .toUpperCase();
  const attrs = (pairs: [string, string | undefined][], indent: string) =>
    pairs
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${indent}crs:${name}="${value}"`)
      .join("\n");
  const alt = (element: string, text: string, indent: string) =>
    [
      `${indent}<crs:${element}>`,
      `${indent} <rdf:Alt>`,
      `${indent}  <rdf:li xml:lang="x-default">${escapeXml(text)}</rdf:li>`,
      `${indent} </rdf:Alt>`,
      `${indent}</crs:${element}>`,
    ].join("\n");
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photo-agent">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    attrs(
      [
        ["PresetType", "Normal"],
        ["Cluster", ""],
        ["UUID", presetUuid],
        ["SupportsAmount", "False"],
        ["SupportsColor", "True"],
        ["SupportsMonochrome", "True"],
        ["SupportsHighDynamicRange", "True"],
        ["SupportsNormalDynamicRange", "True"],
        ["SupportsSceneReferred", "True"],
        ["SupportsOutputReferred", "True"],
        ["CameraModelRestriction", profile.cameraRestriction],
        ["Copyright", ""],
        ["ContactInfo", ""],
        ["Version", read("Version")],
        ["HasSettings", "True"],
      ],
      "   ",
    ) + ">",
    alt("Name", recipePresetName(profile), "   "),
    alt("Group", RECIPE_PRESET_GROUP, "   "),
    "   <crs:Look>",
    "    <rdf:Description",
    attrs(
      [
        ["Name", escapeXml(profile.name)],
        ["Amount", "1"],
        ["UUID", profile.uuid],
        ...supports.map((name) => [name, read(name)] as [string, string | undefined]),
        ["CameraModelRestriction", profile.cameraRestriction],
        ["Copyright", read("Copyright") ?? ""],
        ["ContactInfo", read("ContactInfo") ?? ""],
      ],
      "     ",
    ) + ">",
    alt("Group", profile.group, "     "),
    "     <crs:Parameters>",
    "      <rdf:Description",
    attrs(parameters, "       ") + "/>",
    "     </crs:Parameters>",
    "    </rdf:Description>",
    "   </crs:Look>",
    "  </rdf:Description>",
    " </rdf:RDF>",
    "</x:xmpmeta>",
    "",
  ].join("\n");
}

/**
 * Write the wrapping preset next to the profiles if it is not there yet.
 * Lightroom only loads new presets at startup, so `created: true` means a
 * restart is needed before `apply_develop_preset` can find it.
 */
export async function ensureRecipePreset(
  profile: RecipeProfile,
  settingsDir = defaultCameraRawSettingsDir(),
): Promise<{ path: string; created: boolean; presetName: string }> {
  const dir = join(settingsDir, RECIPE_PRESET_FOLDER);
  const fileName = `${recipePresetName(profile).replace(/[^A-Za-z0-9 ._-]/g, "_")}.xmp`;
  const path = join(dir, fileName);
  const xml = recipePresetXmp(await readFile(profile.file, "utf8"), profile);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined;
  }
  if (existing === xml) return { path, created: false, presetName: recipePresetName(profile) };
  await mkdir(dir, { recursive: true });
  await writeFile(path, xml, "utf8");
  return { path, created: true, presetName: recipePresetName(profile) };
}
