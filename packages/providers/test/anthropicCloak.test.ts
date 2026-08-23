import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { buildToolCloak, cloakName, uncloakName } from "../src/anthropic/cloak.ts";
import { decodeAnthropic } from "../src/anthropic/decode.ts";
import { toWire } from "../src/anthropic/wire.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "claude-opus-4",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

/** A request whose only tools are the custom names given. */
function withTools(...names: string[]): ChatRequest {
  return {
    ...base,
    tools: names.map((name) => ({
      provider: "custom" as const,
      name,
      inputSchema: { type: "object" },
    })),
  };
}

test("derives a PascalCase alias from every separator style", () => {
  const cloak = buildToolCloak(withTools("session_search", "web-extract", "delegate_task"));
  expect(cloakName(cloak, "session_search")).toBe("SessionSearch");
  expect(cloakName(cloak, "web-extract")).toBe("WebExtract");
  expect(cloakName(cloak, "delegate_task")).toBe("DelegateTask");
});

test("a name already in the target shape gets no map entry at all", () => {
  // Not merely an identity mapping: an entry would put the name in `fromWire`
  // and make the restore path claim a rename that never happened.
  const cloak = buildToolCloak(withTools("Read", "Bash2", "WebFetch"));
  expect(cloak).toBeNull();
});

test("an exempt name a live alias would land on keeps it, and the alias moves aside", () => {
  // The client sends both. `ReadFile` is exempt and goes out under its own
  // spelling, so `read_file` deriving `ReadFile` would put two tools with one
  // name on the wire — and hand back the exempt tool's replies under the other
  // tool's name. Ordinary traffic: PascalCase built-ins beside snake_case
  // customs is the shape of every harness this cloak was written for.
  const cloak = buildToolCloak(withTools("ReadFile", "read_file"));
  expect(cloakName(cloak, "read_file")).not.toBe("ReadFile");
  expect(cloakName(cloak, "ReadFile")).toBe("ReadFile");
  // The restore path is the half that fails silently, so assert it directly:
  // the exempt name must come back as itself, not as the tool that derived it.
  expect(uncloakName(cloak, "ReadFile")).toBe("ReadFile");
  expect(uncloakName(cloak, cloakName(cloak, "read_file"))).toBe("read_file");

  const { body } = toWire(withTools("ReadFile", "read_file"), "claude-opus-4", {
    oauth: true,
    cloak,
  });
  const names = (body.tools as { name: string }[]).map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
});

test("an exempt name reserves its spelling from message history alone", () => {
  // Same collision, reached through the door the `tools[]`-only build missed.
  const cloak = buildToolCloak({
    ...withTools("read_file"),
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tu_1", name: "ReadFile", input: {} }],
      },
    ],
  });
  expect(cloakName(cloak, "read_file")).not.toBe("ReadFile");
  expect(uncloakName(cloak, "ReadFile")).toBe("ReadFile");
});

test("a tool_choice naming a tool absent from tools[] is renamed too", () => {
  // The name must be in neither `tools[]` nor history, or the map would hold it
  // anyway and this would pin nothing — which is exactly what an earlier
  // version of this test did.
  const request: ChatRequest = {
    ...withTools("session_search"),
    toolChoice: { type: "tool", name: "delegate_task" },
  };
  const cloak = buildToolCloak(request);
  expect(cloakName(cloak, "delegate_task")).toBe("DelegateTask");

  const { body } = toWire(request, "claude-opus-4", { oauth: true, cloak });
  expect(body.tool_choice).toEqual({ type: "tool", name: "DelegateTask" });
});

test("an mcp-prefixed name is left alone because the prefix carries routing", () => {
  const cloak = buildToolCloak(withTools("mcp__github__create_issue", "session_search"));
  expect(cloakName(cloak, "mcp__github__create_issue")).toBe("mcp__github__create_issue");
  expect(cloakName(cloak, "session_search")).toBe("SessionSearch");
});

test("a history tool_use naming a tool no longer in tools[] is still renamed", () => {
  // The door nobody was watching: build the map from `tools[]` alone and this
  // name reaches the wire in the shape the cloak exists to prevent.
  const cloak = buildToolCloak({
    ...withTools("session_search"),
    messages: [
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tu_1", name: "delegate_task", input: {} }],
      },
    ],
  });
  expect(cloakName(cloak, "delegate_task")).toBe("DelegateTask");
  expect(uncloakName(cloak, "DelegateTask")).toBe("delegate_task");
});

test("every member of a colliding group takes a suffix, and nobody keeps the bare alias", () => {
  const cloak = buildToolCloak(withTools("read_file", "readFile"));
  const a = cloakName(cloak, "read_file");
  const b = cloakName(cloak, "readFile");
  expect(a).toMatch(/^ReadFile[0-9A-F][0-9a-f]{5}$/);
  expect(b).toMatch(/^ReadFile[0-9A-F][0-9a-f]{5}$/);
  expect(a).not.toBe(b);
  // Both directions, or a collision bug shows up as a client seeing a name it
  // never sent.
  expect(uncloakName(cloak, a)).toBe("read_file");
  expect(uncloakName(cloak, b)).toBe("readFile");
});

