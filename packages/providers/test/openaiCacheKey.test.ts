import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ChatRequest, Message } from "@omni/ir";
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

test("a client's own prompt_cache_key is used verbatim, and matches the body", () => {
  const req: ChatRequest = {
    ...base,
    vendor: { openai: { prompt_cache_key: "chosen-by-caller" } },
  };
  const { body, cacheKey } = toResponsesWire(req, "gpt-5");

  expect(cacheKey).toBe("chosen-by-caller");
  // Resolved before the vendor merge for this reason: the merge writes the
  // caller's value into the body last, so a key resolved after it would send
  // one name in the header and another in the body.
  expect(body.prompt_cache_key).toBe("chosen-by-caller");
});

test("session_id is the second name a client may use for the same thing", () => {
  expect(keyOf({ ...base, vendor: { openai: { session_id: "sess-77" } } })).toBe("sess-77");
});

test("prompt_cache_key wins over session_id when a client sends both", () => {
  const req: ChatRequest = {
    ...base,
    vendor: { openai: { session_id: "sess-77", prompt_cache_key: "pck-1" } },
  };
  expect(keyOf(req)).toBe("pck-1");
});

test("an empty or non-string client key falls through rather than being sent", () => {
  // An empty session id is not a session id. Sending it would put every
  // conversation on this installation into one partition, which is worse than
  // the derived key it displaced.
  //
  // Asserted on the **body**, not only on the returned key. The vendor bag is
  // merged onto the body verbatim, so a version of this that checked the return
  // value alone passed while the merge wrote the rejected value straight back
  // into `prompt_cache_key` — and on the API-key leg, where no `session_id`
  // header exists, that field is the only mechanism there is.
  for (const rejected of [{ prompt_cache_key: "" }, { session_id: 42 }, { prompt_cache_key: 7 }]) {
    const { body, cacheKey } = toResponsesWire({ ...base, vendor: { openai: rejected } }, "gpt-5");
    expect(cacheKey).toMatch(/^[0-9a-f]{32}$/);
    expect(body.prompt_cache_key).toBe(cacheKey);
  }
});

test("a client's own key survives the vendor merge rather than being overwritten by it", () => {
  // The other direction of the same ordering. The resolved key is written after
  // the merge, so this proves the write is not simply clobbering whatever the
  // client asked for.
  const req: ChatRequest = { ...base, vendor: { openai: { prompt_cache_key: "mine" } } };
  const { body, cacheKey } = toResponsesWire(req, "gpt-5");
  expect(cacheKey).toBe("mine");
  expect(body.prompt_cache_key).toBe("mine");
});

test("other vendor fields still ride the merge untouched", () => {
  // The fix reorders the merge, so this pins that reordering did not cost the
  // passthrough the merge exists for.
  const req: ChatRequest = { ...base, vendor: { openai: { service_tier: "priority" } } };
  const { body } = toResponsesWire(req, "gpt-5");
  expect(body.service_tier).toBe("priority");
  expect(body.prompt_cache_key).toMatch(/^[0-9a-f]{32}$/);
});

test("a conversation id is hashed, never forwarded", () => {
  // The privacy half. `conversationId` arrives from Anthropic's
  // `metadata.user_id`, and Claude Code puts an account uuid inside it, so
  // forwarding it raw would disclose to the provider an identifier the operator
  // never chose to share.
  const userId = "user_abc_account_11111111-2222-3333-4444-555555555555_session_9";
  const { body, cacheKey } = toResponsesWire({ ...base, conversationId: userId }, "gpt-5");

  expect(cacheKey).toMatch(/^[0-9a-f]{32}$/);
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
  const instructionsOnly = createHash("sha256")
    .update(JSON.stringify({ instructions: "be brief" }))
    .digest("hex")
    .slice(0, 32);

  expect(keyOf(noHistory)).not.toBe(instructionsOnly);
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
