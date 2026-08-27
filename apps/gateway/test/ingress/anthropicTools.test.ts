import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { ANTHROPIC_TOOL_SPECS } from "@omni/providers";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

/** The message a rejected request carries, or "" when it was accepted. */
function reason(body: unknown): string {
  try {
    parseAnthropicRequest(body);
    return "";
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    expect(e.code).toBe("BAD_REQUEST");
    return e.message;
  }
}

test("accepts the WebSearch declaration Claude Code sends", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
  });
  expect(req.tools).toEqual([
    {
      kind: "provider",
      provider: "anthropic",
      family: "webSearch",
      type: "web_search_20250305",
      name: "web_search",
      wire: { max_uses: 5 },
    },
  ]);
});

test("every supported version parses with its fixed name", () => {
  for (const [type, spec] of Object.entries(ANTHROPIC_TOOL_SPECS)) {
    const required: Record<string, unknown> = {};
    for (const field of spec.required) {
      required[field] =
        field === "model" ? "claude-opus-4" : field === "mcp_server_name" ? "docs" : 800;
    }
    const tool = { type, ...(spec.name === undefined ? {} : { name: spec.name }), ...required };
    const body = {
      ...minimal,
      tools: [tool],
      ...(spec.family === "mcpToolset"
        ? { mcp_servers: [{ type: "url", name: "docs", url: "u" }] }
        : {}),
    };
    const req = parseAnthropicRequest(body);
    expect(req.tools?.[0]).toMatchObject({
      kind: "provider",
      provider: "anthropic",
      family: spec.family,
      type,
    });
  }
});

test("an untagged custom tool and an explicit one normalize to the same variant", () => {
  const untagged = parseAnthropicRequest({
    ...minimal,
    tools: [{ name: "f", input_schema: { type: "object" } }],
  });
  const tagged = parseAnthropicRequest({
    ...minimal,
    tools: [{ type: "custom", name: "f", input_schema: { type: "object" } }],
  });
  expect(untagged.tools).toEqual(tagged.tools);
  expect(untagged.tools?.[0]).toEqual({
    kind: "portable",
    name: "f",
    inputSchema: { type: "object" },
  });
});

test("custom tools still require a complete input schema", () => {
  expect(reason({ ...minimal, tools: [{ name: "f" }] })).toContain("input_schema");
});

test("Anthropic-only custom tool options are carried, unknown ones are refused", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [{ name: "f", input_schema: { type: "object" }, strict: true, defer_loading: true }],
  });
  expect(req.tools?.[0]).toMatchObject({ options: { strict: true, defer_loading: true } });
  expect(
    reason({ ...minimal, tools: [{ name: "f", input_schema: {}, telepathy: true }] }),
  ).toContain("telepathy");
});

test("an unknown tool type is refused rather than forwarded by prefix", () => {
  const message = reason({
    ...minimal,
    tools: [{ type: "web_search_20991231", name: "web_search" }],
  });
  expect(message).toContain("tools.0.type");
  expect(message).toContain("web_search_20991231");
});

test("a wrong fixed name for a version is refused", () => {
  const message = reason({
    ...minimal,
    tools: [{ type: "text_editor_20250429", name: "str_replace_editor" }],
  });
  expect(message).toContain("tools.0.name");
  expect(message).toContain("str_replace_based_edit_tool");
});

test("missing required family fields are named", () => {
  expect(
    reason({ ...minimal, tools: [{ type: "computer_20250124", name: "computer" }] }),
  ).toContain("tools.0.display_width_px");
  expect(reason({ ...minimal, tools: [{ type: "advisor_20260301", name: "advisor" }] })).toContain(
    "tools.0.model",
  );
});

