import { expect, test } from "bun:test";
import type { ChatRequest, ContentBlock, Message, ProviderNativeBlock } from "@omni/ir";
import { SEGMENT_CHARS, segments } from "../../src/smartRouter/extract.ts";

const req = (overrides: Partial<ChatRequest>): ChatRequest => ({
  model: "fast",
  stream: false,
  messages: [],
  ...overrides,
});

const containing = (all: string[], marker: string): boolean => all.some((s) => s.includes(marker));

test("system, user, assistant, thinking, tool call arguments and tool results are all judged", () => {
  const out = segments(
    req({
      system: [{ type: "text", text: "MARK-system" }],
      tools: [
        {
          kind: "portable",
          name: "MARK-tool-name",
          description: "MARK-tool-desc",
          inputSchema: {},
        },
        {
          kind: "provider",
          provider: "anthropic",
          type: "bash_20250124",
          name: "MARK-hosted",
          wire: {},
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "MARK-user" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "MARK-thinking" },
            { type: "text", text: "MARK-assistant" },
            { type: "toolUse", id: "t1", name: "Write", input: { content: "MARK-args" } },
          ],
        },
        { role: "system", content: [{ type: "text", text: "MARK-mid-system" }] },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "t1", content: "MARK-result" }],
        },
      ],
    }),
  );
  for (const marker of [
    "MARK-system",
    "MARK-tool-name",
    "MARK-tool-desc",
    "MARK-hosted",
    "MARK-user",
    "MARK-thinking",
    "MARK-assistant",
    "MARK-args",
    "Write",
    "MARK-mid-system",
    "MARK-result",
  ]) {
    expect(containing(out, marker)).toBe(true);
  }
});

test("a tool call with no input is still judged by name and does not throw", () => {
  const out = segments(
    req({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "MARK-noargs", input: undefined }],
        },
      ],
    }),
  );
  expect(containing(out, "MARK-noargs")).toBe(true);
  expect(containing(out, "undefined")).toBe(false);
});

test("images and files are not judged", () => {
  const b64 = "BASE64-MARKER-AAAA";
  const out = segments(
    req({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: b64 },
            {
              type: "toolResult",
              toolUseId: "t1",
              content: "visible",
              images: [{ type: "image", mediaType: "image/png", data: b64 }],
              files: [{ type: "file", mediaType: "application/pdf", data: b64 }],
            },
          ],
        },
      ],
    }),
  );
  expect(containing(out, "visible")).toBe(true);
  expect(containing(out, b64)).toBe(false);
});

const native = (
  blockType: string,
  data: Record<string, unknown>,
  provider = "anthropic",
): ProviderNativeBlock => ({ type: "providerNative", provider, blockType, data });

const inMessage = (role: Message["role"], block: ContentBlock): string[] =>
  segments(req({ messages: [{ role, content: [block] }] }));

const inToolResult = (part: ProviderNativeBlock): string[] =>
  inMessage("user", { type: "toolResult", toolUseId: "t1", content: "", native: [part] });

test("a text document's source data is judged, prefixed with its block type", () => {
  const doc = native("document", {
    source: { type: "text", media_type: "text/plain", data: "MARK-doc-text" },
    citations: { enabled: true },
  });
  const out = inMessage("user", doc);
  expect(containing(out, "MARK-doc-text")).toBe(true);
  expect(containing(out, "[document]")).toBe(true);
});

test("a content document's text parts are judged", () => {
  const out = inToolResult(
    native("document", {
      source: { type: "content", content: [{ type: "text", text: "MARK-doc-content" }] },
      context: "MARK-doc-context",
    }),
  );
  expect(containing(out, "MARK-doc-content")).toBe(true);
  expect(containing(out, "MARK-doc-context")).toBe(true);
});

test("a search result's content, title and source are judged", () => {
  const out = inToolResult(
    native("search_result", {
      source: "MARK-sr-source",
      title: "MARK-sr-title",
      content: [{ type: "text", text: "MARK-sr-content" }],
    }),
  );
  for (const marker of ["MARK-sr-source", "MARK-sr-title", "MARK-sr-content", "[search_result]"])
    expect(containing(out, marker)).toBe(true);
});

