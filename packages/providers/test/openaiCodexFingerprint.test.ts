/**
 * The OpenAI OAuth leg presenting itself as Codex 0.163.0's interactive TUI.
 *
 * Structure is pinned against `fixtures/codex-0.163.0.json`, which is a
 * hand-sanitized copy of what the real client sent to a local capture server
 * (`scripts/codex-capture/`). Values are this gateway's own; what is compared
 * against the capture is names, order and the constants Codex sends.
 *
 * Design: `docs/superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md`.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ChatRequest, GatewayError, type Message } from "@omni/ir";
import type { CodecInput, CodecRequest } from "../src/codec.ts";
import { openaiCodec } from "../src/openai/codec.ts";
import { uuidV5 } from "../src/openai/codexIdentity.ts";
import type { AdapterCredentials } from "../src/types.ts";

type Fixture = {
  headerNames: string[];
  headerValues: Record<string, string>;
  turnMetadata: Record<string, unknown>;
  bodyKeys: string[];
  body: Record<string, unknown>;
  clientMetadata: Record<string, string>;
  followUpInput: Record<string, unknown>[];
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures/codex-0.163.0.json"), "utf8"),
);

/** A thread id the client supplied: a UUID, so it passes through unchanged. */
const THREAD = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const STARTED_AT = 1_792_140_063_816;

const WAIT_TOOL = {
  kind: "portable" as const,
  name: "wait",
  description: "Waits.",
  inputSchema: {
    type: "object",
    properties: { cell_id: { type: "string" } },
    required: ["cell_id"],
    additionalProperties: false,
  },
};

