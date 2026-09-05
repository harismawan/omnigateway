import { describe, expect, test } from "bun:test";
import { type ChatRequest, promptTokens, type StreamEvent } from "@omni/ir";
import { buildToolCloak } from "../src/antigravity/cloak.ts";
import { decodeAntigravityStream } from "../src/antigravity/decode.ts";
import type { SseMessage } from "../src/sse.ts";

async function* frames(...payloads: unknown[]): AsyncGenerator<SseMessage> {
  for (const payload of payloads) {
    yield {
      event: "message",
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    };
  }
}

async function collect(source: AsyncGenerator<SseMessage>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of decodeAntigravityStream(source)) out.push(event);
  return out;
}

const usage = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  // Nonzero on purpose: a fixture without reasoning tokens cannot show whether
  // they are counted, and most of this provider's catalog thinks.
  thoughtsTokenCount: 15,
  cachedContentTokenCount: 30,
};

function text(t: string, extra: Record<string, unknown> = {}) {
  return { response: { candidates: [{ content: { parts: [{ text: t }] } }], ...extra } };
}

describe("text and completion", () => {
  test("streams one text block and ends", async () => {
    const events = await collect(
      frames(
        { response: { responseId: "r1", modelVersion: "gemini-3.6-flash-high", candidates: [] } },
        text("hel"),
        text("lo"),
        { response: { candidates: [{ finishReason: "STOP" }], usageMetadata: usage } },
      ),
    );

    expect(events[0]).toEqual({ type: "start", id: "r1", model: "gemini-3.6-flash-high" });
    expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
    expect(events[2]).toEqual({
      type: "blockDelta",
      index: 0,
      delta: { type: "text", text: "hel" },
    });
    expect(events[3]).toEqual({
      type: "blockDelta",
      index: 0,
      delta: { type: "text", text: "lo" },
    });
    expect(events[4]).toEqual({ type: "blockEnd", index: 0 });

    const end = events[5];
    expect(end?.type).toBe("end");
    if (end?.type !== "end") throw new Error("expected end");
    expect(end.stopReason).toBe("endTurn");
    // 100 prompt tokens of which 30 were cache reads: input is the uncached 70,
    // and billing the 30 twice is exactly what this arithmetic prevents.
    expect(end.usage.inputTokens).toBe(70);
    expect(end.usage.cacheReadTokens).toBe(30);
    // Reasoning tokens are counted *beside* the candidate tokens, not inside
    // them: 20 + 15. Reading only `candidatesTokenCount` undercounts output on
    // every thinking request, which is what the logs, the token limits and any
    // operator-set price all read.
    expect(end.usage.outputTokens).toBe(35);
  });

  test("a thought part opens a thinking block, not a text one", async () => {
    const events = await collect(
      frames(
        { response: { candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] } },
        text("answer"),
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ),
    );
    expect(events.filter((e) => e.type === "blockStart")).toEqual([
      { type: "blockStart", index: 0, block: { type: "thinking" } },
      { type: "blockStart", index: 1, block: { type: "text" } },
    ]);
  });

  test("MAX_TOKENS is not folded into endTurn", async () => {
    const events = await collect(
      frames(text("x"), { response: { candidates: [{ finishReason: "MAX_TOKENS" }] } }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.stopReason).toBe("maxTokens");
  });

  test("an unrecognized finish reason fails visibly", async () => {
    const events = await collect(
      frames(text("x"), { response: { candidates: [{ finishReason: "WHAT_IS_THIS" }] } }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.message).toContain("WHAT_IS_THIS");
  });

  test("a stream that stops before a finish reason is an error", async () => {
    const events = await collect(frames(text("x")));
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.message).toContain("before");
  });
});

describe("tool calls", () => {
  test("a functionCall part becomes a complete toolUse block", async () => {
    const events = await collect(
      frames(
        {
          response: {
            candidates: [
              { content: { parts: [{ functionCall: { name: "Read", args: { path: "/a" } } }] } },
            ],
          },
        },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ),
    );

    expect(events[1]).toEqual({
      type: "blockStart",
      index: 0,
      block: { type: "toolUse", id: "fc_0", name: "Read" },
    });
    expect(events[2]).toEqual({
      type: "blockDelta",
      index: 0,
      delta: { type: "toolJson", partial: JSON.stringify({ path: "/a" }) },
    });
    expect(events[3]).toEqual({ type: "blockEnd", index: 0 });

    const end = events.at(-1);
    // A tool call outranks the candidate's own STOP: the turn is not over.
    expect(end?.type === "end" && end.stopReason).toBe("toolUse");
  });

  test("an id supplied upstream is preferred over a minted one", async () => {
    const events = await collect(
      frames(
        {
          response: {
            candidates: [
              { content: { parts: [{ functionCall: { id: "up-1", name: "Read", args: {} } }] } },
            ],
          },
        },
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ),
    );
    expect(events[1]).toEqual({
      type: "blockStart",
      index: 0,
      block: { type: "toolUse", id: "up-1", name: "Read" },
    });
  });
});