test("an MCP tool result's content is judged, as a string or as text parts", () => {
  const asString = inMessage("user", native("mcp_tool_result", { content: "MARK-mcp-string" }));
  expect(containing(asString, "MARK-mcp-string")).toBe(true);
  const asParts = inMessage(
    "user",
    native("mcp_tool_result", { content: [{ type: "text", text: "MARK-mcp-part" }] }),
  );
  expect(containing(asParts, "MARK-mcp-part")).toBe(true);
});

test("compaction content is judged", () => {
  const out = inMessage("assistant", native("compaction", { content: "MARK-compaction" }));
  expect(containing(out, "MARK-compaction")).toBe(true);
});

test("a native mid-conversation system turn's text is judged", () => {
  const out = inMessage(
    "system",
    native("mid_conv_system", { content: [{ type: "text", text: "MARK-mid-native" }] }),
  );
  expect(containing(out, "MARK-mid-native")).toBe(true);
});

test("a Responses local shell output is judged", () => {
  const out = inMessage(
    "user",
    native("local_shell_call_output", { call_id: "c1", output: "MARK-shell-output" }, "openai"),
  );
  expect(containing(out, "MARK-shell-output")).toBe(true);
});

test("the vendor bag is judged", () => {
  const out = segments(
    req({
      vendor: {
        openai: {
          prediction: { type: "content", content: "MARK-prediction" },
          response_format: {
            type: "json_schema",
            json_schema: { name: "x", schema: { description: "MARK-format-desc" } },
          },
        },
      },
    }),
  );
  expect(containing(out, "MARK-prediction")).toBe(true);
  expect(containing(out, "MARK-format-desc")).toBe(true);
});

test("an empty vendor bag adds nothing", () => {
  expect(segments(req({ vendor: {} }))).toEqual([]);
});

test("a base64 document source's data is not judged", () => {
  const out = inToolResult(
    native("document", {
      source: { type: "base64", media_type: "application/pdf", data: "B64-MARKER" },
      title: "MARK-pdf-title",
    }),
  );
  expect(containing(out, "MARK-pdf-title")).toBe(true);
  expect(containing(out, "B64-MARKER")).toBe(false);
});

test("signatures, encrypted content, ids and other excluded keys are not judged", () => {
  const out = inMessage(
    "assistant",
    native("compaction", {
      content: "visible",
      signature: "SIG-MARKER",
      encrypted_content: "ENC-MARKER",
      encrypted_index: "IDX-MARKER",
      id: "ID-MARKER",
      tool_use_id: "TUID-MARKER",
      media_type: "MT-MARKER",
      cache_control: { type: "ephemeral", ttl: "CC-MARKER" },
      nested: [{ type: "TYPE-MARKER", signature: "SIG2-MARKER" }],
    }),
  );
  expect(containing(out, "visible")).toBe(true);
  for (const marker of [
    "SIG-MARKER",
    "SIG2-MARKER",
    "ENC-MARKER",
    "IDX-MARKER",
    "ID-MARKER",
    "TUID-MARKER",
    "MT-MARKER",
    "CC-MARKER",
    "TYPE-MARKER",
  ])
    expect(containing(out, marker)).toBe(false);
});

test("an obvious base64 payload is skipped wherever it sits", () => {
  const blob = "QUJD".repeat(300);
  const out = inMessage("assistant", native("redacted_thinking", { data: blob, note: "kept" }));
  expect(containing(out, "kept")).toBe(true);
  expect(containing(out, blob.slice(0, 64))).toBe(false);
  // A short base64-alphabet string is ordinary text and stays.
  const short = inMessage("assistant", native("compaction", { content: "SecretWord" }));
  expect(containing(short, "SecretWord")).toBe(true);
});

test("a native block with no judged strings contributes nothing", () => {
  expect(inMessage("assistant", native("redacted_thinking", { signature: "s" }))).toEqual([]);
});

test("no segment exceeds SEGMENT_CHARS and nothing is cut", () => {
  const text = "abcdefghij".repeat(2_000);
  const out = segments(req({ messages: [{ role: "user", content: [{ type: "text", text }] }] }));
  expect(out.length).toBeGreaterThan(1);
  for (const s of out) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(out.join("")).toBe(`[user]\n${text}`);
});

