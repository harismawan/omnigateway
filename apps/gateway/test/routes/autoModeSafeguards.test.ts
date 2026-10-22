import { expect, test } from "bun:test";
import { PONYTAIL_MARKER } from "@omni/ponytail";
import { anthropicAdapter, type HttpClient, type HttpRequest } from "@omni/providers";
import {
  memoryStore,
  seedApiKey,
  seedCredential,
  stubAdapters,
  target,
  virtualModel,
} from "@omni/testkit";
import { proxyRoutes } from "../../src/routes/proxy.ts";

const RESULTS = [
  {
    type: "dangerous_tool_use",
    status: {
      type: "available",
      tool_uses: {
        toolu_original_1: { type: "evaluated", outcome: "not_flagged" },
        toolu_original_2: { type: "evaluated", outcome: "flagged", explanation: "sensitive" },
      },
      future: { opaque: [1, "keep", null] },
    },
  },
];

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function harness(results: unknown = RESULTS, location = "delta", oauth = false) {
  const store = await memoryStore();
  await seedCredential(store, {
    id: "a1",
    provider: "anthropic",
    ...(oauth ? {} : { authType: "apiKey", accessToken: null, apiKey: "upstream-secret" }),
  });
  await store.config.putModel(
    virtualModel({
      id: "claude-test",
      targets: [target({ provider: "anthropic", model: "claude-sonnet-4-6" })],
    }),
  );
  const { raw } = await seedApiKey(store);
  const sent: HttpRequest[] = [];
  const http: HttpClient = async (request) => {
    sent.push(request);
    const extra = location === "absent" ? {} : { safeguard_results: results };
    const frames = [
      sse("message_start", {
        type: "message_start",
        message: { id: "msg_upstream", model: "claude-sonnet-4-6", usage: { input_tokens: 10 } },
      }),
      ...["toolu_original_1", "toolu_original_2"].flatMap((id, index) => [
        sse("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id, name: "read_file", input: {} },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: '{"path":"file.txt"}' },
        }),
        sse("content_block_stop", { type: "content_block_stop", index }),
      ]),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", ...(location === "delta" ? extra : {}) },
        usage: { output_tokens: 8 },
        ...(location === "top" ? extra : {}),
      }),
      sse("message_stop", { type: "message_stop", ...(location === "stop" ? extra : {}) }),
    ].join("");
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new Response(frames).body,
      text: async () => frames,
    };
  };
  const app = proxyRoutes({
    store,
    adapters: { ...stubAdapters([]), anthropic: anthropicAdapter },
    http,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (credential) => await credential.secrets(),
    requestId: () => "req_safeguards",
  });
  const call = (stream: boolean, path = "/v1/messages", body = {}, headers = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}`, ...headers },
        body: JSON.stringify({
          model: "claude-test",
          max_tokens: 100,
          stream,
          messages: [{ role: "user", content: "read the file" }],
          ...body,
        }),
      }),
    );
  return { call, sent, raw, store };
}

function events(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const SAFEGUARDS = [{ type: "dangerous_tool_use", classifier_context: { opaque: "context" } }];
const SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=client; cch=abcde;" },
  { type: "text", text: "Client system block", cache_control: { type: "ephemeral", ttl: "1h" } },
];
const TOOL_REQUEST = {
  safeguards: SAFEGUARDS,
  system: SYSTEM,
  tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
  tool_choice: { type: "tool", name: "read_file" },
  messages: [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_history", name: "read_file", input: { path: "old" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_history", content: "old" }],
    },
  ],
};

for (const system of [SYSTEM, "Client string system"]) {
  test(`safeguard requests retain configured Ponytail additions (${typeof system})`, async () => {
    const { call, sent, store } = await harness();
    await store.config.putSettings({ ponytailMode: "full" });
    const clientSystem = Array.isArray(system)
      ? system.map((block) => ({ ...block, future_field: "preserve" }))
      : system;
    const response = await call(false, "/v1/messages", { ...TOOL_REQUEST, system: clientSystem });
    expect(response.status).toBe(200);
    await response.text();
    const request = sent[0];
    if (request === undefined) throw new Error("no upstream request");
    const body = JSON.parse(request.body) as { system: Array<Record<string, unknown>> };
    expect(body.system.at(-1)?.text).toContain(PONYTAIL_MARKER);
    if (Array.isArray(clientSystem)) {
      expect(body.system[0]).toEqual(clientSystem[0]);
      expect(body.system[1]).toEqual({
        type: "text",
        text: "Client system block",
        future_field: "preserve",
      });
      expect(body.system.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    } else {
      expect(body.system[0]).toEqual({ type: "text", text: "Client string system" });
    }
  });
}

for (const oauth of [false, true]) {
  test(`forwards safeguards and protocol headers with upstream-owned auth (oauth=${oauth})`, async () => {
    const { call, sent, raw } = await harness(RESULTS, "delta", oauth);
    const response = await call(false, "/v1/messages?beta=true", TOOL_REQUEST, {
      "anthropic-version": "2099-01-01",
      "anthropic-beta": "dangerous-tool-use-2026-09-03,future-capability",
      "anthropic-workspace-id": "workspace_client",
      "anthropic-future-capability": "opaque-value",
      "x-api-key": raw,
    });
    expect(response.status).toBe(200);
    await response.text();
    const request = sent[0];
    if (request === undefined) throw new Error("no upstream request");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const headers = new Headers(request.headers.map(([name, value]) => [name, value]));
    expect(body.safeguards).toEqual(SAFEGUARDS);
    expect(headers.get("anthropic-version")).toBe("2099-01-01");
    expect(headers.get("anthropic-workspace-id")).toBe("workspace_client");
    expect(headers.get("anthropic-future-capability")).toBe("opaque-value");
    expect(headers.get("anthropic-beta")).toBe(
      `dangerous-tool-use-2026-09-03,future-capability${oauth ? ",oauth-2025-04-20" : ""}`,
    );
    expect(headers.get("authorization")).toBe(oauth ? "Bearer test-token-a1" : null);
    expect(headers.get("x-api-key")).toBe(oauth ? null : "upstream-secret");
  });

  test(`preserves safeguard request system blocks and tool identity (oauth=${oauth})`, async () => {
    const { call, sent } = await harness(RESULTS, "delta", oauth);
    const response = await call(false, "/v1/messages", TOOL_REQUEST);
    expect(response.status).toBe(200);
    const reply = (await response.json()) as { content: Array<{ id: string; name: string }> };
    const request = sent[0];
    if (request === undefined) throw new Error("no upstream request");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.system).toEqual(SYSTEM);
    expect(body.tools).toEqual(TOOL_REQUEST.tools);
    expect(body.tool_choice).toEqual(TOOL_REQUEST.tool_choice);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      TOOL_REQUEST.messages[1],
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_history", content: "old", is_error: false },
        ],
      },
    ]);
    expect(reply.content.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "toolu_original_1", name: "read_file" },
      { id: "toolu_original_2", name: "read_file" },
    ]);
  });
}

test("ordinary OAuth requests retain their system pipeline and tool cloak", async () => {
  const { call, sent } = await harness(RESULTS, "delta", true);
  const { safeguards: _safeguards, ...ordinary } = TOOL_REQUEST;
  const response = await call(false, "/v1/messages", ordinary);
  expect(response.status).toBe(200);
  await response.text();
  const request = sent[0];
  if (request === undefined) throw new Error("no upstream request");
  const body = JSON.parse(request.body) as {
    system: Array<{ text: string }>;
    tools: Array<{ name: string }>;
  };
  expect(body.system[0]?.text).toStartWith("x-anthropic-billing-header: cc_version=");
  expect(body.system[1]?.text).toBe(
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  expect(body.tools[0]?.name).toBe("ReadFile");
});

for (const stream of [false, true]) {
  for (const [label, results] of [
    ["per-tool verdicts", RESULTS],
    ["unsupported", [{ type: "dangerous_tool_use", status: { type: "unsupported" } }]],
    [
      "unavailable",
      [{ type: "dangerous_tool_use", status: { type: "unavailable", reason: "error" } }],
    ],
    ["empty", []],
    ["null", null],
  ] as const) {
    test(`preserves ${label} in ${stream ? "streaming" : "buffered"} Messages replies`, async () => {
      const { call } = await harness(results);
      const response = await call(stream);
      expect(response.status).toBe(200);
      if (stream) {
        const frames = events(await response.text());
        const delta = frames.find((frame) => frame.type === "message_delta");
        expect(delta?.delta).toMatchObject({ safeguard_results: results });
        const blocks = frames.filter((frame) => frame.type === "content_block_start");
        expect(blocks.map((frame) => (frame.content_block as { id: string }).id)).toEqual([
          "toolu_original_1",
          "toolu_original_2",
        ]);
        expect(frames.at(-1)?.type).toBe("message_stop");
      } else {
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.safeguard_results).toEqual(results);
        expect(body.content).toEqual([
          {
            type: "tool_use",
            id: "toolu_original_1",
            name: "read_file",
            input: { path: "file.txt" },
          },
          {
            type: "tool_use",
            id: "toolu_original_2",
            name: "read_file",
            input: { path: "file.txt" },
          },
        ]);
      }
    });
  }

  for (const location of ["top", "stop"]) {
    test(`preserves results from ${location} final frames (${stream})`, async () => {
      const { call } = await harness(RESULTS, location);
      const response = await call(stream);
      const body = stream
        ? events(await response.text()).find((frame) => frame.type === "message_delta")?.delta
        : await response.json();
      expect(body).toMatchObject({ safeguard_results: RESULTS });
    });
  }

  test(`does not invent missing results (${stream})`, async () => {
    const { call } = await harness(undefined, "absent");
    const response = await call(stream);
    expect(await response.text()).not.toContain("safeguard_results");
  });

  test(`does not expose Anthropic verdicts on OpenAI responses (${stream})`, async () => {
    const { call } = await harness();
    const response = await call(stream, "/v1/chat/completions");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("safeguard_results");
  });
}
