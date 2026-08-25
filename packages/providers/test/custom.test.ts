import { describe, expect, test } from "bun:test";
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

async function sentFor(
  protocol: "chat_completions" | "responses",
  extraData: Record<string, unknown> = {},
): Promise<HttpRequest> {
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
        ...extraData,
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

// Base paths exist so reverse-proxied servers (`https://host/api`) are
// expressible. A base ending in `/v1` already says where the API lives, and a
// blind append would double it; bare-origin rows predate basePath entirely.
describe("custom adapter joins stored base paths", () => {
  const cases = [
    {
      name: "path sits between origin and /v1",
      basePath: "/api",
      url: "http://localhost:8000/api/v1/chat/completions",
    },
    {
      name: "a /v1-ending path is not doubled",
      basePath: "/v1",
      url: "http://localhost:8000/v1/chat/completions",
    },
    {
      name: "deep paths join verbatim",
      basePath: "/llm/prod",
      url: "http://localhost:8000/llm/prod/v1/chat/completions",
    },
    {
      name: "responses swaps only the suffix",
      basePath: "/api",
      protocol: "responses" as const,
      url: "http://localhost:8000/api/v1/responses",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const sent = await sentFor(c.protocol ?? "chat_completions", { basePath: c.basePath });
      expect(sent.url).toBe(c.url);
    });
  }
});

test("registry includes custom provider", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual([
    "anthropic",
    "custom",
    "grok",
    "kilo",
    "kimi",
    "openai",
  ]);
});
