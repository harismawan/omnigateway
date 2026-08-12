import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { toWire } from "../../../../packages/providers/src/anthropic/wire.ts";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
};

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

test("replayed server tool use and its result survive ingress intact", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "bun" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.test",
                title: "t",
                encrypted_content: "OPAQUE",
                page_age: "1d",
              },
            ],
          },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content).toEqual([
    { type: "text", text: "looking" },
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
        content: [
          {
            type: "web_search_result",
            url: "https://example.test",
            title: "t",
            encrypted_content: "OPAQUE",
            page_age: "1d",
          },
        ],
      },
    },
  ]);
});

test("a server tool error result is carried, not rejected", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
          },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "web_search_tool_result",
    data: {
      tool_use_id: "srvtoolu_1",
      content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
    },
  });
});

test("text citations survive request-history replay", () => {
  const citation = {
    type: "char_location",
    cited_text: "source",
    document_index: 0,
    document_title: "doc",
    start_char_index: 1,
    end_char_index: 7,
  };
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer", citations: [citation] }],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "text",
    text: "answer",
    citations: [citation],
  });
});

test("redacted thinking survives instead of being flattened to empty text", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "assistant", content: [{ type: "redacted_thinking", data: "EncryptedBlob" }] },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "redacted_thinking",
    data: { data: "EncryptedBlob" },
  });
});

test("native request blocks replay to Anthropic wire in every legal role", () => {
  const cases = [
    {
      role: "assistant",
      block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "bun" },
      },
    },
    {
      role: "assistant",
      block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    },
    {
      role: "assistant",
      block: {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "web_fetch_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "bash_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "bash_code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "text_editor_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: {
          type: "text_editor_code_execution_tool_result_error",
          error_code: "unavailable",
        },
      },
    },
    {
      role: "assistant",
      block: {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "tool_search_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "advisor_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "mcp_tool_use",
        id: "mcptoolu_1",
        name: "lookup",
        server_name: "docs",
        input: {},
      },
    },
    {
      role: "user",
      block: { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: "result" },
    },
    { role: "user", block: { type: "container_upload", file_id: "file_1" } },
    {
      role: "assistant",
      block: { type: "compaction", content: "summary", encrypted_content: "opaque" },
    },
    {
      role: "user",
      block: {
        type: "search_result",
        source: "https://example.test",
        title: "result",
        content: [{ type: "text", text: "body" }],
      },
    },
    { role: "assistant", block: { type: "redacted_thinking", data: "opaque" } },
    {
      role: "user",
      block: {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "document" },
      },
    },
    {
      role: "system",
      block: { type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      role: "system",
      block: { type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      role: "assistant",
      block: {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-5" },
      },
    },
  ] as const;

  for (const { role, block } of cases) {
    const request = parseAnthropicRequest({
      ...minimal,
      messages:
        role === "system"
          ? [
              { role: "user", content: "before" },
              { role, content: [block] },
            ]
          : [{ role, content: [block] }],
    });
    const { body } = toWire(request, "claude-opus-5", { oauth: false });
    expect(body.messages.at(-1)).toEqual({ role, content: [block] });
  }
});

test("native request blocks reject every illegal role with an exact block path", () => {
  const cases = [
    {
      legal: "assistant",
      block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "bun" },
      },
    },
    {
      legal: "assistant",
      block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    },
    {
      legal: "assistant",
      block: {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "web_fetch_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "bash_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "bash_code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "text_editor_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: {
          type: "text_editor_code_execution_tool_result_error",
          error_code: "unavailable",
        },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "tool_search_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "advisor_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      legal: "assistant",
      block: {
        type: "mcp_tool_use",
        id: "mcptoolu_1",
        name: "lookup",
        server_name: "docs",
        input: {},
      },
    },
    { legal: "user", block: { type: "mcp_tool_result", tool_use_id: "mcptoolu_1" } },
    { legal: "user", block: { type: "container_upload", file_id: "file_1" } },
    { legal: "assistant", block: { type: "compaction", content: "summary" } },
    {
      legal: "user",
      block: {
        type: "search_result",
        source: "s",
        title: "t",
        content: [{ type: "text", text: "body" }],
      },
    },
    { legal: "assistant", block: { type: "redacted_thinking", data: "opaque" } },
    {
      legal: "user",
      block: {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "document" },
      },
    },
    {
      legal: "system",
      block: { type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      legal: "system",
      block: { type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      legal: "assistant",
      block: {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-5" },
      },
    },
  ] as const;

  for (const { legal, block } of cases) {
    for (const role of ["user", "assistant", "system"] as const) {
      if (role === legal) continue;
      const message = reason({
        ...minimal,
        messages:
          role === "system"
            ? [
                { role: "user", content: "before" },
                { role, content: [block] },
              ]
            : [{ role, content: [block] }],
      });
      const index = role === "system" ? 1 : 0;
      expect(message).toContain(`messages.${index}.content.0`);
      expect(message).toContain(`not legal in ${role} messages`);
    }
  }
});