test("an oversized system prompt and tool list are split, not cut", () => {
  const text = "s".repeat(20_000);
  const out = segments(req({ system: [{ type: "text", text }] }));
  expect(out.length).toBe(3);
  for (const s of out) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(out.join("")).toBe(text);

  const description = "d".repeat(20_000);
  const tools = segments(
    req({ tools: [{ kind: "portable", name: "big", description, inputSchema: {} }] }),
  );
  for (const s of tools) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(tools.join("")).toContain(description);
});

test("a slice never splits a surrogate pair", () => {
  const text = "😀".repeat(SEGMENT_CHARS);
  const out = segments(req({ messages: [{ role: "user", content: [{ type: "text", text }] }] }));
  for (const s of out) {
    expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
    expect(s.isWellFormed()).toBe(true);
  }
  expect(out.join("")).toBe(`[user]\n${text}`);
});

const turn = (i: number): Message => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [
    { type: "text", text: `turn ${i} ${String.fromCharCode(97 + (i % 26)).repeat(3_000)}` },
  ],
});

test("appending a turn leaves every earlier closed segment unchanged", () => {
  const all = Array.from({ length: 12 }, (_, i) => turn(i));
  for (let n = 1; n < all.length; n++) {
    const before = segments(req({ messages: all.slice(0, n) }));
    const after = segments(req({ messages: all.slice(0, n + 1) }));
    const closed = before.slice(0, -1);
    expect(after.slice(0, closed.length)).toEqual(closed);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  }
  expect(segments(req({ messages: all })).length).toBeGreaterThan(3);
});

test("a changed system prompt or tool list does not change message segments", () => {
  const messages = Array.from({ length: 6 }, (_, i) => turn(i));
  const bare = segments(req({ messages }));
  const a = segments(req({ system: [{ type: "text", text: "system A" }], messages }));
  const b = segments(
    req({
      system: [{ type: "text", text: "a rather different system B" }],
      tools: [{ kind: "portable", name: "t", description: "d", inputSchema: {} }],
      messages,
    }),
  );
  expect(a.slice(1)).toEqual(bare);
  expect(b.slice(2)).toEqual(bare);
  expect(a[0]).toBe("system A");
});

test("units that do not fit are packed greedily from the start", () => {
  const small = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
  const out = segments(req({ messages: [small("one"), small("two")] }));
  expect(out).toEqual(["[user]\none\n\n[user]\ntwo"]);
});

test("an empty request yields no segments", () => {
  expect(segments(req({}))).toEqual([]);
  expect(
    segments(
      req({
        system: [],
        tools: [],
        messages: [
          { role: "user", content: [] },
          { role: "user", content: [{ type: "text", text: "" }] },
        ],
      }),
    ),
  ).toEqual([]);
});

test("a portable tool's input schema is judged", () => {
  const out = segments(
    req({
      tools: [
        {
          kind: "portable",
          name: "t",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "MARK-schema-prop" } },
          },
        },
      ],
    }),
  );
  expect(containing(out, "MARK-schema-prop")).toBe(true);
});

test("a portable tool's options are judged", () => {
  const out = segments(
    req({
      tools: [
        {
          kind: "portable",
          name: "t",
          inputSchema: {},
          options: { input_examples: [{ path: "MARK-option-example" }] },
        },
      ],
    }),
  );
  expect(containing(out, "MARK-option-example")).toBe(true);
});

test("a provider tool's wire is judged", () => {
  const out = segments(
    req({
      tools: [
        {
          kind: "provider",
          provider: "anthropic",
          type: "web_search_20250305",
          name: "web_search",
          wire: { user_location: { city: "MARK-wire-city" } },
        },
      ],
    }),
  );
  expect(containing(out, "MARK-wire-city")).toBe(true);
});

test("a text block's citations are judged, in messages and in system", () => {
  const citations = [{ type: "char_location", cited_text: "MARK-citation" }];
  const inMessage = segments(
    req({ messages: [{ role: "user", content: [{ type: "text", text: "hi", citations }] }] }),
  );
  expect(containing(inMessage, "MARK-citation")).toBe(true);
  const inSystem = segments(req({ system: [{ type: "text", text: "sys", citations }] }));
  expect(containing(inSystem, "MARK-citation")).toBe(true);
});

test("empty citations add nothing", () => {
  const out = segments(
    req({ messages: [{ role: "user", content: [{ type: "text", text: "hi", citations: [] }] }] }),
  );
  expect(out).toEqual(["[user]\nhi"]);
});
