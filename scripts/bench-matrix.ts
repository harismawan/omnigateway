import { completeBody } from "./bench-integrity";
import { probeText } from "./bench-probe";

export const allProviders = [
  {
    id: "openai-key",
    provider: "openai",
    protocol: "apiKey",
    nearest: "responses",
    origin: "https://api.openai.com",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "openai-oauth",
    provider: "openai",
    protocol: "oauth",
    nearest: "responses",
    origin: "https://api.openai.com",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "custom-chat",
    provider: "custom",
    protocol: "chat-completions",
    nearest: "chat",
    origin: "http://127.0.0.1:18100",
    script: "bench-gateway-upstream.ts",
  },
  {
    id: "custom-responses",
    provider: "custom",
    protocol: "responses",
    nearest: "responses",
    origin: "http://127.0.0.1:18100",
    script: "bench-gateway-upstream.ts",
  },
  {
    id: "anthropic-key",
    provider: "anthropic",
    protocol: "apiKey",
    nearest: "messages",
    origin: "https://api.anthropic.com",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "anthropic-oauth",
    provider: "anthropic",
    protocol: "oauth",
    nearest: "messages",
    origin: "https://api.anthropic.com",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "kimi-key",
    provider: "kimi",
    protocol: "apiKey",
    nearest: "chat",
    origin: "https://api.kimi.com",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "kilo-key",
    provider: "kilo",
    protocol: "apiKey",
    nearest: "chat",
    origin: "https://api.kilo.ai",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "grok-key",
    provider: "grok",
    protocol: "apiKey",
    nearest: "responses",
    origin: "https://api.x.ai",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "muse-key",
    provider: "muse",
    protocol: "apiKey",
    nearest: "responses",
    origin: "https://api.meta.ai",
    script: "bench-anthropic-upstream.ts",
  },
  {
    id: "qoder-oauth",
    provider: "qoder",
    protocol: "oauth",
    nearest: "chat",
    origin: "https://api2.qoder.sh",
    script: "bench-anthropic-upstream.ts",
  },
] as const;
export const ingresses = {
  chat: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};
export type Ingress = keyof typeof ingresses;
export type MatrixMeta = { provider: string; ingress: Ingress; mode: "json" | "stream" };
export type Verdict = { classification: "supported" | "unsupported" | "failed"; reason: string };

export function matches(name: string, only?: string): boolean {
  return (
    only === undefined ||
    only.split(",").some((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(name);
    })
  );
}

export function matrixScenarios() {
  return allProviders.flatMap((provider) => {
    const make = (
      ingress: Ingress,
      mode: "json" | "stream",
      suffix = `${ingress}.${mode}`,
      chunks = 1,
      concurrency = 64,
    ) => ({
      name: `${provider.id}.${suffix}`,
      what: `${provider.id} → ${ingress} ${mode}, ${chunks} chunks`,
      provider: provider.id,
      ingress,
      mode,
      path: ingresses[ingress],
      key: "plain" as const,
      concurrency,
      body: JSON.stringify({
        ...(ingress === "chat" && mode === "stream"
          ? { stream_options: { include_usage: true } }
          : {}),
        model: `${provider.id}-c${chunks}`,
        stream: mode === "stream",
        max_tokens: 8192,
        ...(ingress === "responses"
          ? { input: "Say something short." }
          : { messages: [{ role: "user", content: "Say something short." }] }),
      }),
    });
    return [
      ...Object.keys(ingresses).flatMap((ingress) => [
        make(ingress as Ingress, "json"),
        make(ingress as Ingress, "stream"),
      ]),
      make(provider.nearest, "stream", "overhead-c1", 1, 1),
      make(provider.nearest, "stream", "chunks-2000", 2000, 16),
    ];
  });
}

export function responseVerdict(
  meta: MatrixMeta,
  status: number,
  contentType: string,
  text: string,
): Verdict {
  if (status !== 200) {
    return {
      classification: [400, 404, 405, 422, 501].includes(status) ? "unsupported" : "failed",
      reason: `HTTP ${status}: ${text.slice(0, 400)}`,
    };
  }
  try {
    if (meta.mode === "json") {
      if (!contentType.includes("application/json")) throw Error("expected application/json");
      const body = JSON.parse(text);
      const content =
        meta.ingress === "chat"
          ? body.choices?.[0]?.message?.content
          : meta.ingress === "messages"
            ? body.content
                ?.filter((x: { type: string }) => x.type === "text")
                .map((x: { text: string }) => x.text)
                .join("")
            : body.output
                ?.flatMap((x: { content?: { text?: string }[] }) => x.content ?? [])
                .map((x: { text?: string }) => x.text ?? "")
                .join("");
      if (typeof content !== "string" || !content.includes("lorem ipsum"))
        throw Error("missing content in expected JSON shape");
    } else {
      if (!contentType.includes("text/event-stream")) throw Error("expected text/event-stream");
      const frames = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== "[DONE]")
        .map((line) => JSON.parse(line));
      const valid = frames.some((body) =>
        meta.ingress === "chat"
          ? body.choices?.[0]?.delta?.content?.includes("lorem ipsum")
          : meta.ingress === "messages"
            ? body.type === "content_block_delta" && body.delta?.text?.includes("lorem ipsum")
            : body.type === "response.output_text.delta" && body.delta?.includes("lorem ipsum"),
      );
      if (!valid) throw Error("missing content in expected SSE shape");
      if (
        frames.some(
          (body) => body.error || body.type === "error" || body.type === "response.failed",
        )
      )
        throw Error("error in SSE stream");
      const completed =
        meta.ingress === "chat"
          ? text.includes("data: [DONE]")
          : frames.some(
              (body) =>
                body.type === (meta.ingress === "messages" ? "message_stop" : "response.completed"),
            );
      if (!completed) throw Error("missing stream terminator");
    }
    return { classification: "supported", reason: "response shape passed" };
  } catch (error) {
    return { classification: "failed", reason: String(error) };
  }
}

export async function matrixSmoke(
  base: string,
  key: string,
  scenario: MatrixMeta & { path: string; body: string },
): Promise<Verdict & { bytes?: number }> {
  try {
    const response = await probeText(`${base}${scenario.path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: scenario.body,
    });
    const verdict = responseVerdict(
      scenario,
      response.status,
      response.headers.get("content-type") ?? "",
      response.text,
    );
    if (verdict.classification === "supported")
      completeBody(
        scenario,
        response.text,
        Number(/-c(\d+)$/.exec(JSON.parse(scenario.body).model)?.[1] ?? 1),
      );
    return { ...verdict, bytes: Buffer.byteLength(response.text) };
  } catch (error) {
    return { classification: "failed", reason: String(error) };
  }
}