describe("errors", () => {
  test("an error frame ends the stream with its code", async () => {
    const events = await collect(
      frames({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "slow down" } }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.code).toBe("RATE_LIMIT");
  });

  test("a malformed function call is a bad request, not a silent stop", async () => {
    const events = await collect(
      frames({ response: { candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL" }] } }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.code).toBe("BAD_REQUEST");
  });

  test("an error wrapped under response is classified, not flattened to UPSTREAM", async () => {
    // Cloud Code puts an error here as often as at the top level. Reading only
    // the top level turned a real rate limit into a generic retryable failure
    // the breaker never recognised — and a wrapped UNAUTHENTICATED never
    // reached the credential-refresh path.
    const events = await collect(
      frames({ response: { error: { status: "RESOURCE_EXHAUSTED", message: "quota exhausted" } } }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.code).toBe("RATE_LIMIT");
  });

  test("a wrapped auth failure reaches the code dispatch retries on", async () => {
    const events = await collect(
      frames({ response: { error: { status: "UNAUTHENTICATED", message: "expired" } } }),
    );
    const last = events.at(-1);
    expect(last?.type === "error" && last.code).toBe("AUTH");
  });

  test("a prompt blocked before generation is a filtered turn, not a truncated stream", async () => {
    const events = await collect(
      frames({
        response: {
          promptFeedback: { blockReason: "SAFETY" },
          usageMetadata: { promptTokenCount: 12 },
        },
      }),
    );
    const last = events.at(-1);
    // Reporting "stream ended before the response finished" here sends the
    // client looking for a network fault instead of at its own prompt.
    expect(last?.type).toBe("end");
    expect(last?.type === "end" && last.stopReason).toBe("contentFilter");
    expect(last?.type === "end" && last.usage.inputTokens).toBe(12);
  });

  test("a frame carrying two candidates fails visibly rather than losing one", async () => {
    const events = await collect(
      frames({
        response: {
          candidates: [
            { content: { parts: [{ text: "a" }] } },
            { content: { parts: [{ text: "b" }] }, finishReason: "STOP" },
          ],
        },
      }),
    );
    const last = events.at(-1);
    // Keeping candidate 0 silently would drop candidate 1's content *and* its
    // finish reason, so the turn would then read as a stream that stopped early.
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.message).toContain("2 candidates");
  });

  test("SAFETY becomes the content filter stop reason", async () => {
    const events = await collect(
      frames(text("x"), { response: { candidates: [{ finishReason: "SAFETY" }] } }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.stopReason).toBe("contentFilter");
  });
});

describe("the tool cloak on the way back", () => {
  /** One frame carrying a single function call under `name`. */
  const callFrame = (name: string) => ({
    response: { candidates: [{ content: { parts: [{ functionCall: { name, args: {} } }] } }] },
  });

  test("a cloaked name is restored to the client's own", async () => {
    const request: ChatRequest = {
      model: "m",
      stream: true,
      messages: [],
      tools: [{ kind: "portable", name: "has space", description: "d", inputSchema: {} }],
    };
    const cloak = buildToolCloak(request);
    const out: StreamEvent[] = [];
    for await (const event of decodeAntigravityStream(frames(callFrame("has_space")), { cloak })) {
      out.push(event);
    }
    const start = out.find((e) => e.type === "blockStart");
    expect(start).toMatchObject({ block: { type: "toolUse", name: "has space" } });
  });

  test("without a cloak the upstream's name is passed through untouched", async () => {
    // The positive control: a decoder that rewrote names unconditionally would
    // satisfy the test above and corrupt every ordinary tool call.
    const out: StreamEvent[] = [];
    for await (const event of decodeAntigravityStream(frames(callFrame("Read")))) out.push(event);
    expect(out.find((e) => e.type === "blockStart")).toMatchObject({
      block: { type: "toolUse", name: "Read" },
    });
  });

  test("a name the cloak never saw is left alone", async () => {
    const cloak = buildToolCloak({
      model: "m",
      stream: true,
      messages: [],
      tools: [{ kind: "portable", name: "has space", description: "d", inputSchema: {} }],
    });
    const out: StreamEvent[] = [];
    for await (const event of decodeAntigravityStream(frames(callFrame("Unrelated")), { cloak })) {
      out.push(event);
    }
    expect(out.find((e) => e.type === "blockStart")).toMatchObject({
      block: { type: "toolUse", name: "Unrelated" },
    });
  });
});

describe("the implicit prompt cache", () => {
  /**
   * A frame carrying the exact counts one live cache hit reported.
   *
   * Measured 2026-09-05 on `gemini-3.8-flash-high`: the same 61,244-token
   * prefix asked a new question, answered `cachedContentTokenCount: 57309`.
   * Synthetic round numbers cannot show that `cachedContentTokenCount` is
   * counted **inside** `promptTokenCount` rather than beside it — a real pair
   * can, because 57,309 exceeds any plausible standalone input for a prompt of
   * that size.
   */
  const hit = {
    response: {
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 61_244,
        candidatesTokenCount: 12,
        cachedContentTokenCount: 57_309,
      },
    },
  };

  test("a cache read is subtracted from input rather than billed twice", async () => {
    const out: StreamEvent[] = [];
    for await (const event of decodeAntigravityStream(frames(hit))) out.push(event);
    const end = out.find((e) => e.type === "end");
    expect(end?.type === "end" && end.usage).toEqual({
      // 61,244 − 57,309. Leaving the cached tokens in `inputTokens` would bill
      // them at the input rate and again at the cache rate.
      inputTokens: 3_935,
      outputTokens: 12,
      cacheReadTokens: 57_309,
      // **Always zero, and measured so**: Google bills implicit-cache storage
      // by the hour and reports no per-write token count at all, which is why
      // the catalog's `cacheWrite5m`/`cacheWrite1h` are a real zero.
      cacheWriteTokens: 0,
    });
  });

  test("the whole prompt is still recoverable for a client that reports one number", async () => {
    const out: StreamEvent[] = [];
    for await (const event of decodeAntigravityStream(frames(hit))) out.push(event);
    const end = out.find((e) => e.type === "end");
    expect(end?.type === "end" && promptTokens(end.usage)).toBe(61_244);
  });
});
