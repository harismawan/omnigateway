import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type ChatRequest, GatewayError } from "@omni/ir";
import { qoderCodec } from "../src/qoder/codec.ts";
import { decodeBody } from "../src/qoder/protocol.ts";

const bundle = {
  version: 1,
  deviceToken: "dummy-token",
  uid: "u1",
  machineId: "synthetic-device",
  encryptUserInfo: "encrypted",
  key: "wrapped",
  issuedAt: 1700000000000,
  origin: "https://api3.qoder.sh",
  models: [
    {
      key: "synthetic",
      displayName: "Synthetic",
      images: true,
      reasoning: true,
      maxInputTokens: 1234,
    },
  ],
};
const request: ChatRequest = {
  model: "pool",
  system: [{ type: "text", text: "top system" }],
  conversationId: "private-client-conversation",
  stream: false,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{ type: "toolUse", id: "portable-1", name: "weather", input: { city: "雪" } }],
    },
    { role: "user", content: [{ type: "toolResult", toolUseId: "portable-1", content: "sunny" }] },
    { role: "system", content: [{ type: "text", text: "mid system" }] },
  ],
};
const fail = (code: ConstructorParameters<typeof GatewayError>[0], message: string) =>
  new GatewayError(code, message);
function input() {
  return {
    request: structuredClone(request),
    model: "synthetic",
    credentials: {
      accessToken: JSON.stringify(bundle),
      apiKey: null,
      providerData: { inferenceOrigin: "https://evil.test" },
    },
    requestId: "req-1",
    requestStartedAt: 1700000001000,
    fail,
  };
}

test("Qoder codec signs encoded chat using fresh secret origin and preserves history/tool correlation", () => {
  const i = input();
  const before = JSON.stringify(i.request);
  const built = qoderCodec.buildRequest(i);
  expect(qoderCodec.buildRequest(i)).toEqual(built);
  expect(JSON.stringify(i.request)).toBe(before);
  expect(built.request.url).toBe(
    "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1",
  );
  const body = JSON.parse(decodeBody(built.request.body ?? ""));
  expect(body).toMatchObject({
    stream: true,
    chat_task: "FREE_INPUT",
    session_type: "qodercli",
    task_id: "common",
    system: "top system",
    model_config: { key: "synthetic", is_vl: true, is_reasoning: true, max_input_tokens: 1234 },
  });
  expect(body.messages).toEqual([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "portable-1",
          type: "function",
          function: { name: "weather", arguments: '{"city":"雪"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "portable-1", content: "sunny" },
    { role: "system", content: "mid system" },
  ]);
  expect(body.session_id).not.toBe(request.conversationId);
  const h = Object.fromEntries(built.request.headers);
  expect(h["Cosy-Date"]).toBe("1700000001");
  const parts = h.Authorization?.split(".") ?? [];
  expect(parts[0]).toBe("Bearer COSY");
  expect(parts[2]).toBe(
    createHash("md5")
      .update(
        [
          parts[1],
          "wrapped",
          "1700000001",
          built.request.body,
          "/api/v2/service/pro/sse/agent_chat_generation",
        ].join("\n"),
      )
      .digest("hex"),
  );
  const next = input();
  next.requestId = "req-2";
  expect(JSON.parse(decodeBody(qoderCodec.buildRequest(next).request.body ?? "")).session_id).toBe(
    body.session_id,
  );
});

test("Qoder missing credential fails AUTH and fallback builds remain deterministic", () => {
  const i = input();
  i.credentials.accessToken = "raw-invalid-token";
  expect(() => qoderCodec.buildRequest(i)).toThrow(GatewayError);
  const fallback = input();
  delete (fallback as Partial<typeof fallback>).requestId;
  delete (fallback as Partial<typeof fallback>).requestStartedAt;
  const built = qoderCodec.buildRequest(fallback);
  expect(qoderCodec.buildRequest(fallback)).toEqual(built);
  expect(Object.fromEntries(built.request.headers)["Cosy-Date"]).toBe("1700000000");
  expect(JSON.parse(decodeBody(built.request.body ?? "")).request_id).toMatch(/^[a-f0-9-]{36}$/);
});

test("Qoder wire exposes supported vision/tools and records unsupported features", () => {
  const i = input();
  i.request.tools = [{ kind: "portable", name: "weather", inputSchema: { type: "object" } }];
  i.request.maxTokens = 777;
  i.request.temperature = 0.2;
  i.request.toolChoice = { type: "tool", name: "weather" };
  i.request.messages.push({
    role: "user",
    content: [
      { type: "image", mediaType: "image/png", data: "synthetic-base64" },
      { type: "text", text: "look", cacheControl: { type: "ephemeral" } },
    ],
  });
  i.request.reasoning = { mode: "adaptive", effort: "high" };
  const result = qoderCodec.buildRequest(i);
  const wire = JSON.parse(decodeBody(result.request.body ?? ""));
  expect(wire.tools).toEqual([
    {
      type: "function",
      function: { name: "weather", description: "", parameters: { type: "object" } },
    },
  ]);
  expect(wire.parameters).toMatchObject({
    max_tokens: 777,
    temperature: 0.2,
    tool_choice: { type: "function", function: { name: "weather" } },
  });
  expect(wire.messages.at(-1).content[0]).toEqual({
    type: "image_url",
    image_url: { url: "data:image/png;base64,synthetic-base64" },
  });
  expect(result.degradations).toContain("qoder:cache-control-dropped");
  expect(result.degradations).toContain("qoder:reasoning-config-dropped");
});

function body(data: string) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(data);
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
}
async function events(data: string) {
  return Array.fromAsync(
    qoderCodec.decode({ body: body(data), fail, headers: new Headers(), decodeState: undefined }),
  );
}
const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;