/** The capture's follow-up request, as an IR conversation. */
const FOLLOW_UP: ChatRequest = {
  model: "pool",
  system: [{ type: "text", text: "be brief" }],
  tools: [WAIT_TOOL],
  messages: [
    { role: "user", content: [{ type: "text", text: "wait a moment then say hi" }] },
    {
      role: "assistant",
      content: [
        {
          type: "providerNative",
          provider: "openai",
          blockType: "reasoning",
          data: { id: "rs_1", summary: [], encrypted_content: "opaque" },
        },
        { type: "text", text: "Waiting briefly." },
        { type: "toolUse", id: "call_1", name: "sleep", input: { duration_ms: 1 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "toolResult", toolUseId: "call_1", content: "Sleep completed." }],
    },
  ],
  stream: true,
  vendor: { openai: { prompt_cache_key: THREAD } },
};

const oauthCreds = (accountId: string | null = "acct-9"): AdapterCredentials => ({
  accessToken: "oa-tok",
  apiKey: null,
  providerData: accountId === null ? {} : { accountId },
});

function build(
  request: ChatRequest,
  over: Partial<Omit<CodecInput, "request" | "fail">> = {},
): CodecRequest {
  return openaiCodec.buildRequest({
    request,
    model: "gpt-6-astra",
    credentials: oauthCreds(),
    requestId: "req_1",
    requestStartedAt: STARTED_AT,
    fail: (code, message) => new GatewayError(code, message),
    ...over,
  });
}

const bodyOf = (built: CodecRequest): Record<string, unknown> =>
  JSON.parse(built.request.body) as Record<string, unknown>;
const header = (built: CodecRequest, name: string): string | undefined =>
  built.request.headers.find(([n]) => n === name)?.[1];
const metadataOf = (built: CodecRequest): Record<string, unknown> =>
  JSON.parse(header(built, "x-codex-turn-metadata") ?? "null") as Record<string, unknown>;
const inputOf = (built: CodecRequest): Record<string, unknown>[] =>
  bodyOf(built).input as Record<string, unknown>[];

/** An item's passthrough metadata; empty when the item or the field is missing. */
const passthroughOf = (item: Record<string, unknown> | undefined): Record<string, unknown> =>
  (item?.internal_chat_message_metadata_passthrough as Record<string, unknown> | undefined) ?? {};

/** Key paths in order, values reduced to their JSON type: the shape of an item. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).map(([k, v]) => [k, shape(v)]);
  }
  return value === null ? "null" : typeof value;
}

test("headers go out in Codex's names and order, with its constants", () => {
  const built = build(FOLLOW_UP);

  // `content-length` is the transport's, written after everything a codec sets.
  const expected = FIXTURE.headerNames.filter((name) => name !== "content-length");
  expect(built.request.headers.map(([name]) => name)).toEqual(expected);
  for (const [name, value] of Object.entries(FIXTURE.headerValues)) {
    expect([name, header(built, name)]).toEqual([name, value]);
  }
  expect(header(built, "host")).toBe("chatgpt.com");
  expect(header(built, "authorization")).toBe("Bearer oa-tok");
  expect(header(built, "chatgpt-account-id")).toBe("acct-9");
  expect(header(built, "x-codex-routing-hint")).toBe("model=gpt-6-astra");
  expect(header(built, "x-codex-window-id")).toBe(`${THREAD}:0`);
  for (const name of ["x-client-request-id", "session-id", "thread-id"]) {
    expect([name, header(built, name)]).toEqual([name, THREAD]);
  }
  expect(header(built, "user-agent")).toBe(
    "codex-tui/0.163.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.163.0)",
  );
});

test("the body is marked for zstd, and stays JSON for capture", () => {
  const built = build(FOLLOW_UP);
  expect(built.request.bodyEncoding).toBe("zstd");
  expect(() => JSON.parse(built.request.body)).not.toThrow();
});

test("turn metadata carries Codex's keys in Codex's order", () => {
  const metadata = metadataOf(build(FOLLOW_UP));
  expect(Object.keys(metadata)).toEqual(Object.keys(FIXTURE.turnMetadata));

  const placeholders = new Set([
    "installation_id",
    "session_id",
    "thread_id",
    "turn_id",
    "window_id",
    "context_window_id",
    "root_turn_id",
    "sandbox",
    "turn_started_at_unix_ms",
  ]);
  for (const [key, value] of Object.entries(FIXTURE.turnMetadata)) {
    if (!placeholders.has(key)) expect([key, metadata[key]]).toEqual([key, value]);
  }
  expect(metadata.session_id).toBe(THREAD);
  expect(metadata.thread_id).toBe(THREAD);
  expect(metadata.window_id).toBe(`${THREAD}:0`);
  expect(metadata.root_turn_id).toBe(metadata.turn_id);
  expect(metadata.turn_started_at_unix_ms).toBe(STARTED_AT);
  // The profile claims Windows; `seccomp` is Linux's and would contradict it.
  expect(metadata.sandbox).toBe("windows_elevated");
  expect(metadata.context_window_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
});

test("the body carries Codex's keys in Codex's order, and no instructions or tools", () => {
  const body = bodyOf(build(FOLLOW_UP));
  expect(Object.keys(body)).toEqual(FIXTURE.bodyKeys);
  for (const [key, value] of Object.entries(FIXTURE.body)) {
    if (key === "prompt_cache_key") continue;
    expect([key, body[key]]).toEqual([key, value]);
  }
  expect(body.prompt_cache_key).toBe(THREAD);
});

test("client_metadata repeats the turn metadata and names the same ids", () => {
  const built = build(FOLLOW_UP);
  const metadata = metadataOf(built);
  const client = bodyOf(built).client_metadata as Record<string, string>;

  expect(Object.keys(client).sort()).toEqual(Object.keys(FIXTURE.clientMetadata).sort());
  expect(client.guardian_credits_requested).toBe("true");
  expect(client.mcp_attribution).toBe('{"status":"none"}');
  expect(client["x-codex-turn-metadata"]).toBe(header(built, "x-codex-turn-metadata"));
  expect(client["x-codex-installation-id"]).toBe(metadata.installation_id as string);
  expect(client["x-codex-window-id"]).toBe(`${THREAD}:0`);
  expect(client.session_id).toBe(THREAD);
  expect(client.thread_id).toBe(THREAD);
  expect(client.turn_id).toBe(metadata.turn_id as string);
  expect(client.root_turn_id).toBe(metadata.turn_id as string);
});

test("lite input has the captured shape: tools first, base instructions second, history after", () => {
  const input = inputOf(build(FOLLOW_UP));
  // Two deliberate gaps against the capture, both decided in the design: a
  // replayed reasoning item goes without its server id (`store: false` resolves
  // none), and a replayed call omits `namespace`, as the backend's own does.
  const expected = FIXTURE.followUpInput.map((item) => {
    const { id: _id, ...withoutId } = item;
    if (item.type === "reasoning") return withoutId;
    const { namespace: _namespace, ...rest } = item;
    return rest;
  });
  expect(input.map(shape)).toEqual(expected.map(shape));
});

test("prefix ids are Codex's UUIDv5 over the thread and the payload", () => {
  // Vectors computed with Python's `uuid.uuid5` and `json.dumps(…,
  // separators=(",", ":"))`, not with this repository's helper. The same
  // derivation reproduced both prefix ids of the real capture exactly.
  const input = inputOf(build(FOLLOW_UP));
  expect(input[0]?.id).toBe("at_70a59add-2fa0-5d38-a50e-618d1c07a614");
  expect(input[1]?.id).toBe("msg_8d0d7cab-7b2b-5e76-8ff1-9484d537c418");
  expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
  );
});

test("the client's tools go in one functions namespace, unchanged", () => {
  const tools = (inputOf(build(FOLLOW_UP))[0] as { tools: unknown[] }).tools;
  expect(tools).toEqual([
    {
      type: "namespace",
      name: "functions",
      description: "",
      tools: [
        {
          type: "function",
          name: "wait",
          description: "Waits.",
          strict: false,
          parameters: WAIT_TOOL.inputSchema,
        },
      ],
    },
  ]);
});

test("a request with no tools and no system prompt has no prefix items", () => {
  const { tools: _tools, system: _system, ...bare } = FOLLOW_UP;
  const input = inputOf(build(bare));
  expect(input[0]).toMatchObject({ type: "message", role: "user" });
});

test("history ids are fresh per request and identical for one request built twice", () => {
  const first = build(FOLLOW_UP);
  const again = build(FOLLOW_UP);
  // Purity: failover and the AUTH retry rebuild the request, and must get the
  // same bytes.
  expect(again.request).toEqual(first.request);

  const other = build(FOLLOW_UP, { requestId: "req_2" });
  const ids = (b: CodecRequest) => inputOf(b).map((item) => item.id);
  expect(ids(other).slice(0, 2)).toEqual(ids(first).slice(0, 2));
  expect(ids(other)[2]).not.toBe(ids(first)[2]);
  for (const id of ids(first).slice(2)) {
    if (id === undefined) continue;
    expect(id).toMatch(/^(msg|fc|fco)_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
  }
});

test("create_time and the turn start derive from the request's start", () => {
  const built = build(FOLLOW_UP);
  const user = inputOf(built)[2] as {
    internal_chat_message_metadata_passthrough: { create_time: number };
  };
  const created = user.internal_chat_message_metadata_passthrough.create_time;
  expect(Math.floor(created)).toBe(Math.floor(STARTED_AT / 1000));
  expect(Math.abs(created * 1000 - STARTED_AT)).toBeLessThan(1);
});

/** Turn id per history item, in input order, past the two prefix items. */
function turnsOf(built: CodecRequest): string[] {
  return inputOf(built)
    .slice(2)
    .map(
      (item) =>
        (item.internal_chat_message_metadata_passthrough as { turn_id: string } | undefined)
          ?.turn_id ?? "",
    );
}

test("turn ids group by user turn, and a tool-loop follow-up keeps its turn's id", () => {
  const opening: ChatRequest = { ...FOLLOW_UP, messages: FOLLOW_UP.messages.slice(0, 1) };
  const first = build(opening);
  const followUp = build(FOLLOW_UP, { requestId: "req_2" });

  // One user turn so far, and the tool loop is still inside it.
  expect(metadataOf(followUp).turn_id).toBe(metadataOf(first).turn_id);
  expect(new Set(turnsOf(followUp))).toEqual(new Set([metadataOf(first).turn_id as string]));

  const next: Message[] = [
    ...FOLLOW_UP.messages,
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ];
  const second = build({ ...FOLLOW_UP, messages: next }, { requestId: "req_3" });
  const turns = turnsOf(second);
  const firstTurn = metadataOf(first).turn_id as string;
  expect(metadataOf(second).turn_id).not.toBe(firstTurn);
  // Every item of the first turn, the closing answer included, keeps its id.
  expect(turns.slice(0, -1)).toEqual(turns.slice(0, -1).map(() => firstTurn));
  expect(turns.at(-1)).toBe(metadataOf(second).turn_id as string);
});

test("a tool result in the same message as new user text belongs to the earlier turn", () => {
  const messages: Message[] = [
    ...FOLLOW_UP.messages.slice(0, 2),
    {
      role: "user",
      content: [
        { type: "toolResult", toolUseId: "call_1", content: "done" },
        { type: "text", text: "and now this" },
      ],
    },
  ];
  const built = build({ ...FOLLOW_UP, messages });
  const items = inputOf(built).slice(2);
  const turnOf = (type: string) =>
    passthroughOf(items.find((item) => item.type === type && item.role !== "user")).turn_id;
  const opening = passthroughOf(items[0]).turn_id;
  expect(turnOf("function_call_output")).toBe(opening);
  expect(metadataOf(built).turn_id).not.toBe(opening);
});

test("installation id hashes the account, never forwards it, and is shared by its credentials", () => {
  const one = metadataOf(build(FOLLOW_UP, { credentials: oauthCreds("acct-9") }));
  const two = metadataOf(build(FOLLOW_UP, { credentials: oauthCreds("acct-9") }));
  const other = metadataOf(build(FOLLOW_UP, { credentials: oauthCreds("acct-10") }));
  expect(one.installation_id).toBe(two.installation_id);
  expect(one.installation_id).not.toBe(other.installation_id);
  expect(one.installation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  expect(JSON.stringify(one)).not.toContain("acct-9");

  // No account: still stable per conversation, still not the thread id.
  const bare = metadataOf(build(FOLLOW_UP, { credentials: oauthCreds(null) }));
  const bareAgain = metadataOf(build(FOLLOW_UP, { credentials: oauthCreds(null) }));
  expect(bare.installation_id).toBe(bareAgain.installation_id);
  expect(bare.installation_id).not.toBe(THREAD);
});

test("decoding follows the client's include, not the one this leg sends by default", () => {
  const silent = build(FOLLOW_UP);
  expect(bodyOf(silent).include).toEqual(["reasoning.encrypted_content"]);
  expect(silent.decodeState).toEqual({ nativeReasoning: false });

  const asked = build({
    ...FOLLOW_UP,
    vendor: { openai: { prompt_cache_key: THREAD, include: ["reasoning.encrypted_content"] } },
  });
  expect(asked.decodeState).toEqual({ nativeReasoning: true });
});

test("a client's client_metadata is replaced, and the replacement is recorded", () => {
  const built = build({
    ...FOLLOW_UP,
    vendor: {
      openai: {
        prompt_cache_key: THREAD,
        client_metadata: { "x-codex-installation-id": "REAL-INSTALLATION" },
      },
    },
  });
  expect(built.request.body).not.toContain("REAL-INSTALLATION");
  expect(built.degradations).toContain("openai:client-metadata-replaced");
  expect(build(FOLLOW_UP).degradations ?? []).not.toContain("openai:client-metadata-replaced");
});

test("text and reasoning merge per field, the client winning each field", () => {
  const format = {
    type: "json_schema",
    name: "out",
    strict: true,
    schema: { type: "object", properties: {}, additionalProperties: false },
  };
  const body = bodyOf(
    build({
      ...FOLLOW_UP,
      vendor: {
        openai: {
          prompt_cache_key: THREAD,
          text: { format },
          reasoning: { effort: "high" },
          service_tier: "priority",
        },
      },
    }),
  );
  expect(body.text).toEqual({ verbosity: "low", format });
  expect(body.reasoning).toEqual({ effort: "high", context: "all_turns" });
  // Every other key keeps the whole-value merge.
  expect(body.service_tier).toBe("priority");
  expect(Object.keys(body).indexOf("service_tier")).toBe(2);
});

test("a client service tier joins the routing hint, as Codex writes it", () => {
  const built = build({
    ...FOLLOW_UP,
    vendor: { openai: { prompt_cache_key: THREAD, service_tier: "priority" } },
  });
  expect(header(built, "x-codex-routing-hint")).toBe("model=gpt-6-astra;tier=priority");
});

test("each reasoning mode maps to the effort Codex would send", () => {
  const sent = (reasoning: ChatRequest["reasoning"], model = "gpt-6-astra") => {
    const built = build(
      { ...FOLLOW_UP, ...(reasoning === undefined ? {} : { reasoning }) },
      { model },
    );
    return {
      reasoning: bodyOf(built).reasoning,
      effort: metadataOf(built).reasoning_effort,
      degradations: built.degradations ?? [],
    };
  };

  // Omitted: the model's catalog default, which is not the same for every model.
  expect(sent(undefined).reasoning).toEqual({ effort: "low", context: "all_turns" });
  expect(sent(undefined, "gpt-6-sol").reasoning).toEqual({
    effort: "medium",
    context: "all_turns",
  });
  // A model the catalog does not list takes the shared defaults.
  expect(sent(undefined, "gpt-9-unknown").reasoning).toEqual({
    effort: "low",
    context: "all_turns",
  });

  // A client effort is sent as today, summary rule included.
  expect(sent({ mode: "adaptive", effort: "high" }).reasoning).toEqual({
    effort: "high",
    summary: "auto",
    context: "all_turns",
  });
  expect(sent({ mode: "adaptive", effort: "high", display: "omitted" }).reasoning).toEqual({
    effort: "high",
    context: "all_turns",
  });
  expect(sent({ mode: "adaptive", effort: "high" }).effort).toBe("high");
  // Adaptive with no effort named is a client that did not choose a depth:
  // Codex's default, not an invented medium.
  expect(sent({ mode: "adaptive" }, "gpt-6-sol").reasoning).toEqual({
    effort: "medium",
    summary: "auto",
    context: "all_turns",
  });
  expect(sent({ mode: "adaptive" }, "gpt-6-astra").reasoning).toEqual({
    effort: "low",
    summary: "auto",
    context: "all_turns",
  });

  // `off` and `betweenTools` take the lowest supported level; Codex always
  // sends an effort and `none` is in no current model's list.
  expect(sent({ mode: "off" }, "gpt-6-sol").reasoning).toEqual({
    effort: "low",
    context: "all_turns",
  });
  const between = sent({ mode: "betweenTools" }, "gpt-6-sol");
  expect(between.reasoning).toEqual({ effort: "low", context: "all_turns" });
  expect(between.degradations).toContain("openai:reasoning-between-tools-as-off");

  // A token budget has no effort spelling: catalog default, loss recorded.
  const budget = sent({ mode: "budget", budgetTokens: 4000 }, "gpt-6-sol");
  expect(budget.reasoning).toEqual({ effort: "medium", context: "all_turns" });
  expect(budget.degradations).toContain("openai:reasoning-budget-dropped");
  expect(budget.effort).toBe("medium");
});

test("model-specific metadata comes from the Codex catalog", () => {
  expect(metadataOf(build(FOLLOW_UP)).node_repl_auto_review_required).toBe(true);
  expect(metadataOf(build(FOLLOW_UP, { model: "gpt-6-luna" })).node_repl_auto_review_required).toBe(
    false,
  );
});

test("a client tool choice is kept; absent, the leg sends Codex's auto", () => {
  expect(bodyOf(build(FOLLOW_UP)).tool_choice).toBe("auto");
  expect(bodyOf(build({ ...FOLLOW_UP, toolChoice: { type: "any" } })).tool_choice).toBe("required");
});

test("history items carry the passthrough Codex stamps on each kind", () => {
  const input = inputOf(build(FOLLOW_UP)).slice(2);
  const passthrough = (i: number) =>
    input[i]?.internal_chat_message_metadata_passthrough as Record<string, unknown>;
  expect(passthrough(0).content_item_kinds).toEqual(["user.text"]);
  expect(passthrough(2).content_item_kinds).toEqual(["unknown"]);
  expect(input[2]?.status).toBe("completed");
  expect(input[3]?.status).toBe("completed");
  expect(Object.keys(passthrough(3))).toEqual(["turn_id"]);
  expect(Object.keys(passthrough(4))).toEqual(["turn_id", "create_time"]);
});

test("content kinds follow each part, and a part Codex has no kind for drops the list", () => {
  const image = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };
  const withImage = inputOf(
    build({
      ...FOLLOW_UP,
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, image] }],
    }),
  )[2];
  expect(passthroughOf(withImage).content_item_kinds).toEqual(["user.text", "user.image"]);

  // A tool-result file moves to an `input_file` part, which Codex's user
  // content cannot hold: no guessed kind, the rest of the passthrough kept.
  const moved = inputOf(
    build({
      ...FOLLOW_UP,
      messages: [
        ...FOLLOW_UP.messages.slice(0, 2),
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "call_1",
              content: "see file",
              files: [{ type: "file", mediaType: "application/pdf", data: "JVBERi0xLjQK" }],
            },
          ],
        },
      ],
    }),
  ).at(-1);
  expect(moved).toMatchObject({ type: "message", role: "user" });
  const parts = (moved?.content ?? []) as { type: string }[];
  expect(parts.map((part) => part.type)).toEqual(["input_file"]);
  expect(Object.keys(passthroughOf(moved))).toEqual(["turn_id", "create_time"]);
});

test("a Codex client's own thread id lends its instant to the ids minted after it", () => {
  // THREAD is a v7 in the past, so it is a real thread's start; the context
  // window id is minted at that instant rather than at a derived one.
  const metadata = metadataOf(build(FOLLOW_UP));
  const instant = (uuid: string) => uuid.replace(/-/g, "").slice(0, 12);
  expect(instant(metadata.context_window_id as string)).toBe(instant(THREAD));
});

test("a mid-conversation system turn goes as a developer message stamped like a user one", () => {
  const messages: Message[] = [
    FOLLOW_UP.messages[0] as Message,
    { role: "system", content: [{ type: "text", text: "operator note" }] },
  ];
  const item = inputOf(build({ ...FOLLOW_UP, messages }))[3];
  expect(item).toMatchObject({ type: "message", role: "developer" });
  expect(passthroughOf(item).content_item_kinds).toEqual(["user.text"]);
  expect(item?.id).toMatch(/^msg_/);
});
