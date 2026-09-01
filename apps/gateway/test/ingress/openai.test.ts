import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

const minimal = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };

test("parses a minimal chat completions request", () => {
  const req = parseOpenAIRequest(minimal);
  expect(req.model).toBe("gpt-5");
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("reads the client's own end-user id as the conversation", () => {
  // `user` is this surface's nearest equivalent to Anthropic's
  // `metadata.user_id`, and it was dropped by the same mechanism: named in
  // KNOWN, absent from the schema, read nowhere.
  expect(parseOpenAIRequest({ ...minimal, user: "u-42" }).conversationId).toBe("u-42");
  expect(parseOpenAIRequest(minimal).conversationId).toBeUndefined();
  expect(parseOpenAIRequest({ ...minimal, user: "" }).conversationId).toBeUndefined();
});

test("lifts system and developer messages out of the message list", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "system", content: "be terse" },
      { role: "developer", content: "and precise" },
      { role: "user", content: "hi" },
    ],
  });
  expect(req.system).toEqual([
    { type: "text", text: "be terse" },
    { type: "text", text: "and precise" },
  ]);
  expect(req.messages).toHaveLength(1);
});

test("parses multi-part content with image urls", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "image", mediaType: "image/png", data: "AAAA" },
  ]);
});

test("rejects a non-data image url rather than fetching it", () => {
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    }),
  ).toThrow(GatewayError);
});

// Real one-pixel encodings. A made-up payload would sniff as nothing and prove
// only that the error path works.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";

test("reads bare base64 images from the Ollama-shaped images field", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [{ role: "user", content: "analyze this", images: [PNG, JPEG] }],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "analyze this" },
    { type: "image", mediaType: "image/png", data: PNG },
    { type: "image", mediaType: "image/jpeg", data: JPEG },
  ]);
});

test("reads data-url attachments and the experimental spelling, images first", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: "compare",
        images: [PNG],
        attachments: [
          { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", mediaType: "image/gif" },
        ],
        experimental_attachments: [
          { url: "data:image/webp;base64,UklGRhoAAABXRUJQ", contentType: "image/webp" },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "compare" },
    { type: "image", mediaType: "image/png", data: PNG },
    { type: "image", mediaType: "image/gif", data: "R0lGODlhAQABAAAAACw=" },
    { type: "image", mediaType: "image/webp", data: "UklGRhoAAABXRUJQ" },
  ]);
});

test("the payload's own type beats the one the attachment declared", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "user", content: "x", attachments: [{ url: PNG, mediaType: "image/jpeg" }] },
    ],
  });
  expect(req.messages[0]?.content[1]).toEqual({
    type: "image",
    mediaType: "image/png",
    data: PNG,
  });
});

test("sniffs a bare GIF and WebP payload without a data url to declare them", () => {
  // Wrapping these in `data:image/gif;base64,` would read the type off the URL
  // and never reach the magic-prefix table, so a typo in it would go unnoticed.
  const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const WEBP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [{ role: "user", content: "x", images: [GIF, WEBP] }],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "x" },
    { type: "image", mediaType: "image/gif", data: GIF },
    { type: "image", mediaType: "image/webp", data: WEBP },
  ]);
});

test("drops a remote attachment url rather than fetching it or refusing the request", () => {
  // The declared type is deliberately valid: without the scheme check this URL
  // would become an image block whose base64 payload is the URL text.
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: "x",
        attachments: [{ url: "https://example.com/a.png", mediaType: "image/png" }],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([{ type: "text", text: "x" }]);
});

test("drops an attachment that is not an image and keeps the rest of the turn", () => {
  // `attachments` is the SDK's general file envelope, so a PDF in it is
  // ordinary. It was dropped before the gateway read the field; refusing the
  // whole request now would break a caller that worked yesterday.
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: "summarize",
        attachments: [
          { url: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf" },
          { url: `data:image/png;base64,${PNG}`, mediaType: "image/png" },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "summarize" },
    { type: "image", mediaType: "image/png", data: PNG },
  ]);
});

test("drops an attachment whose data url carries no base64 content", () => {
  // The declared type is valid on purpose. Without the data-URL check the URL
  // text itself would be forwarded as the base64 payload of an `image/png`
  // block, and a fixture with no declared type would be dropped by the sniff
  // instead — passing while proving nothing.
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: "x",
        attachments: [{ url: "data:image/png,notbase64", mediaType: "image/png" }],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([{ type: "text", text: "x" }]);
});

