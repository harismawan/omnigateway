import type { HeaderPair, HttpClient, HttpResponse } from "@omni/providers";

/** One scripted upstream response. */
export type StubResponse =
  | { kind: "sse"; events: { event: string; data: unknown }[] }
  | { kind: "json"; status: number; body: unknown }
  | { kind: "error"; status: number; body: unknown; retryAfter?: string };

export type UpstreamCall = {
  url: string;
  authorization: string | null;
  /** Ordered and cased exactly as the adapter emitted them. */
  headers: readonly HeaderPair[];
  /** The serialized body, byte for byte. `cch=` is verified against this. */
  rawBody: string;
  body: unknown;
};

export type StubUpstream = {
  http: HttpClient;
  /** Queue a response. Consumed in order; the last one repeats. */
  queue(response: StubResponse): void;
  calls: UpstreamCall[];
};

/** Case-insensitive lookup over the ordered pairs. */
export function header(call: UpstreamCall, name: string): string | null {
  const found = call.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return found === undefined ? null : found[1];
}

/** Header names in wire order, cased as sent. */
export function headerNames(call: UpstreamCall): string[] {
  return call.headers.map(([k]) => k);
}

function sseBody(events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

function respond(status: number, body: string, headers: Record<string, string>): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new Response(body).body,
    text: async () => body,
  };
}

export function createStubUpstream(): StubUpstream {
  const queued: StubResponse[] = [];
  const calls: UpstreamCall[] = [];

  const http: HttpClient = async (req) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      parsed = null;
    }
    const auth = req.headers.find(([k]) => k.toLowerCase() === "authorization");
    calls.push({
      url: req.url,
      authorization: auth === undefined ? null : auth[1],
      headers: req.headers,
      rawBody: req.body,
      body: parsed,
    });

    const response = queued.length > 1 ? queued.shift() : queued[0];
    if (response === undefined) throw new Error("stub upstream received an unexpected call");

    if (response.kind === "sse") {
      // A real provider streams only when the request asked it to. Returning
      // SSE unconditionally would let an adapter that forgot `stream: true`
      // pass every test here and then fail against the live API, which is
      // exactly how the Anthropic non-streaming path stayed broken.
      const askedToStream =
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { stream?: unknown }).stream === true;
      if (!askedToStream) {
        return respond(200, JSON.stringify({ type: "message", content: [] }), {
          "content-type": "application/json",
        });
      }
      return respond(200, sseBody(response.events), { "content-type": "text/event-stream" });
    }
    if (response.kind === "json") {
      return respond(response.status, JSON.stringify(response.body), {
        "content-type": "application/json",
      });
    }
    return respond(response.status, JSON.stringify(response.body), {
      "content-type": "application/json",
      ...(response.retryAfter === undefined ? {} : { "retry-after": response.retryAfter }),
    });
  };

  return { http, queue: (r) => queued.push(r), calls };
}

/** A complete Anthropic streaming response in the provider's own wire format. */
export const ANTHROPIC_STREAM: StubResponse = {
  kind: "sse",
  events: [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_upstream",
          model: "claude-opus-4",
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ],
};