test("system turns accept text and tool changes without dropping either", () => {
  const content = [
    { type: "text", text: "operator instruction" },
    { type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } },
  ];
  const request = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "before" },
      { role: "system", content },
    ],
  });
  const { body } = toWire(request, "claude-opus-5", { oauth: false });
  expect(body.messages[1]).toEqual({ role: "system", content });
  expect(body.system).toBeUndefined();
});

test("mid-conversation system block preserves nested text and cache markers", () => {
  const block = {
    type: "mid_conv_system",
    content: [{ type: "text", text: "operator instruction", cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral", ttl: "1h" },
  };
  const request = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "before" },
      { role: "system", content: [block] },
    ],
  });
  const { body } = toWire(request, "claude-opus-5", { oauth: false });
  expect(body.messages[1]).toEqual({ role: "system", content: [block] });
});

test("mid-conversation system block preserves null nested text cache control", () => {
  const block = {
    type: "mid_conv_system",
    content: [{ type: "text", text: "operator instruction", cache_control: null }],
  };
  const request = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "before" },
      { role: "system", content: [block] },
    ],
  });
  const { body } = toWire(request, "claude-opus-5", { oauth: false });
  expect(body.messages[1]).toEqual({ role: "system", content: [block] });
});

test("mid-conversation system block preserves null nested text citations", () => {
  const block = {
    type: "mid_conv_system",
    content: [{ type: "text", text: "operator instruction", citations: null }],
  };
  const request = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "before" },
      { role: "system", content: [block] },
    ],
  });
  const { body } = toWire(request, "claude-opus-5", { oauth: false });
  expect(body.messages[1]).toEqual({ role: "system", content: [block] });
});

test("mid-conversation system block supports beta nested tool changes", () => {
  const block = {
    type: "mid_conv_system",
    content: [
      {
        type: "tool_addition",
        tool: { type: "mcp_tool_reference", server_name: "docs", name: "lookup" },
      },
      {
        type: "tool_removal",
        tool: { type: "mcp_toolset_reference", server_name: "archive" },
      },
    ],
  };
  const request = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "before" },
      { role: "system", content: [block] },
    ],
  });
  const { body } = toWire(request, "claude-opus-5", { oauth: false });
  expect(body.messages[1]).toEqual({ role: "system", content: [block] });
});

test("mid-conversation system block rejects malformed nested content and illegal roles", () => {
  for (const [block, path] of [
    [{ type: "mid_conv_system" }, "content"],
    [{ type: "mid_conv_system", content: [{ type: "text" }] }, "content.0.text"],
    [{ type: "mid_conv_system", content: [{ type: "image", source: {} }] }, "content.0.type"],
    [{ type: "mid_conv_system", content: [], metadata: {} }, "metadata"],
    [
      {
        type: "mid_conv_system",
        content: [{ type: "tool_addition", tool: { type: "mcp_tool_reference", name: "lookup" } }],
      },
      "content.0.tool.server_name",
    ],
  ] as const) {
    expect(
      reason({
        ...minimal,
        messages: [
          { role: "user", content: "before" },
          { role: "system", content: [block] },
        ],
      }),
    ).toContain(`messages.1.content.0.${path}`);
  }

  for (const role of ["user", "assistant"] as const) {
    expect(
      reason({
        ...minimal,
        messages: [
          {
            role,
            content: [{ type: "mid_conv_system", content: [{ type: "text", text: "no" }] }],
          },
        ],
      }),
    ).toContain(`not legal in ${role} messages`);
  }
});

test("system turns reject illegal history position with message paths", () => {
  expect(
    reason({
      ...minimal,
      messages: [
        { role: "system", content: "cannot start" },
        { role: "user", content: "after" },
      ],
    }),
  ).toContain("messages.0");
  expect(
    reason({
      ...minimal,
      messages: [
        { role: "user", content: "before" },
        { role: "system", content: "instruction" },
        { role: "user", content: "illegal follower" },
      ],
    }),
  ).toContain("messages.1");
});

test("response-only and nested-only native blocks stay illegal in request history", () => {
  for (const block of [
    { type: "advisor_result", text: "answer" },
    { type: "advisor_redacted_result", data: "opaque" },
    { type: "tool_reference", tool_name: "lookup" },
  ]) {
    const message = reason({
      ...minimal,
      messages: [{ role: "assistant", content: [block] }],
    });
    expect(message).toContain("messages.0.content.0.type");
    expect(message).toContain("not legal in request history");
  }
});