test("refuses an unrecognized payload in the images-only field", () => {
  // No second copy of it exists in the message, so dropping would send the
  // model a question about a picture it cannot see.
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      messages: [{ role: "user", content: "x", images: ["AAAA"] }],
    }),
  ).toThrow(GatewayError);
});

test("refuses a remote url in the images-only field", () => {
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      messages: [{ role: "user", content: "x", images: ["https://example.com/a.png"] }],
    }),
  ).toThrow(/does not fetch remote images/);
});

test("refuses the images-only field on a message role that cannot carry it", () => {
  for (const role of ["system", "tool"]) {
    expect(() =>
      parseOpenAIRequest({
        ...minimal,
        messages: [
          { role, content: "x", tool_call_id: "t1", images: [PNG] },
          { role: "user", content: "hi" },
        ],
      }),
    ).toThrow(GatewayError);
  }
});

test("ignores attachments on a role that cannot carry them, as before the field was read", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "system",
        content: "be terse",
        attachments: [{ url: `data:image/png;base64,${PNG}` }],
      },
      { role: "user", content: "hi" },
    ],
  });
  expect(req.system).toEqual([{ type: "text", text: "be terse" }]);
  expect(req.messages).toHaveLength(1);
});

test("parses assistant tool calls and tool result messages", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "c1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]).toEqual({
    role: "user",
    content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }],
  });
});

test("tolerates malformed tool call arguments", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{oops" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({ type: "toolUse", input: {} });
});

test("parses tools and the required tool choice", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "required",
  });
  expect(req.tools).toEqual([{ kind: "portable", name: "f", inputSchema: { type: "object" } }]);
  expect(req.toolChoice).toEqual({ type: "any" });
});

test("rejects a non-object tool parameters", () => {
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      tools: [{ type: "function", function: { name: "f", parameters: 42 } }],
    }),
  ).toThrow(GatewayError);
});

test("parses a named tool choice", () => {
  expect(
    parseOpenAIRequest({ ...minimal, tool_choice: { type: "function", function: { name: "f" } } })
      .toolChoice,
  ).toEqual({ type: "tool", name: "f" });
});

test("maps reasoning_effort onto the reasoning config", () => {
  expect(parseOpenAIRequest({ ...minimal, reasoning_effort: "high" }).reasoning).toEqual({
    mode: "adaptive",
    effort: "high",
  });
});

test("deep efforts cross unclamped, matching what the egress forwards", () => {
  for (const effort of ["none", "minimal", "xhigh", "max"] as const) {
    expect(parseOpenAIRequest({ ...minimal, reasoning_effort: effort }).reasoning).toEqual({
      mode: "adaptive",
      effort,
    });
  }
});

test("rejects an effort level outside the published ladder", () => {
  expect(() => parseOpenAIRequest({ ...minimal, reasoning_effort: "turbo" })).toThrow(GatewayError);
});

test("accepts both max_tokens and max_completion_tokens", () => {
  expect(parseOpenAIRequest({ ...minimal, max_tokens: 100 }).maxTokens).toBe(100);
  expect(parseOpenAIRequest({ ...minimal, max_completion_tokens: 200 }).maxTokens).toBe(200);
});

test("normalises a string stop value to an array", () => {
  expect(parseOpenAIRequest({ ...minimal, stop: "END" }).stopSequences).toEqual(["END"]);
});

test("passes unknown fields through as vendor extras", () => {
  expect(parseOpenAIRequest({ ...minimal, top_p: 0.5 }).vendor?.openai).toEqual({ top_p: 0.5 });
});

test("rejects a request with no messages", () => {
  expect(() => parseOpenAIRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a request that is only a system message", () => {
  expect(() =>
    parseOpenAIRequest({ ...minimal, messages: [{ role: "system", content: "x" }] }),
  ).toThrow(GatewayError);
});

// Cache breakpoints. This surface has two spellings — on a content part, and
// on the message itself — because OpenAI-shaped clients send both. Neither
// reaches an OpenAI upstream, which caches on its own, but a request routed to
// Anthropic loses every breakpoint if ingress drops them here.

test("keeps a cache breakpoint on a content part", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: "volatile" },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "stable", cacheControl: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: "volatile" },
  ]);
});

test("moves a message-level breakpoint onto the last content block", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  // Anthropic rejects a marker on the message object, so the only faithful
  // reading of "cache through here" is the last block of the message.
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "one" },
    { type: "text", text: "two", cacheControl: { type: "ephemeral" } },
  ]);
});

