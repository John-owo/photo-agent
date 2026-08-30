import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const { writeFixtureJpeg } = await import("../dist/src/preview.js");
const exampleRoot = await mkdtemp(join(tmpdir(), "photo-agent-example-"));

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

try {
  const rawPath = join(exampleRoot, "example.NEF");
  const previewPath = join(exampleRoot, "example.JPG");
  const sessionRoot = join(exampleRoot, "sessions");
  await writeFile(rawPath, Buffer.from("synthetic RAW fixture for the clean-clone example\n"));
  await writeFixtureJpeg(previewPath);
  const rawBefore = await readFile(rawPath);
  const previewBefore = await readFile(previewPath);

  const run = await runCli([
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
  ]);
  if (run.code !== 0) {
    throw new Error(
      `clean-clone example failed with code ${run.code ?? "null"}${
        run.signal ? ` (${run.signal})` : ""
      }\n${run.stderr}\n${run.stdout}`,
    );
  }

  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch (error) {
    throw new Error(`clean-clone example returned invalid JSON: ${error}\n${run.stdout}`);
  }
  if (result.state !== "ACCEPTED") {
    throw new Error(`clean-clone example did not reach ACCEPTED: ${JSON.stringify(result)}`);
  }
  if (typeof result.renderPath !== "string") {
    throw new Error("clean-clone example did not return a render path");
  }
  await stat(result.renderPath);

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
