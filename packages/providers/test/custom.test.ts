import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { customAdapter } from "../src/custom/index.ts";
import type { HttpRequest } from "../src/index.ts";
import { ADAPTERS } from "../src/registry.ts";

const request: ChatRequest = {
  model: "local",
  system: [{ type: "text", text: "be terse" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: false,
};

const response = () => ({
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
  text: async () => "",
});

async function sentFor(protocol: "chat_completions" | "responses"): Promise<HttpRequest> {
  let sent: HttpRequest | null = null;
  await customAdapter.send({
    request,
    model: "upstream-model",
    credentials: {
      accessToken: null,
      apiKey: "test-provider-key",
      providerData: {
        endpointId: "local",
        endpointLabel: "Local",
        origin: "http://localhost:8000",
        protocol,
      },
    },
    http: async (value) => {
      sent = value;
      return response();
    },
    signal: new AbortController().signal,
  });
  if (sent === null) throw new Error("adapter did not send request");
  return sent;
}

test("custom chat completions uses endpoint origin without Kimi headers", async () => {
  const sent = await sentFor("chat_completions");

  expect(sent.url).toBe("http://localhost:8000/v1/chat/completions");
  expect(sent.headers).toContainEqual(["Authorization", "Bearer test-provider-key"]);
  expect(sent.headers.map(([name]) => name.toLowerCase())).not.toContain("x-msh-device-id");
  expect(JSON.parse(sent.body)).toMatchObject({ model: "upstream-model", stream: true });
});

test("custom chat degradations do not identify Kimi", async () => {
  const result = await customAdapter.send({
    request: { ...request, reasoning: { mode: "adaptive", effort: "high" } },
    model: "upstream-model",
    credentials: {
      accessToken: null,
      apiKey: "test-provider-key",
      providerData: { origin: "https://example.com", protocol: "chat_completions" },
    },
    http: async () => response(),
    signal: new AbortController().signal,
  });

  expect(result.degradations).toContain("custom:reasoning-dropped");
  expect(result.degradations.some((value) => value.startsWith("kimi:"))).toBe(false);
});

test("custom responses uses endpoint origin without Codex behavior", async () => {
  const sent = await sentFor("responses");

  expect(sent.url).toBe("http://localhost:8000/v1/responses");
  expect(sent.headers).toEqual([
    ["Content-Type", "application/json"],
    ["Authorization", "Bearer test-provider-key"],
  ]);
  expect(sent.body).not.toContain("chatgpt");
});

test("registry includes custom provider", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(["anthropic", "custom", "kimi", "openai"]);
});
