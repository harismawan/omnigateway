import { expect, test } from "bun:test";
import type { ChatRequest, Message } from "@omni/ir";
import { threadIdFrom } from "../src/openai/codexIdentity.ts";
import { toResponsesWire } from "../src/openai/wire.ts";

/**
 * The cache-affinity key, which is the whole of why OpenAI targets read from
 * the prompt cache at all.
 *
 * Measured before any of this existed: `request_logs` held 2 cache reads in 21
 * OpenAI requests, and byte-identical probes 75s apart read back 0 of 5 times
 * without a session id against 14 of 15 with one. Every property below is a way
 * the key stops being stable across a conversation, and each of them returns
 * the installation to that number silently — the request still succeeds, it is
 * only billed at full input price.
 */

const base: ChatRequest = {
  model: "smart",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  system: [{ type: "text", text: "be brief" }],
  stream: true,
};

const keyOf = (req: ChatRequest): string => toResponsesWire(req, "gpt-5").cacheKey;

/** One more round trip appended, the way a conversation actually grows. */
function withTurns(req: ChatRequest, count: number): ChatRequest {
  const extra: Message[] = [];
  for (let i = 0; i < count; i++) {
    extra.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
    extra.push({ role: "user", content: [{ type: "text", text: `follow up ${i}` }] });
  }
  return { ...req, messages: [...req.messages, ...extra] };
}

/**
 * Codex's thread id is a UUIDv7, and the key is that id: version 7, the RFC
 * variant, and a timestamp that is never in the future.
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const instantOf = (uuid: string): number =>
  Number.parseInt(uuid.replace(/-/g, "").slice(0, 12), 16);

/** A Codex client's own thread id. */
const CODEX_THREAD = "01a143df-3401-73a0-96db-901f105e1409";

const keyFor = (vendor: Record<string, unknown>): string =>
  keyOf({ ...base, vendor: { openai: vendor } });

test("a client's own key that is already a UUID is used verbatim, and matches the body", () => {
  const req: ChatRequest = { ...base, vendor: { openai: { prompt_cache_key: CODEX_THREAD } } };
  const { body, cacheKey } = toResponsesWire(req, "gpt-5");

  expect(cacheKey).toBe(CODEX_THREAD);
  // Resolved before the vendor merge for this reason: the merge writes the
  // caller's value into the body last, so a key resolved after it would send
  // one name in the header and another in the body.
  expect(body.prompt_cache_key).toBe(CODEX_THREAD);
});

test("any other client key is hashed into the UUID form, stably and without leaking it", () => {
  const key = keyFor({ prompt_cache_key: "chosen-by-caller" });
  expect(key).toMatch(UUID_V7);
  expect(key).not.toContain("chosen");
  expect(keyFor({ prompt_cache_key: "chosen-by-caller" })).toBe(key);
  expect(keyFor({ prompt_cache_key: "chosen-by-another" })).not.toBe(key);
  const { body, cacheKey } = toResponsesWire(
    { ...base, vendor: { openai: { prompt_cache_key: "chosen-by-caller" } } },
    "gpt-5",
  );
  expect(body.prompt_cache_key).toBe(cacheKey);
});

test("every derived key is a UUIDv7 whose instant is in the past", () => {
  const now = Date.now();
  for (const key of [
    keyOf(base),
    keyOf({ ...base, conversationId: "conv-a" }),
    keyFor({ prompt_cache_key: "chosen-by-caller" }),
    keyFor({ session_id: "sess-77" }),
  ]) {
    expect(key).toMatch(UUID_V7);
    expect(instantOf(key)).toBeLessThanOrEqual(now);
    expect(instantOf(key)).toBeGreaterThan(Date.UTC(2025, 0, 1));
  }
});

test("session_id is the second name a client may use for the same thing", () => {
  expect(keyFor({ session_id: "sess-77" })).toBe(keyFor({ prompt_cache_key: "sess-77" }));
  expect(keyFor({ session_id: "sess-77" })).not.toBe(keyOf(base));
  expect(keyFor({ session_id: CODEX_THREAD })).toBe(CODEX_THREAD);
});

