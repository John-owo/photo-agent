import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { materializePreviewArtifact, writeFixtureJpeg } from "../src/preview.js";

describe("preview filesystem containment", () => {
  it.each(["render root", "backend source", "iteration output"] as const)(
    "refuses an external directory link at the %s boundary",
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), "photo-agent-preview-containment-"));
      const session = join(root, "session");
      const renders = join(session, "renders");
      const external = join(root, "outside-session");
      await mkdir(session);
      await mkdir(external);
      const externalImage = join(external, "source.jpg");
      await writeFixtureJpeg(externalImage);
      const before = await readFile(externalImage);
      let source: string;
      if (boundary === "render root") {
        await symlink(external, renders, "junction");
        source = join(renders, "source.jpg");
      } else {
        await mkdir(renders);
        if (boundary === "backend source") {
          await symlink(external, join(renders, "external"), "junction");
          source = join(renders, "external", "source.jpg");
        } else {
          source = join(renders, "source.jpg");
          await writeFixtureJpeg(source);
          await symlink(external, join(renders, "iteration-1"), "junction");
        }
      }

      await expect(materializePreviewArtifact(session, 1, source)).rejects.toThrow(
        /inside the session/,
      );

      expect(await readdir(external)).toEqual(["source.jpg"]);
      expect(await readFile(externalImage)).toEqual(before);
      await expect(access(join(renders, "iteration-1", "preview.jpg"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("retains deterministic artifact paths for an ordinary in-session render", async () => {
    const root = await mkdtemp(join(tmpdir(), "photo-agent-preview-contained-"));
    const renders = join(root, "renders");
    const source = join(renders, "backend.jpg");
    await writeFixtureJpeg(source);
    const before = await readFile(source);

    const artifact = await materializePreviewArtifact(root, 1, source);

    expect(artifact.path).toBe("renders/iteration-1/preview.jpg");
    expect(artifact.source_path).toBe("renders/backend.jpg");
    expect(await readFile(source)).toEqual(before);
    expect(artifact.sha256).toBe(
      createHash("sha256")
        .update(await readFile(join(root, artifact.path)))
        .digest("hex"),
    );
  });
});