test("a field belonging to another version is refused", () => {
  expect(
    reason({
      ...minimal,
      tools: [
        {
          type: "computer_20250124",
          name: "computer",
          display_width_px: 1,
          display_height_px: 1,
          enable_zoom: true,
        },
      ],
    }),
  ).toContain("enable_zoom");
  expect(
    reason({
      ...minimal,
      tools: [
        { type: "text_editor_20250429", name: "str_replace_based_edit_tool", max_characters: 10 },
      ],
    }),
  ).toContain("max_characters");
  expect(
    reason({
      ...minimal,
      tools: [{ type: "web_fetch_20250910", name: "web_fetch", use_cache: true }],
    }),
  ).toContain("use_cache");
});

test("latest tool versions validate and preserve new fields", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [
      {
        type: "web_search_20260318",
        name: "web_search",
        response_inclusion: "excluded",
        allowed_callers: ["code_execution_20260521"],
      },
      {
        type: "web_fetch_20260318",
        name: "web_fetch",
        response_inclusion: "full",
        use_cache: false,
      },
      { type: "code_execution_20260521", name: "code_execution" },
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4", max_tokens: 512 },
    ],
  });
  expect(
    req.tools?.map((tool) => ({
      type: tool.kind === "provider" ? tool.type : "",
      wire: tool.kind === "provider" ? tool.wire : {},
    })),
  ).toEqual([
    {
      type: "web_search_20260318",
      wire: {
        response_inclusion: "excluded",
        allowed_callers: ["code_execution_20260521"],
      },
    },
    { type: "web_fetch_20260318", wire: { response_inclusion: "full", use_cache: false } },
    { type: "code_execution_20260521", wire: {} },
    { type: "advisor_20260301", wire: { model: "claude-opus-4", max_tokens: 512 } },
  ]);
});

test("response inclusion rejects values outside the exact enum", () => {
  expect(
    reason({
      ...minimal,
      tools: [{ type: "web_search_20260318", name: "web_search", response_inclusion: "summary" }],
    }),
  ).toContain("tools.0.response_inclusion");
});

test("the version that defines an option accepts it", () => {
  expect(
    parseAnthropicRequest({
      ...minimal,
      tools: [
        {
          type: "computer_20251124",
          name: "computer",
          display_width_px: 1024,
          display_height_px: 768,
          enable_zoom: true,
        },
      ],
    }).tools?.[0],
  ).toMatchObject({ wire: { display_width_px: 1024, display_height_px: 768, enable_zoom: true } });
});

test("allow and block domain lists are mutually exclusive", () => {
  expect(
    reason({
      ...minimal,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          allowed_domains: ["a.com"],
          blocked_domains: ["b.com"],
        },
      ],
    }),
  ).toContain("blocked_domains");
});

test("a toolset must name a server the request declares", () => {
  expect(
    reason({ ...minimal, tools: [{ type: "mcp_toolset", mcp_server_name: "ghost" }] }),
  ).toContain("mcp_server_name");
  const ok = parseAnthropicRequest({
    ...minimal,
    mcp_servers: [{ type: "url", name: "docs", url: "https://example.test" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "docs" }],
  });
  expect(ok.tools?.[0]).toMatchObject({ family: "mcpToolset", wire: { mcp_server_name: "docs" } });
  // The server list itself still reaches Anthropic through vendor passthrough.
  expect(ok.vendor?.anthropic?.mcp_servers).toBeDefined();
});

test("a tool cache breakpoint is preserved with its TTL", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [
      { type: "bash_20250124", name: "bash", cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
  });
  expect(req.tools?.[0]).toMatchObject({ cacheControl: { type: "ephemeral", ttl: "1h" } });
  expect(req.tools?.[0]).not.toMatchObject({ wire: { cache_control: expect.anything() } });
});

test("tool order is preserved across both kinds", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [
      { name: "a", input_schema: { type: "object" } },
      { type: "bash_20250124", name: "bash" },
      { name: "z", input_schema: { type: "object" } },
    ],
  });
  expect(req.tools?.map((t) => t.name)).toEqual(["a", "bash", "z"]);
});