test("Qoder business codes reject empty or partial success without leaking upstream messages", async () => {
  for (const prefix of ["", frame({ choices: [{ delta: { content: "partial" } }] })]) {
    for (const code of [403, "403"]) {
      await expect(
        events(
          `${prefix}${frame({ code, message: "sensitive-upstream", usage: {} })}data: [DONE]\n\n`,
        ),
      ).rejects.toMatchObject({ code: "UPSTREAM", message: "Qoder business error" });
    }
  }
  expect(
    (await events(`${frame({ code: "0", choices: [], usage: {} })}data: [DONE]\n\n`)).at(-1)?.type,
  ).toBe("end");
});

test("Qoder enveloped control frames behave like direct controls", async () => {
  const result = await events(
    frame({ statusCodeValue: 200, body: "[NOT_EXCEED_QUOTA]" }) +
      frame({ statusCodeValue: 200, body: '[NOTIFICATIONS]#{"notifications":[]}' }) +
      frame({ choices: [{ delta: { content: "ok" } }] }) +
      frame({ statusCodeValue: 200, body: "[DONE]" }),
  );
  expect(result.at(-1)?.type).toBe("end");
  await expect(
    events(frame({ statusCodeValue: 200, body: "[EXCEED_QUOTA]" })),
  ).rejects.toMatchObject({ code: "RATE_LIMIT" });
});

test("Qoder accumulates split tool identities before emitting complete correlated blocks", async () => {
  const result = await events(
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-split" }] } }] }) +
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      "data: [DONE]\n\n",
  );
  expect(result).toContainEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "call-split", name: "weather" },
  });
  await expect(
    events(
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "incomplete" }] } }] }) +
        "data: [DONE]\n\n",
    ),
  ).rejects.toMatchObject({ code: "UPSTREAM" });
});

test("Qoder top-level cache creation is disjoint from ordinary prompt usage", async () => {
  const result = await events(
    `${frame({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 3,
        cache_creation_input_tokens: 40,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    })}data: [DONE]\n\n`,
  );
  expect(result.at(-1)).toMatchObject({
    usage: { inputTokens: 50, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 40 },
  });
});

test("Qoder split SSE decodes envelopes, reasoning, tools and disjoint cache usage", async () => {
  const result = await events(
    "data: [NOT_EXCEED_QUOTA]\n\ndata: [NOTIFICATIONS]#info\n\n" +
      frame({ choices: [{ delta: { reasoning_content: "think" } }] }) +
      frame({
        statusCodeValue: 200,
        body: JSON.stringify({ choices: [{ delta: { content: "hello 雪" } }] }),
      }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "weather", arguments: '{"city":' } },
              ],
            },
          },
        ],
      }) +
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"雪"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      frame({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 4 },
        },
        choices: [],
      }) +
      "data: [DONE]\n\n",
  );
  expect(result).toContainEqual({
    type: "blockStart",
    index: 0,
    block: { type: "thinking", signed: false },
  });
  expect(result).toContainEqual({
    type: "blockStart",
    index: 2,
    block: { type: "toolUse", id: "call-1", name: "weather" },
  });
  expect(result.at(-1)).toEqual({
    type: "end",
    stopReason: "toolUse",
    usage: { inputTokens: 6, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

test("Qoder malformed, quota, business-error and truncated streams never silently succeed", async () => {
  for (const data of [
    "data: [EXCEED_QUOTA]\n\n",
    "data: not-json\n\n",
    frame({ statusCodeValue: 403, body: "sensitive" }),
    frame({ error: { code: "bad", message: "sensitive" } }),
    frame({ choices: [{ delta: { content: "partial" } }] }),
  ]) {
    await expect(events(data)).rejects.toBeInstanceOf(GatewayError);
  }
  await expect(
    events(`${frame({ choices: [{ delta: { content: "partial" } }] })}data: [EXCEED_QUOTA]\n\n`),
  ).rejects.toMatchObject({ code: "RATE_LIMIT" });
});

test("Qoder interleaved tool deltas stay inside their own open content blocks", async () => {
  const result = await events(
    frame({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "a", function: { name: "one", arguments: "{" } },
              { index: 1, id: "b", function: { name: "two", arguments: "{" } },
            ],
          },
        },
      ],
    }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: "}" } },
                { index: 0, function: { arguments: "}" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      "data: [DONE]\n\n",
  );
  let current: number | null = null;
  for (const event of result) {
    if (event.type === "blockStart") {
      expect(current).toBeNull();
      current = event.index;
    }
    if (event.type === "blockDelta") expect(event.index as number | null).toBe(current);
    if (event.type === "blockEnd") {
      expect(event.index as number | null).toBe(current);
      current = null;
    }
  }
  expect(current).toBeNull();
});
