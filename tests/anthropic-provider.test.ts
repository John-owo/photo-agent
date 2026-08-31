import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_PROVIDER_CAPABILITIES,
  ANTHROPIC_PROMPT,
  AnthropicProvider,
} from "../src/anthropic-provider.js";

const intent = {
  schema_version: "0.1.0" as const,
  creative_goal: "anthropic fixture",
  adjustments: [],
  overall_confidence: 0.9,
};

describe("T53 Anthropic provider contract", () => {
  it("maps an injected structured result without persisting provider payloads", async () => {
    const requests: Array<{ sanitizedPreviewPath: string; model: string; prompt: string }> = [];
    const provider = new AnthropicProvider(async (request) => {
      requests.push(request);
      return {
        intent,
        responseId: "msg_fixture",
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      };
    }, "claude-fixture");

    const result = await provider.analyze("D:/photo/_agent_workspace/sanitized-preview.jpg");

    expect(provider.requiresCloudPreview).toBe(true);
    expect(provider.capabilities).toEqual(ANTHROPIC_PROVIDER_CAPABILITIES);
    expect(requests).toEqual([
      {
        sanitizedPreviewPath: "D:/photo/_agent_workspace/sanitized-preview.jpg",
        model: "claude-fixture",
        prompt: ANTHROPIC_PROMPT,
      },
    ]);
    expect(result.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-fixture",
      responseId: "msg_fixture",
      cloudPreview: true,
      usage: { totalTokens: 20 },
    });
    expect(result).not.toHaveProperty("credentials");
    expect(result).not.toHaveProperty("request");
  });

  it("rejects an injected result that is not the shared semantic schema", async () => {
    const provider = new AnthropicProvider(async () => ({ intent: { invalid: true } }));
    await expect(provider.analyze("sanitized-preview.jpg")).rejects.toThrow();
  });
});
