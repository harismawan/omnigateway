import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { transformRequest } from "../src/index.ts";

const config = { enabled: true };

/** Long enough that RTK would compress it if it were a portable tool result. */
const noisy = Array.from(
  { length: 400 },
  (_, i) => `2026-08-11T00:00:0${i % 10}Z INFO same line`,
).join("\n");

test("a native server-tool result is left byte-identical", () => {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "anthropicNative",
            blockType: "server_tool_use",
            data: { id: "srvtoolu_1", name: "web_search", input: { query: "logs" } },
          },
          {
            type: "anthropicNative",
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
  const { request: out, report } = transformRequest(request, config);
  expect(out.messages).toEqual(request.messages);
  expect(report.filters).toEqual([]);
});

test("a native block beside a compressible custom result does not block compression", () => {
  const request: ChatRequest = {
    model: "fast",
    stream: false,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "anthropicNative",
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