test("a colliding alias is the same whichever order the client listed the tools", () => {
  // Suffixing derives from the source name, never from array position, so a
  // client reordering `tools[]` cannot move a tool's alias.
  const forward = buildToolCloak(withTools("read_file", "readFile", "session_search"));
  const reversed = buildToolCloak(withTools("session_search", "readFile", "read_file"));
  for (const name of ["read_file", "readFile", "session_search"]) {
    expect(cloakName(forward, name)).toBe(cloakName(reversed, name));
  }
});

test("an alias landing on an Anthropic-defined name in the same request is suffixed away", () => {
  const cloak = buildToolCloak({
    ...base,
    tools: [
      { provider: "custom", name: "web+search", inputSchema: { type: "object" } },
      {
        provider: "anthropic",
        family: "webSearch",
        type: "web_search_20250305",
        name: "WebSearch",
        wire: {},
      },
    ],
  });
  // The Anthropic name is fixed upstream and cannot move, so the custom tool is
  // the one that yields.
  expect(cloakName(cloak, "web+search")).toMatch(/^WebSearch[0-9A-F][0-9a-f]{5}$/);
  expect(cloakName(cloak, "WebSearch")).toBe("WebSearch");
});

test("the suffix uses the full 24 bits of the digest", () => {
  // A golden value, because the shape assertions above cannot see the width:
  // `padStart(6, "0")` renders a 16-bit digest as six characters too, so
  // narrowing the mask would leave every `/^ReadFile[0-9A-F][0-9a-f]{5}$/`
  // passing while silently returning the collision odds to one in 65 thousand.
  // Under a 16-bit mask this name yields `ReadFile0070ad` instead.
  const cloak = buildToolCloak(withTools("read_file", "readFile"));
  expect(cloakName(cloak, "read_file")).toBe("ReadFileEa70ad");
});

test("a name with no alphanumeric characters becomes Tool plus its suffix", () => {
  const cloak = buildToolCloak(withTools("__", "--"));
  expect(cloakName(cloak, "__")).toMatch(/^Tool[0-9A-F][0-9a-f]{5}$/);
  expect(cloakName(cloak, "--")).toMatch(/^Tool[0-9A-F][0-9a-f]{5}$/);
  expect(cloakName(cloak, "__")).not.toBe(cloakName(cloak, "--"));
});

test("an over-long name is truncated and suffixed to Anthropic's 128-character ceiling", () => {
  const long = `${"a_".repeat(140)}end`;
  const cloak = buildToolCloak(withTools(long));
  const alias = cloakName(cloak, long);
  expect(alias.length).toBe(128);
  expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  expect(uncloakName(cloak, alias)).toBe(long);
});

test("a request with nothing to rename builds no cloak", () => {
  expect(buildToolCloak(base)).toBeNull();
  expect(cloakName(null, "session_search")).toBe("session_search");
  expect(uncloakName(null, "SessionSearch")).toBe("SessionSearch");
});

/** A request touching all three request-side sites a client name reaches. */
const THREE_SITES: ChatRequest = {
  ...base,
  messages: [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "tu_1", name: "delegate_task", input: { x: 1 } }],
    },
    {
      role: "user",
      content: [{ type: "toolResult", toolUseId: "tu_1", content: "done" }],
    },
  ],
  tools: [
    { provider: "custom", name: "delegate_task", inputSchema: { type: "object" } },
    { provider: "custom", name: "session_search", inputSchema: { type: "object" } },
  ],
  toolChoice: { type: "tool", name: "session_search" },
};

test("the encoder renames tools, history tool_use and tool_choice consistently", () => {
  const cloak = buildToolCloak(THREE_SITES);
  const { body } = toWire(THREE_SITES, "claude-opus-4", { oauth: true, cloak });

  expect(body.tools).toEqual([
    { name: "DelegateTask", input_schema: { type: "object" } },
    { name: "SessionSearch", input_schema: { type: "object" } },
  ]);
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "tool_use", id: "tu_1", name: "DelegateTask", input: { x: 1 } }],
  });
  expect(body.tool_choice).toEqual({ type: "tool", name: "SessionSearch" });
});

test("an Anthropic-defined tool keeps the name Anthropic pairs with its type", () => {
  const req: ChatRequest = {
    ...base,
    tools: [
      // Named to sit *in* the cloak's map: a client custom tool called `bash`
      // alongside the real one puts `bash` on the left-hand side, so an encoder
      // that looked the Anthropic name up would find a rename waiting for it.
      // Without this pairing the assertion passes on identity fallback alone
      // and proves nothing.
      { provider: "custom", name: "bash", inputSchema: { type: "object" } },
      { provider: "anthropic", family: "bash", type: "bash_20250124", name: "bash", wire: {} },
    ],
  };
  const cloak = buildToolCloak(req);
  expect(cloak?.toWire.get("bash")).toBe("Bash");

  const { body } = toWire(req, "claude-opus-4", { oauth: true, cloak });
  // Renaming this one breaks ingress re-validation and upstream alike.
  expect(body.tools?.[1]).toEqual({ type: "bash_20250124", name: "bash" });
  // The custom tool of the same name still moves.
  expect(body.tools?.[0]).toEqual({ name: "Bash", input_schema: { type: "object" } });
});