test("lets a part-level breakpoint win over the message-level one", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "one", cache_control: { type: "ephemeral", ttl: "1h" } }],
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "one", cacheControl: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("marks a string message's only block", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral" } }],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "hi", cacheControl: { type: "ephemeral" } },
  ]);
});

test("keeps a breakpoint on a hoisted system message", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "system", content: "be terse", cache_control: { type: "ephemeral", ttl: "1h" } },
      { role: "user", content: "hi" },
    ],
  });
  expect(req.system).toEqual([
    { type: "text", text: "be terse", cacheControl: { type: "ephemeral", ttl: "1h" } },
  ]);
});

test("applies a system message-level breakpoint to that message's last block only", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        cache_control: { type: "ephemeral" },
      },
      { role: "developer", content: "c" },
      { role: "user", content: "hi" },
    ],
  });
  // The marker belongs to the message that carried it, not to whatever block
  // happens to end up last after later system messages are appended.
  expect(req.system).toEqual([
    { type: "text", text: "a" },
    { type: "text", text: "b", cacheControl: { type: "ephemeral" } },
    { type: "text", text: "c" },
  ]);
});

test("keeps a breakpoint on a tool result message", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "t",
        content: "ok",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "t",
    content: "ok",
    isError: false,
    cacheControl: { type: "ephemeral" },
  });
});

test("marks a trailing tool call when the message carried the breakpoint", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "calling",
        tool_calls: [{ id: "t", type: "function", function: { name: "f", arguments: '{"a":1}' } }],
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  expect(req.messages[1]?.content).toEqual([
    { type: "text", text: "calling" },
    { type: "toolUse", id: "t", name: "f", input: { a: 1 }, cacheControl: { type: "ephemeral" } },
  ]);
});

test("keeps a breakpoint on a tool definition, at either level", () => {
  const outer = parseOpenAIRequest({
    ...minimal,
    tools: [
      {
        type: "function",
        function: { name: "f", parameters: { type: "object" } },
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
  });
  expect(outer.tools).toEqual([
    {
      kind: "portable",
      name: "f",
      inputSchema: { type: "object" },
      cacheControl: { type: "ephemeral", ttl: "1h" },
    },
  ]);

  // Some clients put it inside `function` instead; the outer one wins.
  const inner = parseOpenAIRequest({
    ...minimal,
    tools: [
      {
        type: "function",
        function: {
          name: "f",
          parameters: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      },
    ],
  });
  expect(inner.tools).toEqual([
    {
      kind: "portable",
      name: "f",
      inputSchema: { type: "object" },
      cacheControl: { type: "ephemeral" },
    },
  ]);
});

test("ignores a cache control shape it cannot translate rather than refusing", () => {
  // This surface has no `cache_control` of its own; carrying one is a
  // best-effort translation for a request that may reach an Anthropic target.
  // Before it was read at all the field was dropped and the request
  // succeeded, so refusing now would break callers that worked yesterday and
  // would make the gateway the thing that has to ship before a client can use
  // a TTL the provider added.
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [{ role: "user", content: "hi", cache_control: { type: "persistent" } }],
  });
  expect(req.messages[0]?.content).toEqual([{ type: "text", text: "hi" }]);

  const unknownTtl = parseOpenAIRequest({
    ...minimal,
    messages: [{ role: "user", content: "hi", cache_control: { type: "ephemeral", ttl: "2h" } }],
  });
  // Not downgraded to a bare marker: a TTL this gateway cannot express is not
  // the same request as one with no TTL at all.
  expect(unknownTtl.messages[0]?.content).toEqual([{ type: "text", text: "hi" }]);
});

test("a malformed marker at one tool level does not mask a good one at the other", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    tools: [
      {
        type: "function",
        function: {
          name: "f",
          parameters: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        // `??` only falls through on null/undefined, so reading the outer
        // level loosely would let garbage here swallow the valid inner marker
        // and drop both.
        cache_control: { type: "persistent" },
      },
    ],
  });
  expect(req.tools).toEqual([
    {
      kind: "portable",
      name: "f",
      inputSchema: { type: "object" },
      cacheControl: { type: "ephemeral", ttl: "1h" },
    },
  ]);
});

test("still refuses a malformed cache control on the anthropic surface", () => {
  // Anthropic would reject it too, and there the field is part of the
  // contract rather than a translation.
  expect(() =>
    parseAnthropicRequest({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "a", cache_control: { type: "persistent" } }],
    }),
  ).toThrow(GatewayError);
});