test("prompt_cache_key wins over session_id when a client sends both", () => {
  expect(keyFor({ session_id: "sess-77", prompt_cache_key: "pck-1" })).toBe(
    keyFor({ prompt_cache_key: "pck-1" }),
  );
  expect(keyFor({ session_id: "sess-77", prompt_cache_key: "pck-1" })).not.toBe(
    keyFor({ session_id: "sess-77" }),
  );
});

test("a client key beats the conversation id", () => {
  const withBoth = keyOf({
    ...base,
    conversationId: "conv-a",
    vendor: { openai: { prompt_cache_key: "pck-1" } },
  });
  expect(withBoth).toBe(keyFor({ prompt_cache_key: "pck-1" }));
});

test("an empty or non-string client key falls through rather than being sent", () => {
  // An empty session id is not a session id. Sending it would put every
  // conversation on this installation into one partition, which is worse than
  // the derived key it displaced.
  //
  // Asserted on the **body**, not only on the returned key. The vendor bag is
  // merged onto the body verbatim, so a version of this that checked the return
  // value alone passed while the merge wrote the rejected value straight back
  // into `prompt_cache_key`, disagreeing with the session headers on the wire.
  for (const rejected of [{ prompt_cache_key: "" }, { session_id: 42 }, { prompt_cache_key: 7 }]) {
    const { body, cacheKey } = toResponsesWire({ ...base, vendor: { openai: rejected } }, "gpt-5");
    expect(cacheKey).toBe(keyOf(base));
    expect(body.prompt_cache_key).toBe(cacheKey);
  }
});

test("header-unsafe client keys fall through each candidate without changing body affinity", () => {
  for (const value of [
    "bad\r\nx-injected: yes",
    "日本語",
    "has space",
    "\t",
    "\x7f",
    "x".repeat(1025),
  ]) {
    for (const name of ["prompt_cache_key", "session_id"] as const) {
      const { body, cacheKey } = toResponsesWire(
        { ...base, vendor: { openai: { [name]: value } } },
        "gpt-5",
      );
      expect(cacheKey).toBe(keyOf(base));
      expect(body.prompt_cache_key).toBe(cacheKey);
    }
    expect(
      keyOf({ ...base, vendor: { openai: { prompt_cache_key: value, session_id: "safe" } } }),
    ).toBe(keyFor({ session_id: "safe" }));
    const conversation = { ...base, conversationId: "conversation" };
    expect(
      keyOf({
        ...conversation,
        vendor: { openai: { prompt_cache_key: value, session_id: value } },
      }),
    ).toBe(keyOf(conversation));
  }
  // At the length budget it is still the client's key, hashed like any other.
  const value = "x".repeat(1024);
  expect(keyFor({ prompt_cache_key: value })).not.toBe(keyOf(base));
  expect(keyFor({ prompt_cache_key: value })).toBe(keyFor({ session_id: value }));
});

test("a client's own key survives the vendor merge rather than being overwritten by it", () => {
  // The other direction of the same ordering. The resolved key is written after
  // the merge, so this proves the write is not simply clobbering whatever the
  // client asked for.
  const req: ChatRequest = { ...base, vendor: { openai: { prompt_cache_key: CODEX_THREAD } } };
  const { body, cacheKey } = toResponsesWire(req, "gpt-5");
  expect(cacheKey).toBe(CODEX_THREAD);
  expect(body.prompt_cache_key).toBe(CODEX_THREAD);
});

test("other vendor fields still ride the merge untouched", () => {
  // The fix reorders the merge, so this pins that reordering did not cost the
  // passthrough the merge exists for.
  const req: ChatRequest = { ...base, vendor: { openai: { service_tier: "priority" } } };
  const { body } = toResponsesWire(req, "gpt-5");
  expect(body.service_tier).toBe("priority");
  expect(body.prompt_cache_key).toMatch(UUID_V7);
});