test("a native block keeps its cache breakpoint as a canonical field", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
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
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "anthropicNative",
    blockType: "search_result",
    data: { source: "s", title: "t", content: [{ type: "text", text: "x" }] },
    cacheControl: { type: "ephemeral", ttl: "1h" },
  });
});

test("an unknown block type is refused with its path", () => {
  const message = reason({
    ...minimal,
    messages: [{ role: "assistant", content: [{ type: "quantum_result", x: 1 }] }],
  });
  expect(message).toContain("messages.0.content.0");
  expect(message).toContain("quantum_result");
});

test("every request-history native block rejects unknown top-level fields", () => {
  const blocks = [
    {
      role: "assistant",
      block: {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "bun" },
      },
    },
    {
      role: "assistant",
      block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
    },
    {
      role: "assistant",
      block: {
        type: "web_fetch_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "web_fetch_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "bash_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "bash_code_execution_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "text_editor_code_execution_tool_result",
        tool_use_id: "srvtoolu_1",
        content: {
          type: "text_editor_code_execution_tool_result_error",
          error_code: "unavailable",
        },
      },
    },
    {
      role: "assistant",
      block: {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "tool_search_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "advisor_tool_result",
        tool_use_id: "srvtoolu_1",
        content: { type: "advisor_tool_result_error", error_code: "unavailable" },
      },
    },
    {
      role: "assistant",
      block: {
        type: "mcp_tool_use",
        id: "mcptoolu_1",
        name: "lookup",
        server_name: "docs",
        input: {},
      },
    },
    {
      role: "user",
      block: { type: "mcp_tool_result", tool_use_id: "mcptoolu_1", content: "result" },
    },
    { role: "user", block: { type: "container_upload", file_id: "file_1" } },
    {
      role: "assistant",
      block: { type: "compaction", content: "summary", encrypted_content: "opaque" },
    },
    {
      role: "user",
      block: {
        type: "search_result",
        source: "https://example.test",
        title: "result",
        content: [{ type: "text", text: "body" }],
      },
    },
    { role: "assistant", block: { type: "redacted_thinking", data: "opaque" } },
    {
      role: "user",
      block: {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: "document" },
      },
    },
    {
      role: "system",
      block: { type: "tool_addition", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      role: "system",
      block: { type: "tool_removal", tool: { type: "tool_reference", name: "lookup" } },
    },
    {
      role: "assistant",
      block: {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-5" },
      },
    },
  ] as const;

  for (const { role, block } of blocks) {
    const message = reason({
      ...minimal,
      messages: [{ role, content: [{ ...block, illegal: true }] }],
    });
    expect(message).toContain("messages.0.content.0.illegal");
  }
});

test("tool changes round-trip every current beta reference variant", () => {
  for (const tool of [
    { type: "tool_reference", name: "lookup" },
    { type: "mcp_tool_reference", server_name: "docs", name: "lookup" },
    { type: "mcp_toolset_reference", server_name: "docs" },
  ]) {
    for (const type of ["tool_addition", "tool_removal"] as const) {
      const block = { type, tool };
      const request = parseAnthropicRequest({
        ...minimal,
        messages: [
          { role: "user", content: "before" },
          { role: "system", content: [block] },
        ],
      });
      const { body } = toWire(request, "claude-opus-5", { oauth: false });
      expect(body.messages[1]).toEqual({ role: "system", content: [block] });
    }
  }
});

test("tool changes reject malformed references at exact paths", () => {
  for (const [tool, path] of [
    [{ type: "tool_reference" }, "name"],
    [{ type: "mcp_tool_reference", name: "lookup" }, "server_name"],
    [{ type: "mcp_tool_reference", server_name: "docs" }, "name"],
    [{ type: "mcp_toolset_reference" }, "server_name"],
    [{ type: "tool_reference", name: "lookup", server_name: "docs" }, "server_name"],
    [{ type: "unknown_reference", name: "lookup" }, "type"],
  ] as const) {
    expect(
      reason({
        ...minimal,
        messages: [
          { role: "user", content: "before" },
          { role: "system", content: [{ type: "tool_addition", tool }] },
        ],
      }),
    ).toContain(`messages.1.content.0.tool.${path}`);
  }
});

test("fallback round-trips optional opaque trigger including null", () => {
  for (const trigger of [{ type: "refusal", category: "cyber", future: { opaque: true } }, null]) {
    const block = {
      type: "fallback",
      from: { model: "claude-fable-5" },
      to: { model: "claude-opus-5" },
      trigger,
    };
    const request = parseAnthropicRequest({
      ...minimal,
      messages: [{ role: "assistant", content: [block] }],
    });
    const { body } = toWire(request, "claude-opus-5", { oauth: false });
    expect(body.messages[0]).toEqual({ role: "assistant", content: [block] });
  }
});