test("an anthropicNative block's payload is byte-identical with the cloak on", () => {
  const data = { id: "srvtoolu_1", name: "web_search", input: { query: "bun" } };
  const req: ChatRequest = {
    ...base,
    messages: [
      {
        role: "assistant",
        content: [{ type: "anthropicNative", blockType: "server_tool_use", data }],
      },
    ],
    tools: [{ provider: "custom", name: "web_search", inputSchema: { type: "object" } }],
  };
  const bare = toWire(req, "claude-opus-4", { oauth: true });
  const cloaked = toWire(req, "claude-opus-4", { oauth: true, cloak: buildToolCloak(req) });

  // `data.name` is Anthropic's own tool name inside an opaque payload, and it
  // collides with a client tool of the same name here on purpose: the cloak
  // must key on the block type, not on the string.
  expect(JSON.stringify(cloaked.body.messages[0])).toBe(JSON.stringify(bare.body.messages[0]));
  expect(JSON.stringify(cloaked.body.messages[0])).toContain('"name":"web_search"');
});

test("a cloaked request records the names it lost as a degradation", () => {
  const { degradations } = toWire(THREE_SITES, "claude-opus-4", {
    oauth: true,
    cloak: buildToolCloak(THREE_SITES),
  });
  expect(degradations).toContain("anthropic:tool-names-cloaked");
});

test("an uncloaked request records no such degradation", () => {
  const { degradations } = toWire(THREE_SITES, "claude-opus-4", { oauth: false });
  expect(degradations).not.toContain("anthropic:tool-names-cloaked");
});

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function drain(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

/** The upstream answering with an alias this gateway invented. */
function toolUseStart(name: string): SseMessage {
  return {
    event: "content_block_start",
    data: JSON.stringify({ index: 0, content_block: { type: "tool_use", id: "tu_1", name } }),
  };
}

test("the decoder restores the client's own name on a tool_use block", () => {
  const cloak = buildToolCloak(withTools("session_search"));
  const events = drain(decodeAnthropic(msgs(toolUseStart("SessionSearch")), { cloak }));
  return events.then((out) => {
    expect(out[0]).toEqual({
      type: "blockStart",
      index: 0,
      block: { type: "toolUse", id: "tu_1", name: "session_search" },
    });
  });
});

test("the decoder leaves a name it never cloaked alone", () => {
  const cloak = buildToolCloak(withTools("session_search"));
  const events = drain(decodeAnthropic(msgs(toolUseStart("SomethingElse")), { cloak }));
  return events.then((out) => {
    expect(out[0]).toMatchObject({ block: { name: "SomethingElse" } });
  });
});

/** The refusal as Anthropic actually sends it, both recorded phrasings. */
function errorEvent(type: string, message: string): SseMessage {
  return { event: "error", data: JSON.stringify({ error: { type, message } }) };
}

test("the measured fingerprint refusal is named rather than read as a bad request", async () => {
  for (const message of [
    "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    "Third-party apps now draw from extra usage, not plan limits.",
  ]) {
    const out = await drain(decodeAnthropic(msgs(errorEvent("invalid_request_error", message))));
    expect(out[0]).toEqual({
      type: "error",
      code: "FINGERPRINT_REFUSED",
      // Forwarded verbatim: the client sees what it saw before this code existed.
      message,
      retryable: false,
    });
  }
});

test("an ordinary invalid_request_error is still a bad request", async () => {
  const out = await drain(
    decodeAnthropic(msgs(errorEvent("invalid_request_error", "max_tokens: must be >= 1"))),
  );
  expect(out[0]).toMatchObject({ code: "BAD_REQUEST" });
});

test("the refusal is recognised whatever case the upstream sends it in", async () => {
  // The two recorded phrasings are what Anthropic sends today, not a contract.
  // Matching is case-insensitive so a capitalisation change upstream cannot
  // quietly turn every refusal back into an unexplained `BAD_REQUEST` — and
  // that only holds if something tests a casing the wild has not produced yet.
  const out = await drain(
    decodeAnthropic(
      msgs(
        errorEvent("invalid_request_error", "You're OUT OF EXTRA USAGE. Add more at claude.ai."),
      ),
    ),
  );
  expect(out[0]).toMatchObject({ code: "FINGERPRINT_REFUSED" });
});

test("the same overage wording under a rate_limit_error stays a retryable rate limit", async () => {
  // The `type` half of the predicate, which no other test exercises: both
  // negative cases above are already `invalid_request_error`, so deleting the
  // conjunct left the suite green. A real rate limit wearing this wording must
  // keep the retry and the breaker penalty that go with `RATE_LIMIT` rather
  // than becoming a refusal that ends the request on the first attempt.
  const out = await drain(
    decodeAnthropic(
      msgs(errorEvent("rate_limit_error", "Third-party apps now draw from extra usage.")),
    ),
  );
  expect(out[0]).toMatchObject({ code: "RATE_LIMIT", retryable: true });
});
