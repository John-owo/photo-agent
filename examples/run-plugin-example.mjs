import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { loadPluginFromPath } = await import("../dist/src/plugin-loader.js");
const { SemanticIntentPlanSchema } = await import("../dist/src/schemas.js");
const { translateIntent } = await import("../dist/src/translator.js");
const scratchRoot =
  process.env.PHOTO_AGENT_EXAMPLE_ROOT || join(projectRoot, "..", ".photo-agent-example-runs");
const exampleRoot = await mkdtemp(join(scratchRoot, "photo-agent-plugin-example-"));

try {
  const pluginPath = fileURLToPath(new URL("./plugins/xmp-sidecar-plugin.mjs", import.meta.url));
  const loaded = await loadPluginFromPath(pluginPath, {
    pluginType: "backend",
    expectedTrustBoundary: {
      transport: "in-process filesystem",
      authentication: "none",
      cloud: false,
    },
    requiredOperations: ["create_xmp_sidecar"],
  });
  const backend = await loaded.create();
  const rawPath = join(exampleRoot, "example.NEF");
  const outputPath = join(exampleRoot, "example.xmp");
  await writeFile(rawPath, Buffer.from("synthetic RAW fixture for the plugin example\n"));
  const rawBefore = await readFile(rawPath);
  const plan = translateIntent(
    SemanticIntentPlanSchema.parse({
      schema_version: "0.1.0",
      creative_goal: "small exposure correction",
      adjustments: [
        {
          parameter: "exposure",
          direction: "increase",
          strength: "slight",
          rationale: "executable plugin fixture",
          confidence: 0.9,
        },
      ],
      overall_confidence: 0.9,
    }),
  );
  const result = await backend.exportXmpSidecar({
    sourcePath: rawPath,
    destinationPath: outputPath,
    currentSettings: { Exposure2012: 0 },
    plan,
  });
  const output = await stat(outputPath);
  if (!output.isFile() || output.size === 0) throw new Error("Plugin example produced no XMP file");
  if (!rawBefore.equals(await readFile(rawPath)))
    throw new Error("Plugin example changed its source");
  if (result.render_verified || result.visual_acceptance !== "REVIEW_REQUIRED") {
    throw new Error("Plugin example made an invalid visual-acceptance claim");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        example: "xmp-plugin",
        plugin: loaded.manifest.plugin_id,
        operation: result.operation,
        source_preserved: true,
        render_verified: result.render_verified,
        visual_acceptance: result.visual_acceptance,
        module_url: pathToFileURL(pluginPath).href,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(exampleRoot, { recursive: true, force: true });
}
