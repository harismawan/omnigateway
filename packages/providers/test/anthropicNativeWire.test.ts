import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { toWire } from "../src/anthropic/wire.ts";

const base: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

test("emits an Anthropic-defined tool with its exact version and options", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [
        {
          provider: "anthropic",
          family: "webSearch",
          type: "web_search_20250305",
          name: "web_search",
          wire: { max_uses: 5, allowed_domains: ["docs.anthropic.com"] },
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      allowed_domains: ["docs.anthropic.com"],
    },
  ]);
});

test("a toolset entry carries no name", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [
        {
          provider: "anthropic",
          family: "mcpToolset",
          type: "mcp_toolset",
          name: "",
          wire: { mcp_server_name: "docs" },
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([{ type: "mcp_toolset", mcp_server_name: "docs" }]);
});

test("preserves tool array order and each entry's cache breakpoint", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [
        { provider: "custom", name: "a", inputSchema: { type: "object" } },
        {
          provider: "anthropic",
          family: "bash",
          type: "bash_20250124",
          name: "bash",
          wire: {},
          cacheControl: { type: "ephemeral", ttl: "1h" },
        },
        { provider: "custom", name: "z", inputSchema: { type: "object" } },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    { name: "a", input_schema: { type: "object" } },
    {
      type: "bash_20250124",
      name: "bash",
      cache_control: { type: "ephemeral", ttl: "1h" },
    },
    { name: "z", input_schema: { type: "object" } },
  ]);
});

test("carries Anthropic-only custom tool options through", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [
        {
          provider: "custom",
          name: "a",
          inputSchema: { type: "object" },
          options: { strict: true, defer_loading: true },
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    { name: "a", input_schema: { type: "object" }, strict: true, defer_loading: true },
  ]);
});

test("replays a native history block as itself, not as a function call", () => {
  const { body, degradations } = toWire(
    {
      ...base,
      messages: [
        { role: "user", content: [{ type: "text", text: "search" }] },
        {
          role: "assistant",
          content: [
            {
              type: "anthropicNative",
              blockType: "server_tool_use",
              data: { id: "srvtoolu_1", name: "web_search", input: { query: "bun" } },
            },
            {
              type: "anthropicNative",
              blockType: "web_search_tool_result",
              data: {
                tool_use_id: "srvtoolu_1",
                content: [{ type: "web_search_result", url: "u", title: "t" }],
              },
            },
          ],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "bun" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [{ type: "web_search_result", url: "u", title: "t" }],
      },
    ],
  });
  expect(degradations).toEqual([]);
});

test("a native block keeps its cache breakpoint on replay", () => {
  const { body } = toWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "anthropicNative",
              blockType: "search_result",
              data: { source: "s", title: "t", content: [{ type: "text", text: "x" }] },
              cacheControl: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
    },
    "m",
    { oauth: false },
  );
  expect(body.messages[0]).toEqual({
    role: "user",
    content: [
      {
        type: "search_result",
        source: "s",
        title: "t",
        content: [{ type: "text", text: "x" }],
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  });
});
