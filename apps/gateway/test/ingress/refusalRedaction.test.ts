import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

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