test("fallback rejects unknown top-level metadata", () => {
  const message = reason({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "fallback",
            from: { model: "claude-fable-5" },
            to: { model: "claude-opus-5" },
            metadata: {},
          },
        ],
      },
    ],
  });
  expect(message).toContain("messages.0.content.0.metadata");
});

test("native structured fields validate discriminators and required properties", () => {
  for (const [role, block, path] of [
    ["user", { type: "document", source: {} }, "source.type"],
    ["user", { type: "document", source: { type: "text" } }, "source.media_type"],
    ["assistant", { type: "fallback", from: { model: "claude-fable-5" }, to: {} }, "to.model"],
    ["assistant", { type: "fallback", from: {}, to: { model: "claude-opus-5" } }, "from.model"],
    ["system", { type: "tool_addition", tool: {} }, "tool.type"],
    ["system", { type: "tool_addition", tool: { type: "tool_reference" } }, "tool.name"],
    ["system", { type: "tool_removal", tool: {} }, "tool.type"],
    ["system", { type: "tool_removal", tool: { type: "tool_reference" } }, "tool.name"],
  ] as const) {
    const messages =
      role === "system"
        ? [
            { role: "user", content: "before" },
            { role, content: [block] },
          ]
        : [{ role, content: [block] }];
    const index = role === "system" ? 1 : 0;
    expect(reason({ ...minimal, messages })).toContain(`messages.${index}.content.0.${path}`);
  }
});

test("native blocks validate required top-level fields at precise paths", () => {
  for (const [role, block, field] of [
    ["assistant", { type: "server_tool_use", name: "web_search", input: {} }, "id"],
    ["assistant", { type: "web_search_tool_result", content: [] }, "tool_use_id"],
    ["user", { type: "document" }, "source"],
    ["assistant", { type: "fallback", from: { model: "claude-fable-5" } }, "to"],
  ] as const) {
    expect(reason({ ...minimal, messages: [{ role, content: [block] }] })).toContain(
      `messages.0.content.0.${field}`,
    );
  }
});

test("required opaque native fields reject omission at their exact paths", () => {
  for (const [block, field] of [
    [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search" }, "input"],
    [{ type: "mcp_tool_use", id: "mcptoolu_1", name: "lookup", server_name: "docs" }, "input"],
    [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "web_fetch_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "code_execution_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "bash_code_execution_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "text_editor_code_execution_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "tool_search_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
    [{ type: "advisor_tool_result", tool_use_id: "srvtoolu_1" }, "content"],
  ] as const) {
    expect(reason({ ...minimal, messages: [{ role: "assistant", content: [block] }] })).toContain(
      `messages.0.content.0.${field}`,
    );
  }
});

test("required native result content rejects explicit null", () => {
  for (const type of [
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "advisor_tool_result",
  ]) {
    expect(
      reason({
        ...minimal,
        messages: [
          { role: "assistant", content: [{ type, tool_use_id: "srvtoolu_1", content: null }] },
        ],
      }),
    ).toContain("messages.0.content.0.content");
  }
});

test("required unknown inputs preserve explicit null", () => {
  for (const block of [
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: null },
    { type: "mcp_tool_use", id: "mcptoolu_1", name: "lookup", server_name: "docs", input: null },
  ]) {
    const request = parseAnthropicRequest({
      ...minimal,
      messages: [{ role: "assistant", content: [block] }],
    });
    expect(request.messages[0]?.content[0]).toMatchObject({
      type: "anthropicNative",
      data: { input: null },
    });
  }
});

test("native blocks reject malformed cache control instead of discarding it", () => {
  const message = reason({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: {},
            cache_control: { type: "forever" },
          },
        ],
      },
    ],
  });
  expect(message).toContain("messages.0.content.0.cache_control.type");
});

test("native block validation preserves nested provider payloads", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [{ type: "future_nested_result", opaque: { x: 1 } }],
            caller: { type: "code_execution_20260521", tool_id: "srvtoolu_2" },
          },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({
    type: "anthropicNative",
    data: {
      content: [{ type: "future_nested_result", opaque: { x: 1 } }],
      caller: { type: "code_execution_20260521", tool_id: "srvtoolu_2" },
    },
  });
});

test("a malformed native block is refused with its path", () => {
  expect(reason({ ...minimal, messages: [{ role: "user", content: [42] }] })).toContain(
    "messages.0.content.0",
  );
});

test("a portable tool result is still flattened and correlated", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "one" }] },
        ],
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toMatchObject({ type: "toolResult", content: "one" });
});
