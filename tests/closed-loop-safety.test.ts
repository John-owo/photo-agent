import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MockBackend } from "../src/backends.js";
import { writeFixtureJpeg } from "../src/preview.js";
import { MockProvider } from "../src/providers.js";
import type { BackendPhotoState, EvaluationResult } from "../src/types.js";
import { runSinglePhoto } from "../src/workflow.js";

describe("closed-loop Copy safety", () => {
  it.each(["post-write identity", "refinement identity", "refinement state", "no-op refinement"])(
    "stops without further side effects on %s",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "photo-agent-loop-safety-"));
      const raw = join(root, "sample.NEF");
      const preview = join(root, "sample.JPG");
      await writeFile(raw, "synthetic raw fixture");
      await writeFixtureJpeg(preview);
      let evaluated = false;
      class ChangedBackend extends MockBackend {
        override async readCurrentEdit(photoId: string): Promise<BackendPhotoState> {
          const state = await super.readCurrentEdit(photoId);
          if (!state.identity?.is_virtual_copy) return state;
          if (
            (scenario === "post-write identity" &&
              this.calls.includes("apply_global_adjustment")) ||
            (scenario === "refinement identity" && evaluated)
          ) {
            return { ...state, identity: { ...state.identity, uuid: "different-copy-uuid" } };
          }
          if (scenario === "refinement state" && evaluated) {
            return { ...state, develop_settings: { ...state.develop_settings, Exposure2012: 2 } };
          }
          return state;
        }
      }
      const backend = new ChangedBackend(raw);
      let evaluationCalls = 0;
      const result = await runSinglePhoto({
        rawPath: raw,
        previewPath: preview,
        provider: new MockProvider(),
        backend,
        evaluator: {
          name: "safety-fixture",
          requiresCloudPreview: false,
          evaluate: async (): Promise<EvaluationResult> => {
            evaluated = true;
            evaluationCalls += 1;
            return evaluationCalls > 1 || scenario === "post-write identity"
              ? {
                  schema_version: "0.2.0",
                  verdict: "accept",
                  confidence: 0.9,
                  rationale: "fixture",
                  issues: [],
                }
              : {
                  schema_version: "0.2.0",
                  verdict: "refine",
                  confidence: 0.9,
                  rationale: "fixture refinement",
                  issues: ["fixture exposure"],
                  refinement_plan: {
                    schema_version: "0.1.0",
                    operations: [
                      {
                        parameter: "exposure_ev",
                        mode: "delta",
                        value: scenario === "no-op refinement" ? 0 : -0.2,
                        confidence: 0.9,
                        rationale: "fixture",
                      },
                    ],
                    warnings: [],
                  },
                };
          },
        },
        maxIterations: 2,
        sessionRoot: join(root, "sessions"),
        apply: true,
        allowCloudPreview: false,
      });
      expect(result.state).toBe("REVIEW_REQUIRED");
      expect(backend.calls.filter((call) => call === "create_workflow_copy")).toHaveLength(1);
      expect(backend.calls.filter((call) => call === "create_checkpoint")).toHaveLength(1);
      expect(backend.calls.filter((call) => call === "apply_global_adjustment")).toHaveLength(1);
      expect(evaluationCalls).toBe(scenario === "post-write identity" ? 0 : 1);
      const report = JSON.parse(
        await readFile(join(result.sessionDir, "iteration-report.json"), "utf8"),
      );
      expect(report.reason).toBe(
        scenario.includes("identity")
          ? "workflow_copy_identity_changed"
          : scenario === "refinement state"
            ? "workflow_copy_state_changed"
            : "no_effective_adjustments",
      );
      expect(await readFile(raw, "utf8")).toBe("synthetic raw fixture");
    },
  );
});