test("a conversation id is hashed, never forwarded", () => {
  // The privacy half. `conversationId` arrives from Anthropic's
  // `metadata.user_id`, and Claude Code puts an account uuid inside it, so
  // forwarding it raw would disclose to the provider an identifier the operator
  // never chose to share.
  const userId = "user_abc_account_11111111-2222-3333-4444-555555555555_session_9";
  const { body, cacheKey } = toResponsesWire({ ...base, conversationId: userId }, "gpt-5");

  expect(cacheKey).toMatch(UUID_V7);
  expect(cacheKey).not.toContain("account");
  expect(JSON.stringify(body)).not.toContain(userId);
});

test("the same conversation keeps one key as its history grows", () => {
  const first = { ...base, conversationId: "conv-a" };
  expect(keyOf(withTurns(first, 6))).toBe(keyOf(first));
});

test("two conversations do not share a key", () => {
  expect(keyOf({ ...base, conversationId: "conv-a" })).not.toBe(
    keyOf({ ...base, conversationId: "conv-b" }),
  );
});

test("without a conversation id the key still survives the turns", () => {
  // The fallback keys on the instructions and the opening item, which is what a
  // conversation keeps. Hashing the whole history would change every turn and
  // buy nothing, which is the failure this shape exists to avoid.
  expect(keyOf(withTurns(base, 6))).toBe(keyOf(base));
});

test("the fallback separates conversations that differ only in their opening turn", () => {
  const other: ChatRequest = {
    ...base,
    messages: [{ role: "user", content: [{ type: "text", text: "different opening" }] }],
  };
  expect(keyOf(other)).not.toBe(keyOf(base));
});

test("a client id beats the derived one, so an edited system prompt does not split a session", () => {
  const edited: ChatRequest = { ...base, system: [{ type: "text", text: "be verbose" }] };
  expect(keyOf({ ...edited, conversationId: "conv-a" })).toBe(
    keyOf({ ...base, conversationId: "conv-a" }),
  );
  // ...and with no client id, that same edit does split it. Stated as the pair
  // because the first assertion alone passes against an encoder that ignores
  // the system prompt entirely.
  expect(keyOf(edited)).not.toBe(keyOf(base));
});

test("an empty history does not reduce the key to the instructions alone", () => {
  // `JSON.stringify` omits a property whose value is `undefined`, so an empty
  // `input` used to drop `firstInput` out of the hash entirely. A request whose
  // only message is an orphaned tool result reaches exactly that state —
  // `validateRequest` strips the block, the message goes with it, and the
  // ingress non-empty guard has already run — on both surfaces.
  const noHistory: ChatRequest = { ...base, messages: [] };
  const instructionsOnly = threadIdFrom(JSON.stringify({ instructions: "be brief" }));

  expect(keyOf(noHistory)).not.toBe(instructionsOnly);
  // The control: the helper does map the full seed onto this key, so the
  // inequality above is about the term, not about two unrelated hashes.
  expect(keyOf(noHistory)).toBe(
    threadIdFrom(JSON.stringify({ instructions: "be brief", firstInput: null })),
  );
});

test("a request with history and one without do not collide", () => {
  // The property the term carries. Two requests sharing a system prompt are one
  // conversation only if they share an opening turn too.
  expect(keyOf({ ...base, messages: [] })).not.toBe(keyOf(base));
});

test("encoding does not write the key onto the request", () => {
  // `ChatRequest` is shared across failover attempts, so a key stored on it
  // would follow the request into the next provider. Deep-frozen rather than
  // cloned and diffed: a clone taken after a mutation compares polluted to
  // polluted, which is how the equivalent Anthropic test passed while leaking.
  const req = base;
  Object.freeze(req);
  Object.freeze(req.messages);
  Object.freeze(req.system);

  expect(() => toResponsesWire(req, "gpt-5")).not.toThrow();
  expect((req as ChatRequest & { prompt_cache_key?: unknown }).prompt_cache_key).toBeUndefined();
  expect(req.vendor).toBeUndefined();
});
