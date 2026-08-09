import { expect, test } from "bun:test";
import type { ChatRequest } from "../src/index.ts";
import { estimateInputTokens } from "../src/index.ts";

const base: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  stream: false,
};

test("counts prose", () => {
  const small = estimateInputTokens(base);
  const large = estimateInputTokens({
    ...base,
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(4_000) }] }],
  });
  expect(large).toBeGreaterThan(small + 900);
});

// The failure this guards against is not an inaccurate number, it is a number
// near zero. A session whose tokens are all inside tool results is the normal
// shape of agentic work, and a client pacing itself against a near-zero count
// never compacts at all — it grows until the upstream rejects the request.
test("counts a conversation whose tokens are almost all inside tool results", () => {
  const transcript: ChatRequest = {
    ...base,
    messages: [
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "t1", name: "read", input: { path: "/etc/hosts" } },
          { type: "toolUse", id: "t2", name: "read", input: { path: "/etc/passwd" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "t1", content: "a".repeat(40_000) },
          { type: "toolResult", toolUseId: "t2", content: "b".repeat(40_000) },
        ],
      },
    ],
  };

  // 80,000 characters of tool output is roughly 20,000 tokens at four
  // characters each. An estimator that walked only `text` would return single
  // digits for this request.
  expect(estimateInputTokens(transcript)).toBeGreaterThan(19_000);
});

test("counts tool definitions, including their schemas", () => {
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: "string", description: "d" }]),
    ),
  };
  const withTools = estimateInputTokens({
    ...base,
    tools: [{ name: "read", description: "reads a file", inputSchema: schema }],
  });
  expect(withTools).toBeGreaterThan(estimateInputTokens(base) + 200);
});

test("counts the system prompt", () => {
  const withSystem = estimateInputTokens({
    ...base,
    system: [{ type: "text", text: "y".repeat(2_000) }],
  });
  expect(withSystem).toBeGreaterThan(estimateInputTokens(base) + 400);
});

test("counts replayed thinking", () => {
  const withThinking = estimateInputTokens({
    ...base,
    messages: [
      ...base.messages,
      {
        role: "assistant",
        content: [{ type: "thinking", text: "z".repeat(2_000), signature: "s" }],
      },
    ],
  });
  expect(withThinking).toBeGreaterThan(estimateInputTokens(base) + 400);
});

test("an image counts as a flat figure rather than as its base64 bytes", () => {
  const withImage = estimateInputTokens({
    ...base,
    messages: [
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: "A".repeat(80_000) }],
      },
    ],
  });
  // Counting the payload as text would report ~20,000 tokens for one image.
  expect(withImage).toBeLessThan(5_000);
  expect(withImage).toBeGreaterThan(0);
});

test("tool arguments that cannot be serialized do not throw", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() =>
    estimateInputTokens({
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "t", name: "n", input: cyclic }] },
      ],
    }),
  ).not.toThrow();
});
