import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

const config = { enabled: true };

/** Long enough that RTK would compress it if it were a portable tool result. */
const noisy = Array.from(
  { length: 400 },
  (_, i) => `2026-08-11T00:00:0${i % 10}Z INFO same line`,
).join("\n");

test("a provider-native server-tool result is left byte-identical", () => {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "server_tool_use",
            data: { id: "srvtoolu_1", name: "web_search", input: { query: "logs" } },
          },
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "web_search_tool_result",
            data: {
              tool_use_id: "srvtoolu_1",
              content: [{ type: "web_search_result", url: "u", encrypted_content: noisy }],
            },
          },
        ],
      },
    ],
  };
  // Compared against a copy taken before the call, not against `request`
  // itself: RTK returns the same object when nothing changed, so asserting
  // against the live one would pass even if it had been rewritten in place.
  // This is the assertion standing between a renamed block variant and RTK
  // silently rewriting a payload it is contractually not allowed to read.
  const before = structuredClone(request.messages);
  const { request: out, report } = transformRequest(request, config);
  expect(out.messages).toEqual(before);
  expect(report.filters).toEqual([]);
});

test("a provider-native block beside a compressible custom result does not block compression", () => {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "server_tool_use",
            data: { id: "srvtoolu_1", name: "web_search", input: {} },
          },
          { type: "toolUse", id: "call", name: "Bash", input: { command: "cat app.log" } },
        ],
      },
      { role: "user", content: [{ type: "toolResult", toolUseId: "call", content: noisy }] },
    ],
  };
  const { request: out } = transformRequest(request, config);
  expect(out.messages[0]?.content[0]).toEqual(request.messages[0]?.content[0] as never);
  const result = out.messages[1]?.content[0];
  expect(result?.type).toBe("toolResult");
  expect(result && "content" in result ? result.content.length : 0).toBeLessThan(noisy.length);
});

/**
 * The native block shares a message with the result that gets compressed.
 *
 * That placement is what makes this test bite. RTK rebuilds a message's content
 * only when something in *that* message was compressed, and returns the
 * original object otherwise — so in the two tests above, a branch that rewrote
 * a `providerNative` block would have its output thrown away before anything
 * could observe it, and both would still pass. Here the rebuilt array is the
 * one that ships, and the fall-through is the only reason the block survives it.
 */
test("a provider-native block in the message being rewritten is untouched", () => {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "call", name: "Bash", input: { command: "cat app.log" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "providerNative",
            provider: "anthropic",
            blockType: "web_search_tool_result",
            data: {
              tool_use_id: "srvtoolu_1",
              content: [{ type: "web_search_result", url: "u", encrypted_content: noisy }],
            },
          },
          { type: "toolResult", toolUseId: "call", content: noisy },
        ],
      },
    ],
  };
  const native = structuredClone(request.messages[1]?.content[0]);
  const { request: out } = transformRequest(request, config);
  const result = out.messages[1]?.content[1];
  expect(result && "content" in result ? result.content.length : 0).toBeLessThan(noisy.length);
  expect(out.messages[1]?.content[0]).toEqual(native as never);
});
