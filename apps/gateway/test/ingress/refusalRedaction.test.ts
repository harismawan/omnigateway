import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";
import { safeToken } from "../../src/ingress/schemas.ts";

/**
 * What a refusal may say about the request that caused it.
 *
 * `reasonField` prints an error's message to stdout whenever the error names no
 * provider, and every refusal a parser throws is one — so an interpolated value
 * is not a formatting choice, it is a decision about the redaction boundary
 * `LogFields` exists to be. The rule the allowlist already states for tool
 * names, in the comment on `cloakedTools`, is the rule here: client-supplied
 * free text can hold anything a caller decided to put in it, and stdout is not
 * where it belongs.
 *
 * The value is worth *naming* — a client cannot fix a field it is not told
 * about — so these are bounded rather than removed: a short token of a known
 * charset survives, and anything else is reported as unprintable.
 */
const MARKER = "REDACTION_MARKER";
const HOSTILE = `${MARKER}\n${"x".repeat(4000)}`;

function refusal(body: unknown, parse = parseAnthropicRequest): string {
  try {
    parse(body);
  } catch (error) {
    return error instanceof GatewayError ? error.message : String(error);
  }
  throw new Error("expected the request to be refused");
}

const base = {
  model: "claude-sonnet-4",
  max_tokens: 100,
};

test("an unrecognized block type is named, but only if it is a short plain token", () => {
  const short = refusal({
    ...base,
    messages: [{ role: "user", content: [{ type: "wobble", text: "hi" }] }],
  });
  expect(short).toContain("wobble");

  const hostile = refusal({
    ...base,
    messages: [{ role: "user", content: [{ type: HOSTILE, text: "hi" }] }],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("an unrecognized tool type is named on the same terms", () => {
  const short = refusal({
    ...base,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "wobble_20990101", name: "wobble" }],
  });
  expect(short).toContain("wobble_20990101");

  const hostile = refusal({
    ...base,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: HOSTILE, name: "wobble" }],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("a sidecar image's declared media type is bounded before it is quoted", () => {
  // `parseDataUrl` takes everything before `;base64,` as the media type, and
  // `[^;,]+` admits newlines and any length — so this is client text reaching a
  // refusal by a quieter route than the two above. The `images` sidecar is the
  // OpenAI surface's, which is why this one is parsed there.
  const hostile = refusal(
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi", images: [`data:${HOSTILE};base64,AAAA`] }],
    },
    parseOpenAIRequest,
  );
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("an unknown key on a custom tool is bounded in the message and in the path", () => {
  // Two channels, and bounding the message alone misses one: the key is spliced
  // into the field path as well, which is the half a `safeToken` on the message
  // body does nothing about.
  const hostile = refusal({
    ...base,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", input_schema: { type: "object" }, [HOSTILE]: 1 }],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("an unknown key on a provider-defined tool is bounded on both channels", () => {
  const hostile = refusal({
    ...base,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "web_search_20250305", name: "web_search", [HOSTILE]: 1 }],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("an unknown key inside a native block is bounded, message and path alike", () => {
  // Zod's `unrecognized_keys` message quotes the offending key verbatim, and
  // the key is also hand-spliced into the path here — the arm the other zod
  // codes do not have, since v4 does not echo received values for enums.
  const hostile = refusal({
    ...base,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: {}, [HOSTILE]: 1 },
        ],
      },
    ],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("an unknown mcp server name is bounded", () => {
  const hostile = refusal({
    ...base,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: HOSTILE }],
  });
  expect(hostile).not.toContain(MARKER);
  expect(hostile.length).toBeLessThan(200);
});

test("a real Anthropic tool type is still readable, dated variants included", () => {
  // The bound exists to keep client text off stdout, not to make the gateway
  // unhelpful: every type Anthropic actually defines has to survive it, and the
  // longest of them plus a date is what sets the limit.
  const long = "text_editor_code_execution_tool_result_20250728";
  expect(long.length).toBeGreaterThan(40);
  expect(safeToken(long)).toBe(long);
  expect(safeToken("image/png")).toBe("image/png");
  expect(safeToken("mcp__server__tool")).toBe("mcp__server__tool");
});

test("a refused model name is bounded before the refusal quotes it", () => {
  // The allowlist refusal is an `AUTH` error naming no provider, so it prints
  // like the rest. `model` is `z.string().min(1)` with no upper bound, and the
  // gateway echoes it to say which one was refused.
  expect(safeToken(`${MARKER}${"x".repeat(4000)}`)).toBe("(unprintable)");
  expect(safeToken("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  // Prefixed and pooled spellings both survive. `[1m]` does not appear here
  // because `normalizeClientModel` strips it before the allowlist is consulted,
  // which is why the value reaching this refusal never carries brackets.
  expect(safeToken("anthropic/claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
});

/**
 * The sweep, kept as an instrument rather than a list.
 *
 * Every round of review on this found sites the previous round missed — two,
 * then three, then seven — because each was a hand-written enumeration of where
 * client text reaches a refusal, and that is exactly the thing a list is bad at.
 * This drives a marker through the positions instead, so a new interpolation is
 * caught by a test nobody has to remember to extend.
 */
const POSITIONS: ReadonlyArray<{ what: string; body: (hostile: string) => unknown }> = [
  {
    what: "block type",
    body: (h) => ({ ...base, messages: [{ role: "user", content: [{ type: h, text: "x" }] }] }),
  },
  {
    what: "tool type",
    body: (h) => ({ ...base, messages: [{ role: "user", content: "hi" }], tools: [{ type: h }] }),
  },
  {
    what: "custom tool key",
    body: (h) => ({
      ...base,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "t", description: "d", input_schema: { type: "object" }, [h]: 1 }],
    }),
  },
  {
    what: "provider tool key",
    body: (h) => ({
      ...base,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "web_search_20250305", name: "web_search", [h]: 1 }],
    }),
  },
  {
    what: "native block key",
    body: (h) => ({
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: {}, [h]: 1 }],
        },
      ],
    }),
  },
  {
    what: "mcp server name",
    body: (h) => ({
      ...base,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "mcp_toolset", mcp_server_name: h }],
    }),
  },
];

for (const { what, body } of POSITIONS) {
  test(`hostile text in the ${what} never reaches the refusal`, () => {
    const message = refusal(body(HOSTILE));
    expect(message).not.toContain(MARKER);
    expect(message.length).toBeLessThan(200);
  });
}
