import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { writeFixtureJpeg } = await import("../dist/src/preview.js");
const { ingestPair } = await import("../dist/src/ingest.js");
const { SessionStore } = await import("../dist/src/runtime.js");
const scratchRoot =
  process.env.PHOTO_AGENT_EXAMPLE_ROOT || join(projectRoot, "..", ".photo-agent-example-runs");
await mkdir(scratchRoot, { recursive: true });
const exampleRoot = await mkdtemp(join(scratchRoot, "photo-agent-example-"));

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, "dist", "src", "cli.js"), ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function parseCliJson(run, label) {
  if (run.code !== 0) {
    throw new Error(
      `${label} failed with code ${run.code ?? "null"}${
        run.signal ? ` (${run.signal})` : ""
      }\n${run.stderr}\n${run.stdout}`,
    );
  }
  try {
    return JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error}\n${run.stdout}`);
  }
}

try {
  const rawPath = join(exampleRoot, "example.NEF");
  const previewPath = join(exampleRoot, "example.JPG");
  const sessionRoot = join(exampleRoot, "sessions");
  await writeFile(rawPath, Buffer.from("synthetic RAW fixture for the clean-clone example\n"));
  await writeFixtureJpeg(previewPath);
  const rawBefore = await readFile(rawPath);
  const previewBefore = await readFile(previewPath);

  const result = parseCliJson(
    await runCli([
      "edit-one",
      "--raw",
      rawPath,
      "--preview",
      previewPath,
      "--backend",
      "mock",
      "--provider",
      "mock",
      "--apply",
      "--evaluator",
      "mock",
      "--max-iterations",
      "3",
      "--session-root",
      sessionRoot,
    ]),
    "clean-clone example",
  );
  if (result.state !== "ACCEPTED") {
    throw new Error(`clean-clone example did not reach ACCEPTED: ${JSON.stringify(result)}`);
  }
  if (typeof result.renderPath !== "string") {
    throw new Error("clean-clone example did not return a render path");
  }
  const render = await stat(result.renderPath);
  if (!render.isFile() || render.size === 0) {
    throw new Error("clean-clone example did not produce a non-empty render file");
  }
  await readFile(result.renderPath);

  const source = await ingestPair(rawPath, previewPath);
  const interrupted = await SessionStore.create(sessionRoot, source, "mock");
  await interrupted.transition("ANALYZING");
  await interrupted.transition("PLAN_READY");
  await interrupted.transition("APPLYING");
  const recovery = parseCliJson(
    await runCli(["recover", "--session", interrupted.dir, "--backend", "mock"]),
    "clean-clone recovery example",
  );
  if (recovery.state !== "REVIEW_REQUIRED") {
    throw new Error(`clean-clone recovery did not stop for review: ${JSON.stringify(recovery)}`);
  }
  const recoveryArtifacts = await readdir(join(recovery.sessionDir, "recovery"));
  if (!recoveryArtifacts.some((name) => name.endsWith(".json"))) {
    throw new Error("clean-clone recovery did not write a recovery report");
  }

  const rawAfter = await readFile(rawPath);
  const previewAfter = await readFile(previewPath);
  if (!rawBefore.equals(rawAfter) || !previewBefore.equals(previewAfter)) {
    throw new Error("clean-clone example changed a source fixture");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        example: "single-photo",
        state: result.state,
        recovery_state: recovery.state,
        render: result.renderPath,
        source_preserved: true,
        external_backend: false,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(exampleRoot, { recursive: true, force: true });
}
