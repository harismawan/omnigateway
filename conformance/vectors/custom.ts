/**
 * Vectors for the custom provider, the SSE parser and the outbound HTTP wire.
 *
 * Imported by `export.ts`. Every output is produced by calling the real TS
 * function — `customAdapter.send` (which runs `codecAdapter`, the wire encoders,
 * `parseSse` and the decoders), `parseSse`, `httpError`, `parseRetryAfter` and
 * `nodeHttpClient` against a raw listener — never by restating the algorithm.
 */
import type { ChatRequest, StreamEvent } from "../../packages/ir/src/index.ts";
import { GatewayError } from "../../packages/ir/src/index.ts";
import { customAdapter } from "../../packages/providers/src/custom/index.ts";
import { httpError, parseRetryAfter } from "../../packages/providers/src/http.ts";
import { nodeHttpClient } from "../../packages/providers/src/http-client.ts";
import { MAX_RECORD_CHARS, parseSse } from "../../packages/providers/src/sse.ts";
import type {
  AdapterCredentials,
  HttpRequest,
  HttpResponse,
} from "../../packages/providers/src/types.ts";

/**
 * A chunk of a byte stream: UTF-8 text, raw bytes, or `text` repeated `count`
 * times (so a 10 MiB record costs a few bytes in the vector file).
 */
type Chunk =
  | string
  | { bytes: number[] }
  | { repeat: string; count: number }
  /** Several pieces delivered as one chunk. */
  | { concat: Chunk[] };

function chunkBytes(chunk: Chunk): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if ("bytes" in chunk) return new Uint8Array(chunk.bytes);
  if ("concat" in chunk) return Buffer.concat(chunk.concat.map((c) => Buffer.from(chunkBytes(c))));
  return new TextEncoder().encode(chunk.repeat.repeat(chunk.count));
}

function streamOf(chunks: readonly Chunk[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunkBytes(chunk));
      c.close();
    },
  });
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Long data is summarised so the vector file stays small. */
function describeData(data: string): unknown {
  if (data.length <= 2000) return data;
  return { length: data.length, sha256: sha256(data) };
}

function describeError(error: unknown): unknown {
  if (error instanceof GatewayError) {
    return {
      gatewayError: true,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      provider: error.provider ?? null,
      upstreamStatus: error.upstreamStatus ?? null,
      gatewayAuthored: error.gatewayAuthored,
      retryAfterMs: error.retryAfterMs ?? null,
      degradations: [...error.degradations],
    };
  }
  return { gatewayError: false, name: (error as Error)?.name ?? String(error) };
}

// ---------------------------------------------------------------- SSE parser

const SSE_CASES: { name: string; chunks: Chunk[] }[] = [
  {
    name: "event and data pairs",
    chunks: ['event: message_start\ndata: {"a":1}\n\nevent: ping\ndata: {}\n\n'],
  },
  { name: "split mid-field", chunks: ["event: msg\nda", 'ta: {"x":', "2}\n\n"] },
  { name: "default event", chunks: ["data: hello\n\n"] },
  { name: "multi-line data", chunks: ["data: line1\ndata: line2\n\n"] },
  { name: "comments", chunks: [": keep-alive\n\ndata: real\n\n:x\n"] },
  { name: "crlf", chunks: ["event: e\r\ndata: d\r\n\r\n"] },
  { name: "trailing record without blank line", chunks: ["data: last"] },
  { name: "lf lf", chunks: ["data: one\n\ndata: two\n\n"] },
  { name: "crlf crlf", chunks: ["data: one\r\n\r\ndata: two\r\n\r\n"] },
  { name: "lf crlf", chunks: ["data: one\n\r\ndata: two\n\r\n"] },
  { name: "crlf lf", chunks: ["data: one\r\n\ndata: two\r\n\n"] },
  { name: "bare cr kept", chunks: ["data: a\r", "b\n\n"] },
  { name: "bare cr kept across three", chunks: ["data: a\r", "b", "c\n\n"] },
  { name: "final cr is a terminator", chunks: ["data: a", "\r"] },
  { name: "one char per chunk", chunks: "data: a\r\n\r\ndata: b\n\n".split("") },
  { name: "no space after colon", chunks: ["data:x\nevent:e\n\n"] },
  { name: "two spaces after colon", chunks: ["data:  x\n\n"] },
  { name: "field without colon", chunks: ["data\nevent\n\n"] },
  { name: "empty event name", chunks: ["event:\ndata: x\n\n"] },
  { name: "event without data is dropped", chunks: ["event: lonely\n\ndata: kept\n\n"] },
  { name: "id and retry ignored", chunks: ["id: 7\nretry: 100\ndata: x\nfoo: bar\n\n"] },
  { name: "last event line wins", chunks: ["event: a\nevent: b\ndata: x\n\n"] },
  { name: "colon inside value", chunks: ["data: a: b: c\n\n"] },
  { name: "empty data line", chunks: ["data:\ndata:\n\n"] },
  { name: "many separators", chunks: ["\n\n\n\ndata: x\n\n\n\n\r\n\r\n"] },
  {
    name: "utf8 split across chunks",
    chunks: [
      { bytes: [0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe6, 0x97] },
      { bytes: [0xa5, 0xf0, 0x9f] },
      { bytes: [0x98, 0x80, 0x0a, 0x0a] },
    ],
  },
  {
    name: "invalid utf8 replaced",
    chunks: [
      {
        bytes: [
          0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0x80, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0xff, 0x41, 0x0a,
          0x0a,
        ],
      },
    ],
  },
  {
    name: "incomplete utf8 at eof dropped",
    chunks: [{ bytes: [0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0x41, 0xe2, 0x82] }],
  },
  {
    name: "incomplete utf8 then invalid",
    chunks: [
      { bytes: [0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xe2, 0x82] },
      { bytes: [0x41, 0x0a, 0x0a] },
    ],
  },
  { name: "leading bom stripped", chunks: [{ bytes: [0xef, 0xbb, 0xbf] }, "data: x\n\n"] },
  {
    name: "split bom stripped",
    chunks: [{ bytes: [0xef] }, { bytes: [0xbb] }, { bytes: [0xbf, 0x64] }, "ata: x\n\n"],
  },
  {
    name: "second bom kept",
    chunks: [{ bytes: [0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf] }, "data: x\n\n"],
  },
  { name: "bom later kept", chunks: ["data: ", { bytes: [0xef, 0xbb, 0xbf] }, "\n\n"] },
  { name: "empty chunks", chunks: ["", "data: x", "", "\n", "", "\n"] },
  { name: "empty stream", chunks: [] },
  { name: "only comment", chunks: [": hi"] },
  {
    name: "large record in 64 char chunks",
    chunks: (() => {
      const whole = `event: big\r\ndata: ${"x".repeat(50_000)}\r\n\r\n`;
      const out: string[] = [];
      for (let at = 0; at < whole.length; at += 64) out.push(whole.slice(at, at + 64));
      return out;
    })(),
  },
  // The cap, measured in UTF-16 code units as JS counts them.
  {
    name: "cap: complete record exactly at the cap",
    chunks: ["data: ", { repeat: "w", count: MAX_RECORD_CHARS - 6 }, "\n\n"],
  },
  {
    name: "cap: complete record one past the cap",
    chunks: ["data: ", { repeat: "w", count: MAX_RECORD_CHARS - 5 }, "\n\n"],
  },
  {
    name: "cap: complete record past the cap in one chunk",
    chunks: [{ concat: ["data: ", { repeat: "y", count: MAX_RECORD_CHARS + 10 }, "\n\n"] }],
  },
  {
    name: "cap: accumulating record past the cap",
    chunks: ["data: ", ...Array.from({ length: 11 }, () => ({ repeat: "x", count: 1024 * 1024 }))],
  },
  {
    name: "cap: accumulating exactly at the cap then complete",
    chunks: [{ repeat: "a", count: MAX_RECORD_CHARS - 1 }, "\n", "\n"],
  },
  {
    name: "cap: accumulating one past with pending newline",
    chunks: [{ repeat: "a", count: MAX_RECORD_CHARS }, "\n", "\n"],
  },
  {
    name: "cap: astral characters count twice",
    chunks: ["data: ", { repeat: "😀", count: (MAX_RECORD_CHARS - 6) / 2 }, "\n\n"],
  },
  {
    name: "cap: astral one unit over",
    chunks: ["data:", { repeat: "😀", count: (MAX_RECORD_CHARS - 4) / 2 }, "\n\n"],
  },
  {
    name: "cap: records before the oversized one survive",
    chunks: [
      "data: first\n\ndata: ",
      ...Array.from({ length: 11 }, () => ({ repeat: "q", count: 1024 * 1024 })),
    ],
  },
  {
    name: "cap: per record not per stream",
    chunks: (() => {
      const half = { repeat: "z", count: 64 * 1024 };
      const out: Chunk[] = [];
      for (let i = 0; i < Math.ceil(MAX_RECORD_CHARS / (64 * 1024)) + 5; i++) {
        out.push("data: ", half, { repeat: "z", count: 64 * 1024 }, "\n\n");
      }
      return out;
    })(),
  },
];

async function sseVectors(): Promise<unknown[]> {
  const out = [];
  for (const c of SSE_CASES) {
    const messages: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const m of parseSse(streamOf(c.chunks))) {
        messages.push({ event: m.event, data: describeData(m.data) });
      }
    } catch (e) {
      error = describeError(e);
    }
    out.push({ name: c.name, chunks: c.chunks, messages, error });
  }
  return out;
}

// --------------------------------------------------------------- wire encode

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const deepSchema = (levels: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < levels; i++) node = { type: "object", properties: { n: node } };
  return node;
};

const user = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
});

const REQUESTS: { name: string; request: ChatRequest }[] = [
  { name: "minimal", request: { model: "pool", messages: [user("hi")], stream: true } },
  {
    name: "non-streaming client",
    request: { model: "pool", messages: [user("hi")], stream: false },
  },
  {
    name: "system tools sampling",
    request: {
      model: "pool",
      system: [
        { type: "text", text: "be terse" },
        { type: "text", text: "and kind", cacheControl: { type: "ephemeral", ttl: "1h" } },
      ],
      messages: [
        user("hi"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "yo" },
            { type: "text", text: "two" },
          ],
        },
        user("again"),
      ],
      tools: [
        {
          kind: "portable",
          name: "read_file",
          description: "Reads",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          kind: "portable",
          name: "no_desc",
          inputSchema: { type: "object", "10": 1, "2": 2, b: 3 },
        },
      ],
      toolChoice: { type: "auto" },
      maxTokens: 4096,
      temperature: 0.7,
      stopSequences: ["END", "\u2028"],
      stream: true,
    },
  },
  {
    name: "tool round trip with files and images",
    request: {
      model: "pool",
      messages: [
        user("read it"),
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm", signature: "sig" },
            { type: "text", text: "calling" },
            { type: "text", text: "now" },
            {
              type: "toolUse",
              id: "call_1",
              name: "read_file",
              input: {
                path: "a.txt",
                n: 1.5,
                big: 1e21,
                nested: { "10": 1, b: 2, "1": [true, null] },
              },
            },
            { type: "toolUse", id: "call_2", name: "noop", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "call_1",
              content: "contents",
              images: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }],
              files: [
                { type: "file", mediaType: "text/plain", data: b64("plain text 日本") },
                { type: "file", mediaType: "Text/Markdown; charset=utf-8", data: b64("# md") },
                { type: "file", mediaType: "application/pdf", data: "JVBERi0=" },
                {
                  type: "file",
                  mediaType: "application/pdf",
                  data: "JVBERi0=",
                  filename: "doc.pdf",
                },
                { type: "file", mediaType: "image/gif", data: "R0lGOD==" },
                { type: "file", mediaType: "application/vnd+json", data: b64('{"a":1}') },
              ],
            },
            { type: "toolResult", toolUseId: "call_2", content: "", isError: true },
            { type: "text", text: "thanks" },
          ],
        },
      ],
      stream: true,
    },
  },
  {
    name: "tool result with empty images and native parts",
    request: {
      model: "pool",
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "t", name: "x", input: [1, "a"] }] },
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "t",
              content: "r",
              images: [],
              files: [],
              native: [
                {
                  type: "providerNative",
                  provider: "anthropic",
                  blockType: "search_result",
                  data: { a: 1 },
                },
              ],
            },
          ],
        },
      ],
      stream: true,
    },
  },
  {
    name: "lenient base64 and odd file text",
    request: {
      model: "pool",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "toolResult",
              toolUseId: "t",
              content: "",
              files: [
                { type: "file", mediaType: "text/plain", data: "aGk" },
                { type: "file", mediaType: "text/plain", data: "aG k=garbage" },
                { type: "file", mediaType: "text/plain", data: "YWJjŁZA" },
                { type: "file", mediaType: "text/plain", data: "YWJj😀ZA" },
                { type: "file", mediaType: "text/plain", data: "-_-_" },
                { type: "file", mediaType: "text/plain", data: "77u/aGk=" },
                { type: "file", mediaType: "text/plain", data: "/w==" },
                { type: "file", mediaType: "text/plain", data: "Y" },
                { type: "file", mediaType: "text/plain", data: "" },
                { type: "file", mediaType: " application/JSON ;x", data: b64("{}") },
                { type: "file", mediaType: "application/x-ndjson", data: b64("1\n2") },
                { type: "file", mediaType: "text/plain", data: "YQ=x" },
                { type: "file", mediaType: "text/plain", data: "YW==ZA" },
                { type: "file", mediaType: "text/plain", data: "YWJjZAZ😀A" },
                { type: "file", mediaType: "text/plain", data: "řŗŊj" },
                { type: "file", mediaType: "text/plain", data: "YWJjZA==YQ" },
                { type: "file", mediaType: "text/plain", data: "YWJj=" },
                { type: "file", mediaType: "text/plain", data: "Y===" },
                { type: "file", mediaType: "text/plain", data: "=YWJj" },
                { type: "file", mediaType: "text/plain", data: "YWJjZAZAZA" },
                { type: "file", mediaType: "text/plain", data: "Y W J j Z A" },
              ],
            },
          ],
        },
      ],
      stream: true,
    },
  },
  {
    name: "images thinking native and system image",
    request: {
      model: "pool",
      system: [
        { type: "text", text: "sys" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "thinking", text: "t" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/jpeg", data: "/9j/" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "deep" },
            {
              type: "providerNative",
              provider: "anthropic",
              blockType: "server_tool_use",
              data: { id: "s", name: "web_search", input: {} },
            },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: [] },
        { role: "assistant", content: [{ type: "image", mediaType: "image/png", data: "BBBB" }] },
      ],
      stream: true,
    },
  },
  {
    name: "empty system",
    request: { model: "pool", system: [], messages: [user("x")], stream: true },
  },
  {
    name: "system of empty text",
    request: {
      model: "pool",
      system: [{ type: "text", text: "" }],
      messages: [user("x")],
      stream: true,
    },
  },
  {
    name: "mid conversation system turn",
    request: {
      model: "pool",
      system: [{ type: "text", text: "top" }],
      messages: [
        user("hi"),
        { role: "system", content: [{ type: "text", text: "Write Go." }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
      stream: false,
    },
  },
  ...(
    [
      ["adaptive high", { mode: "adaptive", effort: "high" }],
      ["adaptive xhigh", { mode: "adaptive", effort: "xhigh" }],
      ["adaptive max", { mode: "adaptive", effort: "max" }],
      ["adaptive none", { mode: "adaptive", effort: "none" }],
      ["adaptive default", { mode: "adaptive" }],
      ["adaptive omitted", { mode: "adaptive", effort: "low", display: "omitted" }],
      ["adaptive updates", { mode: "adaptive", display: "updates" }],
      ["adaptive summarized", { mode: "adaptive", effort: "minimal", display: "summarized" }],
      ["budget", { mode: "budget", budgetTokens: 4096 }],
      ["off", { mode: "off" }],
      ["between tools", { mode: "betweenTools" }],
    ] as const
  ).map(([name, reasoning]) => ({
    name: `reasoning ${name}`,
    request: { model: "pool", messages: [user("think")], stream: true, reasoning } as ChatRequest,
  })),
  ...(
    [
      ["any", { type: "any" }],
      ["none", { type: "none" }],
      ["tool", { type: "tool", name: "read_file" }],
    ] as const
  ).map(([name, toolChoice]) => ({
    name: `tool choice ${name}`,
    request: {
      model: "pool",
      messages: [user("x")],
      tools: [
        { kind: "portable", name: "read_file", inputSchema: { type: "object" } },
        {
          kind: "provider",
          provider: "anthropic",
          type: "web_search_20250305",
          name: "web_search",
          wire: { max_uses: 1 },
          family: "webSearch",
        },
      ],
      toolChoice,
      stream: true,
    } as ChatRequest,
  })),
  {
    name: "only provider tools",
    request: {
      model: "pool",
      messages: [user("x")],
      tools: [
        {
          kind: "provider",
          provider: "openai",
          type: "local_shell",
          name: "local_shell",
          wire: {},
        },
      ],
      stream: true,
    },
  },
  {
    name: "empty tools",
    request: { model: "pool", messages: [user("x")], tools: [], stream: true },
  },
  {
    name: "betas and opaque fields",
    request: {
      model: "pool",
      messages: [user("x")],
      betas: ["other-beta", "context-1m-2025-08-07"],
      conversationId: "conv",
      providerHeaders: { custom: { "x-a": "b" } },
      vendor: { anthropic: { metadata: { user_id: "u" } } },
      stream: true,
    },
  },
  {
    name: "vendor overrides",
    request: {
      model: "pool",
      messages: [user("x")],
      maxTokens: 10,
      reasoning: { mode: "adaptive", effort: "high" },
      vendor: {
        openai: {
          model: "override",
          stream: false,
          max_tokens: 5,
          "0": "idx",
          reasoning_effort: "low",
          reasoning: { effort: "low" },
          store: true,
          extra: { "2": 1, a: 2 },
        },
      },
      stream: true,
    },
  },
  {
    name: "vendor __proto__ key",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: JSON.parse('{"__proto__":{"a":1},"after":1}') as Record<string, unknown> },
      stream: true,
    },
  },
  {
    name: "chat response_format json_schema",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "thing",
              schema: { type: "object", properties: { a: { type: "string" } } },
              strict: true,
            },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "chat response_format nameless",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: { name: "", schema: { type: "object" } },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "responses text.format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          text: {
            verbosity: "low",
            format: { type: "json_schema", name: "fmt", schema: { type: "object" }, strict: true },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "text verbosity only",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { text: { verbosity: "low" } } },
      stream: true,
    },
  },
  {
    name: "text malformed format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { text: { verbosity: "high", format: { type: "json_schema" } } } },
      stream: true,
    },
  },
  {
    name: "text not an object",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { text: "plain" } },
      stream: true,
    },
  },
  {
    name: "anthropic output_config.format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        anthropic: {
          output_config: {
            format: { type: "json_schema", schema: { type: "object", properties: {} } },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "anthropic output_config without format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { anthropic: { output_config: { effort: "low" } } },
      stream: true,
    },
  },
  {
    name: "json_object",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { response_format: { type: "json_object" } } },
      stream: true,
    },
  },
  {
    name: "malformed response_format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { response_format: { type: "json_schema" } } },
      stream: true,
    },
  },
  {
    name: "response_format null",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: { openai: { response_format: null } },
      stream: true,
    },
  },
  {
    name: "schema too deep",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: { name: "d", schema: deepSchema(64) },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "schema just shallow enough",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: { name: "d", schema: deepSchema(63) },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "schema too deep via text.format",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          text: { format: { type: "json_schema", name: "d", schema: { anyOf: [deepSchema(63)] } } },
        },
      },
      stream: true,
    },
  },
  {
    name: "schema deep through every position kind",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        anthropic: {
          output_config: {
            format: {
              schema: (() => {
                const kinds = [
                  (n: unknown) => ({ items: n }),
                  (n: unknown) => ({ items: [1, n] }),
                  (n: unknown) => ({ properties: { a: n, b: 1 } }),
                  (n: unknown) => ({ $defs: { x: n } }),
                  (n: unknown) => ({ not: n }),
                  (n: unknown) => ({ dependencies: { a: ["b"], c: n } }),
                  (n: unknown) => ({ oneOf: [n] }),
                  (n: unknown) => ({ additionalProperties: n }),
                  (n: unknown) => ({ enum: [n] }),
                ];
                let node: unknown = { type: "string" };
                for (let i = 0; i < 70; i++) node = kinds[i % kinds.length]?.(node);
                return node as Record<string, unknown>;
              })(),
            },
          },
        },
      },
      stream: true,
    },
  },
  {
    name: "both spellings",
    request: {
      model: "pool",
      messages: [user("x")],
      vendor: {
        openai: {
          response_format: {
            type: "json_schema",
            json_schema: { name: "chat", schema: { type: "object" } },
          },
          text: { format: { type: "json_schema", name: "resp", schema: { type: "array" } } },
        },
      },
      stream: true,
    },
  },
  {
    name: "unicode text",
    request: {
      model: "pool",
      messages: [user('emoji 😀 \u2028 "quote" \\ \u0000 \u007f 日本')],
      stream: true,
    },
  },
];

const CREDENTIALS: { name: string; credentials: AdapterCredentials }[] = [
  {
    name: "bare origin",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: "https://host.test" } },
  },
  {
    name: "base path",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://host.test", basePath: "/api" },
    },
  },
  {
    name: "v1 base",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://host.test", basePath: "/api/v1" },
    },
  },
  {
    name: "v4 base",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://host.test", basePath: "/api/coding/paas/v4" },
    },
  },
  {
    name: "upper V2 with slashes",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "http://127.0.0.1:8080", basePath: "/x/V2//" },
    },
  },
  {
    name: "trailing slash origin",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "http://localhost:8000/" },
    },
  },
  {
    name: "v without digits",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://h", basePath: "/v" },
    },
  },
  {
    name: "v1 inside path",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://h", basePath: "/v1/x" },
    },
  },
  {
    name: "non-string basePath",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://h", basePath: 5 },
    },
  },
  {
    name: "origin with v1",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: "https://h/v1" } },
  },
  {
    name: "key with spaces",
    credentials: {
      accessToken: "ignored",
      apiKey: " sk-a b ",
      providerData: { origin: "https://h" },
    },
  },
  {
    name: "empty key",
    credentials: { accessToken: null, apiKey: "", providerData: { origin: "https://h" } },
  },
  {
    name: "no key",
    credentials: { accessToken: null, apiKey: null, providerData: { origin: "https://h" } },
  },
  {
    name: "origin not a string",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: 42 } },
  },
  {
    name: "unknown protocol",
    credentials: {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://h", protocolOverride: "grpc" },
    },
  },
  {
    name: "origin not a url",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: "not a url" } },
  },
  {
    name: "ftp origin",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: "ftp://h" } },
  },
  {
    name: "empty origin",
    credentials: { accessToken: null, apiKey: "ck", providerData: { origin: "" } },
  },
];

type Captured = {
  url: string;
  method: string;
  headers: [string, string][];
  body: string;
  provider: string;
};

type FakeResponse = { status: number; headers: [string, string][]; chunks: Chunk[] };

async function runAdapter(
  request: ChatRequest,
  credentials: AdapterCredentials,
  response: FakeResponse,
): Promise<unknown> {
  const sent: Captured[] = [];
  let result: Awaited<ReturnType<typeof customAdapter.send>> | undefined;
  try {
    result = await customAdapter.send({
      request,
      model: "m1",
      credentials,
      signal: new AbortController().signal,
      http: async (r: HttpRequest): Promise<HttpResponse> => {
        sent.push({
          url: r.url,
          method: r.method,
          headers: r.headers.map(([n, v]) => [n, v]),
          body: r.body,
          provider: r.provider,
        });
        const bytes = response.chunks.map(chunkBytes);
        const whole = Buffer.concat(bytes.map((b) => Buffer.from(b))).toString("utf8");
        return {
          status: response.status,
          headers: new Headers(response.headers),
          body: new ReadableStream({
            start(c) {
              for (const b of bytes) c.enqueue(b);
              c.close();
            },
          }),
          text: async () => whole,
        };
      },
    });
  } catch (e) {
    return {
      sent,
      sendError: describeError(e),
      degradations: null,
      events: null,
      streamError: null,
    };
  }
  const events: StreamEvent[] = [];
  let streamError: unknown = null;
  try {
    for await (const ev of result.events) events.push(ev);
  } catch (e) {
    streamError = describeError(e);
  }
  return { sent, sendError: null, degradations: result.degradations, events, streamError };
}

const DONE: FakeResponse = {
  status: 200,
  headers: [["content-type", "text/event-stream"]],
  chunks: ["data: [DONE]\n\n"],
};
const RESPONSES_DONE: FakeResponse = {
  status: 200,
  headers: [["content-type", "text/event-stream"]],
  chunks: [
    'event: response.completed\ndata: {"response":{"id":"r","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
  ],
};

async function encodeVectors(): Promise<unknown[]> {
  const out = [];
  for (const protocol of ["chat_completions", "responses"] as const) {
    for (const r of REQUESTS) {
      const credentials: AdapterCredentials = {
        accessToken: null,
        apiKey: "ck",
        providerData: { origin: "https://host.test", protocol },
      };
      const ran = await runAdapter(
        r.request,
        credentials,
        protocol === "responses" ? RESPONSES_DONE : DONE,
      );
      // As text: the deep-schema requests nest past serde_json's 128-level
      // recursion limit, which would make all of `vectors.json` unreadable.
      out.push({
        name: r.name,
        protocol,
        request: JSON.stringify(r.request),
        credentials,
        result: ran,
      });
    }
    for (const c of CREDENTIALS) {
      const providerData = { ...c.credentials.providerData };
      const override = providerData.protocolOverride;
      delete providerData.protocolOverride;
      const credentials = {
        ...c.credentials,
        providerData: { ...providerData, protocol: override ?? protocol },
      };
      const ran = await runAdapter(
        REQUESTS[0]?.request as ChatRequest,
        credentials,
        protocol === "responses" ? RESPONSES_DONE : DONE,
      );
      out.push({
        name: `credentials ${c.name}`,
        protocol,
        request: JSON.stringify(REQUESTS[0]?.request),
        credentials,
        result: ran,
      });
    }
  }
  return out;
}

// --------------------------------------------------------------- decode

const sse = (frames: (string | [string, string])[], done = true): string =>
  frames
    .map((f) => (typeof f === "string" ? `data: ${f}\n\n` : `event: ${f[0]}\ndata: ${f[1]}\n\n`))
    .join("") + (done ? "data: [DONE]\n\n" : "");

const CHAT_STREAMS: { name: string; chunks: Chunk[] }[] = [
  {
    name: "reasoning_content then text",
    chunks: [
      sse([
        '{"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"}}]}',
        '{"choices":[{"delta":{"reasoning_content":"think "}}]}',
        '{"choices":[{"delta":{"reasoning_content":"hard"}}]}',
        '{"choices":[{"delta":{"content":"answer"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      ]),
    ],
  },
  {
    name: "reasoning spellings precedence",
    chunks: [
      sse([
        '{"id":"c1","model":"m","choices":[{"delta":{"reasoning":"why","reasoning_content":"no","reasoning_details":[{"text":"no"}]}}]}',
        '{"choices":[{"delta":{"reasoning":"","reasoning_content":"rc"}}]}',
        '{"choices":[{"delta":{"reasoning":5,"reasoning_content":"","reasoning_details":[{"text":"de"},{"summary":"tailed"},null,7,{"text":""},{"type":"reasoning.encrypted","data":"blob"},{"text":3,"summary":"s"}]}}]}',
        '{"choices":[{"delta":{"reasoning_details":{"text":"not array"}}}]}',
        '{"choices":[{"delta":{"content":"so","reasoning":"after"}}]}',
        '{"choices":[{"delta":{"reasoning":"again"}}]}',
      ]),
    ],
  },
  {
    name: "tool call deltas split across chunks",
    chunks: (() => {
      const whole = sse([
        '{"id":"c","model":"m","choices":[{"delta":{"content":"let me"}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":""}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":1}"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"two","arguments":"{}"}},{"index":0,"function":{"arguments":"late"}}]}}]}',
        '{"choices":[{"delta":{"content":"after"}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30,"cache_creation_tokens":5}}}',
      ]);
      const out: string[] = [];
      for (let at = 0; at < whole.length; at += 7) out.push(whole.slice(at, at + 7));
      return out;
    })(),
  },
  {
    name: "tool call odd indices",
    chunks: [
      sse([
        '{"choices":[{"delta":{"tool_calls":[{"function":{"name":"noindex"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":"0","id":5,"function":{"name":["a","b"],"arguments":"x"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"y"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":{},"function":null}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":{},"function":"str"}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":null,"id":null}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":-0,"function":{"arguments":"z"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":1.5,"function":{"arguments":7}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":"ab"}}]}',
        '{"choices":[{"delta":{"tool_calls":""}}]}',
        '{"choices":[{"delta":{"tool_calls":null}}]}',
        '{"choices":[{"delta":{"tool_calls":[true,3]}}]}',
      ]),
    ],
  },
  {
    name: "tool_calls object throws",
    chunks: [sse(['{"id":"x","choices":[{"delta":{"content":"a","tool_calls":{}}}]}'])],
  },
  {
    name: "tool_calls null element throws",
    chunks: [sse(['{"choices":[{"delta":{"tool_calls":[null]}}]}'])],
  },
  { name: "tool_calls number throws", chunks: [sse(['{"choices":[{"delta":{"tool_calls":5}}]}'])] },
  {
    name: "usage spellings",
    chunks: [
      sse([
        '{"id":"u","usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":4}}',
        '{"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cache_write_tokens":2}}}',
        '{"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":null,"cache_creation_tokens":null,"cache_write_tokens":1},"prompt_cache_hit_tokens":6}}',
      ]),
    ],
  },
  {
    name: "usage clamped",
    chunks: [
      sse([
        '{"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":5}}}',
      ]),
    ],
  },
  {
    name: "usage zero is falsy",
    chunks: [
      sse([
        '{"usage":{"prompt_tokens":3,"completion_tokens":1}}',
        '{"usage":0}',
        '{"usage":""}',
        '{"usage":null}',
        '{"usage":false}',
      ]),
    ],
  },
  {
    name: "usage truthy non-object resets",
    chunks: [sse(['{"usage":{"prompt_tokens":3,"completion_tokens":1}}', '{"usage":"x"}'])],
  },
  {
    name: "usage array resets",
    chunks: [sse(['{"usage":{"prompt_tokens":3,"completion_tokens":1}}', '{"usage":[1]}'])],
  },
  {
    name: "usage fractional and large",
    chunks: [
      sse([
        '{"usage":{"prompt_tokens":1e21,"completion_tokens":0.5,"prompt_tokens_details":{"cached_tokens":1e-7}}}',
      ]),
    ],
  },
  {
    name: "usage string numbers",
    chunks: [
      sse([
        '{"usage":{"prompt_tokens":"12","completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}',
      ]),
    ],
  },
  {
    name: "usage numeric garbage",
    chunks: [sse(['{"usage":{"prompt_tokens":"abc","completion_tokens":3}}'])],
  },
  {
    name: "finish reasons",
    chunks: [
      sse([
        '{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}',
        '{"choices":[{"delta":{},"finish_reason":"length"}]}',
      ]),
    ],
  },
  {
    name: "finish content_filter",
    chunks: [sse(['{"choices":[{"finish_reason":"content_filter"}]}'])],
  },
  {
    name: "finish stop then tool_calls",
    chunks: [
      sse([
        '{"choices":[{"finish_reason":"stop"}]}',
        '{"choices":[{"finish_reason":"tool_calls"}]}',
      ]),
    ],
  },
  {
    name: "unknown finish reason",
    chunks: [
      sse([
        '{"id":"a","choices":[{"delta":{"content":"x"}}]}',
        '{"choices":[{"finish_reason":"made_up"}]}',
        '{"choices":[{"delta":{"content":"never"}}]}',
      ]),
    ],
  },
  {
    name: "prototype finish reason",
    chunks: [sse(['{"choices":[{"finish_reason":"constructor"}]}'])],
  },
  { name: "empty finish reason", chunks: [sse(['{"choices":[{"finish_reason":""}]}'])] },
  { name: "numeric finish reason ignored", chunks: [sse(['{"choices":[{"finish_reason":5}]}'])] },
  { name: "no done", chunks: [sse(['{"id":"a","choices":[{"delta":{"content":"x"}}]}'], false)] },
  { name: "empty stream", chunks: [] },
  { name: "done only", chunks: ["data: [DONE]\n\n"] },
  {
    name: "stuff after done ignored",
    chunks: [sse(['{"id":"a"}']), 'data: {"choices":[{"delta":{"content":"late"}}]}\n\n'],
  },
  {
    name: "start identity rules",
    chunks: [
      sse([
        '{"choices":[{"delta":{"content":"anon"}}]}',
        '{"id":null,"model":7}',
        '{"id":"second","model":"m"}',
      ]),
    ],
  },
  { name: "start with object id", chunks: [sse(['{"id":{"a":1},"model":[1,[2,null]]}'])] },
  { name: "start with model only", chunks: [sse(['{"model":"only"}'])] },
  {
    name: "non-json and non-object chunks skipped",
    chunks: [sse(["not json", '"string"', "5", "null", "[]", '[{"id":"x"}]', '{"id":"real"}'])],
  },
  {
    name: "choices shapes",
    chunks: [
      sse([
        '{"id":"a","choices":{"0":{"delta":{"content":"objkey"}}}}',
        '{"choices":"abc"}',
        '{"choices":[null,{"delta":{"content":"second"}}]}',
        '{"choices":[{"delta":null}]}',
        '{"choices":[{"delta":"str"}]}',
        '{"choices":[{"delta":{"content":5}}]}',
        '{"choices":[{"delta":{"content":""}}]}',
        '{"choices":[]}',
        '{"choices":0}',
      ]),
    ],
  },
  {
    name: "event names ignored on chat",
    chunks: [sse([["weird", '{"id":"a","choices":[{"delta":{"content":"x"}}]}']])],
  },
  {
    name: "done with event name",
    chunks: ['event: x\ndata: {"id":"a"}\n\nevent: y\ndata: [DONE]\n\n'],
  },
  {
    name: "multi-line data joined",
    chunks: ['data: {"id":"a",\ndata: "choices":[{"delta":{"content":"j"}}]}\n\ndata: [DONE]\n\n'],
  },
  {
    name: "lone surrogate escape",
    chunks: [
      sse([
        '{"id":"a","choices":[{"delta":{"content":"x\\ud83d"}}]}',
        '{"choices":[{"delta":{"content":"\\ud83d\\ude00"}}]}',
      ]),
    ],
  },
  {
    name: "duplicate keys last wins",
    chunks: [
      sse(['{"id":"first","id":"last","choices":[{"delta":{"content":"a","content":"b"}}]}']),
    ],
  },
];

const RESPONSES_STREAMS: { name: string; chunks: Chunk[] }[] = [
  {
    name: "reasoning summary then text",
    chunks: [
      sse(
        [
          ["response.created", '{"response":{"id":"resp-1","model":"m"}}'],
          ["response.output_item.added", '{"output_index":0,"item":{"type":"reasoning"}}'],
          ["response.reasoning_summary_text.delta", '{"output_index":0,"delta":"why"}'],
          ["response.output_item.done", '{"output_index":0}'],
          ["response.output_item.added", '{"output_index":1,"item":{"type":"message"}}'],
          ["response.content_part.added", '{"output_index":1,"part":{"type":"output_text"}}'],
          ["response.output_text.delta", '{"output_index":1,"delta":"so"}'],
          ["response.content_part.done", '{"output_index":1}'],
          ["response.output_item.done", '{"output_index":1}'],
          [
            "response.completed",
            '{"response":{"id":"resp-1","usage":{"input_tokens":3,"output_tokens":5}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "function call",
    chunks: [
      sse([
        ["response.created", '{"response":{"id":"r","model":"m"}}'],
        ["response.in_progress", "{}"],
        [
          "response.output_item.added",
          '{"output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"read"}}',
        ],
        ["response.function_call_arguments.delta", '{"output_index":0,"delta":"{\\"a\\""}'],
        ["response.function_call_arguments.delta", '{"output_index":0,"delta":":1}"}'],
        ["response.function_call_arguments.done", '{"output_index":0,"arguments":"{}"}'],
        ["response.output_item.done", '{"output_index":0}'],
        ["response.output_item.done", '{"output_index":0}'],
        [
          "response.completed",
          '{"response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":6}}}}',
        ],
      ]),
    ],
  },
  {
    name: "function call missing ids",
    chunks: [
      sse([
        ["response.output_item.added", '{"item":{"type":"function_call"}}'],
        [
          "response.output_item.added",
          '{"output_index":"1","item":{"type":"function_call","call_id":null,"name":5}}',
        ],
        ["response.function_call_arguments.delta", '{"output_index":1}'],
        ["response.output_item.done", '{"output_index":1}'],
        ["response.output_item.done", '{"output_index":"1"}'],
        [
          "response.completed",
          '{"response":{"usage":{"input_tokens":1,"output_tokens":1,"prompt_tokens_details":{"cached_tokens":1}}}}',
        ],
      ]),
    ],
  },
  {
    name: "index keys are strings",
    chunks: [
      sse([
        [
          "response.content_part.added",
          '{"output_index":"0","content_index":0,"part":{"type":"output_text"}}',
        ],
        ["response.output_text.delta", '{"output_index":0,"content_index":"0","delta":"a"}'],
        [
          "response.content_part.added",
          '{"output_index":0,"content_index":1,"part":{"type":"output_text"}}',
        ],
        ["response.output_text.delta", '{"output_index":0,"content_index":1,"delta":5}'],
        ["response.output_text.delta", '{"output_index":{},"delta":null}'],
        ["response.content_part.added", '{"output_index":2,"part":{"type":"refusal"}}'],
        ["response.content_part.done", '{"output_index":0,"content_index":1}'],
        ["response.completed", '{"response":{}}'],
      ]),
    ],
  },
  {
    name: "incomplete max tokens",
    chunks: [
      sse(
        [
          ["response.created", '{"response":{"id":"r","model":"m"}}'],
          [
            "response.incomplete",
            '{"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":9}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "incomplete content filter",
    chunks: [
      sse(
        [
          [
            "response.incomplete",
            '{"response":{"incomplete_details":{"reason":"content_filter"}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "incomplete unknown reason",
    chunks: [
      sse(
        [
          [
            "response.incomplete",
            '{"response":{"status":"incomplete","incomplete_details":{"reason":"tool_budget"}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "incomplete null reason",
    chunks: [
      sse([["response.incomplete", '{"response":{"incomplete_details":{"reason":null}}}']], false),
    ],
  },
  {
    name: "incomplete no reason",
    chunks: [sse([["response.incomplete", '{"response":{"status":"incomplete"}}']], false)],
  },
  { name: "incomplete empty payload", chunks: [sse([["response.incomplete", "{}"]], false)] },
  {
    name: "completed cancelled status",
    chunks: [sse([["response.completed", '{"response":{"status":"cancelled"}}']], false)],
  },
  {
    name: "completed numeric status",
    chunks: [sse([["response.completed", '{"response":{"status":3}}']], false)],
  },
  {
    name: "completed with incomplete status no reason",
    chunks: [sse([["response.completed", '{"response":{"status":"incomplete"}}']], false)],
  },
  {
    name: "completed unknown reason",
    chunks: [
      sse(
        [
          [
            "response.completed",
            '{"response":{"status":"completed","incomplete_details":{"reason":"weird"}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "failed with code",
    chunks: [
      sse(
        [
          ["response.created", '{"response":{"id":"r","model":"m"}}'],
          [
            "response.failed",
            '{"response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}',
          ],
          ["response.output_text.delta", '{"output_index":0,"delta":"after failure"}'],
        ],
        false,
      ),
    ],
  },
  {
    name: "error event types",
    chunks: [
      sse(
        [
          ["error", '{"error":{"type":"insufficient_quota","message":"pay"}}'],
          ["error", '{"error":{"code":"invalid_api_key"}}'],
          ["error", '{"error":{"code":"constructor","message":5}}'],
          ["error", '{"error":{"code":null,"type":null}}'],
          ["error", "{}"],
          [
            "error",
            '{"response":{"error":{"code":"context_length_exceeded"}},"error":{"code":"server_error"}}',
          ],
          ["error", '{"response":{"error":null},"error":{"code":"content_policy_violation"}}'],
        ],
        false,
      ),
    ],
  },
  {
    name: "unknown event",
    chunks: [
      sse(
        [
          ["response.created", '{"response":{"id":"r"}}'],
          ["response.mystery", "{}"],
          ["response.completed", "{}"],
        ],
        false,
      ),
    ],
  },
  { name: "unknown event non-json", chunks: [sse([["response.mystery", "not json"]], false)] },
  { name: "default message event is unknown", chunks: ['data: {"a":1}\n\n'] },
  {
    name: "done sentinel skipped",
    chunks: [sse([["response.output_text.delta", '{"delta":"x"}']])],
  },
  { name: "done only", chunks: ["data: [DONE]\n\n"] },
  {
    name: "ignored known events",
    chunks: [
      sse(
        [
          ["response.queued", "{}"],
          ["response.output_text.done", "{}"],
          ["response.output_text.annotation.added", "{}"],
          ["response.refusal.delta", '{"delta":"no"}'],
          ["response.reasoning_text.delta", '{"delta":"raw"}'],
          ["response.reasoning_summary_part.added", "{}"],
          [
            "response.completed",
            '{"response":{"usage":{"input_tokens":4,"output_tokens":2,"input_tokens_details":{"cached_tokens":1},"prompt_tokens_details":{"cached_tokens":3}}}}',
          ],
        ],
        false,
      ),
    ],
  },
  {
    name: "non-json known event skipped",
    chunks: [
      sse(
        [
          ["response.created", "nope"],
          ["response.created", "[]"],
          ["response.created", '"s"'],
          ["response.completed", "{}"],
        ],
        false,
      ),
    ],
  },
  {
    name: "created odd ids",
    chunks: [
      sse(
        [
          ["response.created", '{"response":{"id":12,"model":null}}'],
          ["response.created", '{"response":"str"}'],
          ["response.completed", '{"response":null}'],
        ],
        false,
      ),
    ],
  },
  {
    name: "tool call then completed is toolUse",
    chunks: [
      sse(
        [
          [
            "response.output_item.added",
            '{"output_index":0,"item":{"type":"function_call","call_id":"c","name":"n"}}',
          ],
          ["response.completed", '{"response":{}}'],
          [
            "response.completed",
            '{"response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
          ],
        ],
        false,
      ),
    ],
  },
  { name: "no terminal", chunks: [sse([["response.created", '{"response":{"id":"r"}}']], false)] },
  { name: "empty stream", chunks: [] },
];

const ERROR_RESPONSES: { name: string; response: FakeResponse }[] = [
  {
    name: "401 envelope",
    response: {
      status: 401,
      headers: [],
      chunks: ['{"error":{"type":"authentication_error","message":"bad key"}}'],
    },
  },
  {
    name: "429 retry after seconds",
    response: {
      status: 429,
      headers: [["retry-after", "5"]],
      chunks: ['{"error":{"message":"slow"}}'],
    },
  },
  {
    name: "429 fractional retry after",
    response: { status: 429, headers: [["Retry-After", "1.5"]], chunks: [""] },
  },
  {
    name: "429 negative retry after",
    response: { status: 429, headers: [["Retry-After", "-3"]], chunks: [""] },
  },
  {
    name: "429 empty retry after",
    response: { status: 429, headers: [["Retry-After", ""]], chunks: [""] },
  },
  {
    name: "429 hex retry after",
    response: { status: 429, headers: [["Retry-After", "0x10"]], chunks: [""] },
  },
  {
    name: "429 garbage retry after",
    response: { status: 429, headers: [["Retry-After", "soon"]], chunks: [""] },
  },
  { name: "402", response: { status: 402, headers: [], chunks: ["pay"] } },
  { name: "403", response: { status: 403, headers: [], chunks: [""] } },
  { name: "404", response: { status: 404, headers: [], chunks: ['{"detail":"no model"}'] } },
  {
    name: "400 detail non-string",
    response: { status: 400, headers: [], chunks: ['{"detail":[{"msg":"nope"}]}'] },
  },
  { name: "413", response: { status: 413, headers: [], chunks: [""] } },
  { name: "422", response: { status: 422, headers: [], chunks: ["x"] } },
  {
    name: "500 html",
    response: { status: 500, headers: [], chunks: ["<html>bad gateway</html>"] },
  },
  { name: "529", response: { status: 529, headers: [], chunks: [""] } },
  {
    name: "503 overloaded type",
    response: {
      status: 503,
      headers: [],
      chunks: ['{"error":{"type":"overloaded_error","message":"busy"}}'],
    },
  },
  {
    name: "400 quota code",
    response: {
      status: 400,
      headers: [],
      chunks: ['{"error":{"code":"insufficient_quota","message":"q"}}'],
    },
  },
  {
    name: "400 context length",
    response: {
      status: 429,
      headers: [],
      chunks: ['{"error":{"code":"context_length_exceeded"}}'],
    },
  },
  {
    name: "400 content policy",
    response: {
      status: 400,
      headers: [],
      chunks: ['{"error":{"type":"content_policy_violation","code":"other","message":""}}'],
    },
  },
  {
    name: "type beats code",
    response: {
      status: 400,
      headers: [],
      chunks: ['{"error":{"type":"x","code":"insufficient_quota"}}'],
    },
  },
  {
    name: "null type falls to code",
    response: {
      status: 400,
      headers: [],
      chunks: ['{"error":{"type":null,"code":"insufficient_quota"}}'],
    },
  },
  {
    name: "message not string",
    response: { status: 400, headers: [], chunks: ['{"error":{"message":5},"detail":"d"}'] },
  },
  { name: "json null", response: { status: 500, headers: [], chunks: ["null"] } },
  { name: "json string", response: { status: 500, headers: [], chunks: ['"str"'] } },
  {
    name: "error is a string",
    response: { status: 500, headers: [], chunks: ['{"error":"flat"}'] },
  },
  {
    name: "long body truncated",
    response: { status: 500, headers: [], chunks: ["x".repeat(600)] },
  },
  {
    name: "long message truncated",
    response: {
      status: 400,
      headers: [],
      chunks: [JSON.stringify({ error: { message: "é".repeat(700) } })],
    },
  },
  {
    name: "message truncated mid-pair",
    response: {
      status: 400,
      headers: [],
      chunks: [JSON.stringify({ error: { message: `${"x".repeat(499)}😀tail` } })],
    },
  },
  {
    name: "body truncated mid-pair",
    response: { status: 502, headers: [], chunks: [`${"x".repeat(499)}😀tail`] },
  },
  {
    name: "message with lone surrogate escape",
    response: { status: 400, headers: [], chunks: ['{"error":{"message":"bad \\ud83d here"}}'] },
  },
  { name: "empty body", response: { status: 500, headers: [], chunks: [] } },
  { name: "199", response: { status: 199, headers: [], chunks: ["info"] } },
  { name: "300", response: { status: 300, headers: [], chunks: ["redirect"] } },
  { name: "418", response: { status: 418, headers: [], chunks: [""] } },
  {
    name: "200 body split invalid utf8",
    response: {
      status: 200,
      headers: [],
      chunks: [
        {
          bytes: [
            0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff,
            0x22, 0x7d, 0x0a, 0x0a,
          ],
        },
        "data: [DONE]\n\n",
      ],
    },
  },
  {
    name: "200 oversized record",
    response: {
      status: 200,
      headers: [],
      chunks: [
        "data: ",
        ...Array.from({ length: 11 }, () => ({ repeat: "x", count: 1024 * 1024 })),
      ],
    },
  },
];

async function decodeVectors(): Promise<unknown[]> {
  const out = [];
  const base = REQUESTS[0]?.request as ChatRequest;
  const cases: {
    name: string;
    protocol: "chat_completions" | "responses";
    response: FakeResponse;
  }[] = [
    ...CHAT_STREAMS.map((s) => ({
      name: s.name,
      protocol: "chat_completions" as const,
      response: { status: 200, headers: [] as [string, string][], chunks: s.chunks },
    })),
    ...RESPONSES_STREAMS.map((s) => ({
      name: s.name,
      protocol: "responses" as const,
      response: { status: 200, headers: [] as [string, string][], chunks: s.chunks },
    })),
    ...ERROR_RESPONSES.map((s) => ({
      name: s.name,
      protocol: "chat_completions" as const,
      response: s.response,
    })),
  ];
  for (const c of cases) {
    const credentials: AdapterCredentials = {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://host.test", protocol: c.protocol },
    };
    const result = (await runAdapter(base, credentials, c.response)) as Record<string, unknown>;
    // The request is pinned by the encode vectors; here only the reply matters.
    delete result.sent;
    out.push({ name: c.name, protocol: c.protocol, response: c.response, result });
  }
  return out;
}

/**
 * Large multi-chunk Chat Completions streams, each well under
 * `MAX_RECORD_CHARS`: about 8 KiB, 64 KiB and 1 MiB of SSE. They exist so a
 * decoder that behaves differently when many messages arrive in one large
 * chunk (the fast path's typed parse, say) has a TS answer to be held to.
 *
 * Each opens with two large single records, since a decoder sees one record
 * at a time however the body is chunked: one parallel tool-call delta
 * carrying 64 calls (ids, names, arguments), and one content delta of
 * `bigDelta` characters (1 MB in the largest stream, still a tenth of the
 * record cap). Then it repeats one round until the body reaches its size:
 * content deltas (some with escapes and multi-byte text), reasoning deltas
 * in each spelling (`reasoning`, `reasoning_content`, `reasoning_details`
 * with `text` and `summary`), and a tool call whose arguments arrive split
 * across several deltas. A finish, a usage chunk and `[DONE]` close it. The
 * body is cut into chunks of a few irregular sizes, so records straddle
 * chunk boundaries everywhere; the big delta spans hundreds of chunks.
 *
 * Deterministic: no randomness, so a re-export gives the same bytes.
 */
function largeStream(targetBytes: number, bigDelta: number): Chunk[] {
  const PARALLEL = 64;
  const parallel = Array.from(
    { length: PARALLEL },
    (_, i) =>
      `{"index":${i},"id":"call_p${i}","type":"function","function":{"name":"par_${i}","arguments":"{\\"i\\":${i}}"}}`,
  ).join(",");
  const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil(bigDelta / 27)).slice(0, bigDelta);
  const frames: string[] = [
    '{"id":"chatcmpl-large","model":"m-large","choices":[{"delta":{"role":"assistant","content":""}}]}',
    `{"choices":[{"delta":{"tool_calls":[${parallel}]}}]}`,
    `{"choices":[{"delta":{"content":"${filler}"}}]}`,
  ];
  // Round tool calls start past the parallel ones.
  let round = PARALLEL;
  let size = frames.reduce((n, f) => n + f.length + 8, 0);
  while (size < targetBytes) {
    const r = round;
    const round_frames = [
      `{"choices":[{"delta":{"reasoning":"step ${r} "}}]}`,
      `{"choices":[{"delta":{"reasoning_content":"think ${r} \u00e9 "}}]}`,
      `{"choices":[{"delta":{"reasoning_details":[{"text":"detail ${r} "},{"summary":"sum ${r} "}]}}]}`,
      `{"choices":[{"delta":{"content":"word ${r} "}}]}`,
      `{"choices":[{"delta":{"content":"qu\\"ote\\\\ ${r} 😀 "}}]}`,
      `{"choices":[{"delta":{"content":"plain ${r} "}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":${r},"id":"call_${r}","type":"function","function":{"name":"tool_${r % 5}","arguments":""}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":${r},"function":{"arguments":"{\\"path\\":\\"/src/"}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":${r},"function":{"arguments":"file${r}.ts\\",\\"n\\":"}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":${r},"function":{"arguments":"${r}}"}}]}}]}`,
      `{"choices":[{"delta":{"content":"after tool ${r} "}}]}`,
    ];
    for (const f of round_frames) {
      frames.push(f);
      size += f.length + 8;
    }
    round += 1;
  }
  frames.push('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
  frames.push(
    `{"choices":[],"usage":{"prompt_tokens":${1000 + round},"completion_tokens":${round * 7},"prompt_tokens_details":{"cached_tokens":${round}}}}`,
  );
  const whole = sse(frames);
  // Irregular cuts: 1, 7, 97, 1024 and 4093 bytes in turn (in UTF-16 units of
  // the string; a cut through the emoji's surrogate pair is avoided by the
  // encoder working on whole strings, so it is cut at a code point).
  const sizes = [1, 7, 97, 1024, 4093];
  const chars = Array.from(whole);
  const out: string[] = [];
  let at = 0;
  for (let i = 0; at < chars.length; i += 1) {
    const n = sizes[i % sizes.length] as number;
    out.push(chars.slice(at, at + n).join(""));
    at += n;
  }
  return out;
}

const LARGE_CHAT_STREAMS: { name: string; chunks: Chunk[] }[] = [
  { name: "large stream ~8 KiB", chunks: largeStream(8 * 1024, 1024) },
  { name: "large stream ~64 KiB", chunks: largeStream(64 * 1024, 16 * 1024) },
  // The big delta is 1 000 100 characters: past 1 MB in one record.
  { name: "large stream ~1 MiB", chunks: largeStream(1024 * 1024 + 64 * 1024, 1_000_100) },
];

/** `customAdapter.send` over the large streams, in the `custom.decode` shape. */
async function largeDecodeVectors(): Promise<unknown[]> {
  const out = [];
  const base = REQUESTS[0]?.request as ChatRequest;
  for (const s of LARGE_CHAT_STREAMS) {
    const response: FakeResponse = { status: 200, headers: [], chunks: s.chunks };
    const credentials: AdapterCredentials = {
      accessToken: null,
      apiKey: "ck",
      providerData: { origin: "https://host.test", protocol: "chat_completions" },
    };
    const result = (await runAdapter(base, credentials, response)) as Record<string, unknown>;
    delete result.sent;
    out.push({ name: s.name, protocol: "chat_completions", response, result });
  }
  return out;
}

// --------------------------------------------------------------- http.ts

async function httpErrorVectors(): Promise<unknown> {
  const NOW = Date.parse("2026-11-07T04:36:00Z");
  const retryAfter = [
    null,
    "5",
    "0",
    "1.5",
    "-3",
    "",
    " ",
    "  7  ",
    "0x1F",
    "1e2",
    "Infinity",
    "+7",
    ".5",
    "5s",
    "abc",
    "Sat, 07 Nov 2026 04:36:32 GMT",
    "Saturday, 07-Nov-26 04:36:32 GMT",
    "2026-11-07T04:36:32Z",
    "2026-11-07T04:36:32.5Z",
    "Sat, 07 Nov 2026 04:35:00 GMT",
    "07 Nov 2026 04:36:32 GMT",
    "sat, 07 nov 2026 04:36:32 gmt",
    "Sat, 07 Nov 2026 04:36:32 +0100",
    "2026-11-07T04:36:32+01:00",
  ].map((header) => ({ header, now: NOW, output: parseRetryAfter(header, NOW) ?? null }));
  const errors = [];
  for (const [status, body, headers] of [
    [429, '{"error":{"message":"m"}}', [["retry-after", "Sat, 07 Nov 2026 04:36:32 GMT"]]],
    [503, "", [["retry-after", "2026-11-07T04:36:30Z"]]],
    [500, "", [["retry-after", "120"]]],
  ] as const) {
    const res = {
      status,
      headers: new Headers(headers as unknown as [string, string][]),
      body: null,
      text: async () => body,
    } as HttpResponse;
    errors.push({
      status,
      body,
      headers,
      now: NOW,
      output: describeError(await httpError(res, "custom", NOW)),
    });
  }
  return { parseRetryAfter: retryAfter, httpError: errors };
}

// --------------------------------------------------------------- http wire

type WireCase = { method: string; path: string; headers: [string, string][]; body: string };

const WIRE_CASES: WireCase[] = [
  {
    method: "POST",
    path: "/v1/chat/completions",
    headers: [
      ["Content-Type", "application/json"],
      ["Authorization", "Bearer ck"],
    ],
    body: '{"a":"日本"}',
  },
  {
    method: "POST",
    path: "/v1/x?q=1#frag",
    headers: [
      ["User-Agent", "claude-cli/2.1.296 (external, cli)"],
      ["x-app", "cli"],
      ["X-Stainless-Lang", "js"],
      ["anthropic-version", "2023-06-01"],
    ],
    body: '{"a":1}',
  },
  { method: "POST", path: "/p", headers: [["a", "1"]], body: "" },
  { method: "GET", path: "/p?", headers: [["a", "1"]], body: "" },
  { method: "GET", path: "/p", headers: [["a", "1"]], body: "body" },
  { method: "DELETE", path: "/p", headers: [], body: "" },
  { method: "PATCH", path: "/p", headers: [], body: "" },
  {
    method: "PUT",
    path: "/p",
    headers: [
      ["a", "1"],
      ["a", "2"],
    ],
    body: "xy",
  },
  { method: "OPTIONS", path: "/p", headers: [], body: "" },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["x-a", "1"],
      ["b", "2"],
      ["X-A", "3"],
    ],
    body: "",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["b", "2"],
      ["123", "x"],
      ["a", "1"],
      ["7", "y"],
      ["01", "z"],
    ],
    body: "z",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["Host", "h.example"],
      ["a", "1"],
    ],
    body: "xy",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["a", "1"],
      ["connection", "keep-alive"],
    ],
    body: "",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["content-length", "3"],
      ["Connection", "close"],
    ],
    body: "abc",
  },
  { method: "POST", path: "/p", headers: [["Content-Length", "0"]], body: "" },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["a", "1"],
      ["Transfer-Encoding", "chunked"],
    ],
    body: "xy",
  },
  { method: "POST", path: "/p", headers: [["Transfer-Encoding", "chunked"]], body: "" },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["a", "é"],
      ["b", ""],
      ["c", " spaced\t"],
    ],
    body: "xy",
  },
  { method: "POST", path: "/caf%C3%A9/é sp", headers: [], body: "{}" },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["X-A", "1"],
      ["b", "2"],
      ["x-a", "3"],
      ["X-a", "4"],
    ],
    body: "",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["b", "2"],
      ["HOST", "h"],
      ["host", "i"],
    ],
    body: "",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["b", "2"],
      ["Connection", "x"],
      ["connection", "y"],
    ],
    body: "q",
  },
  {
    method: "POST",
    path: "/p",
    headers: [
      ["b", "2"],
      ["10", "x"],
      ["2", "y"],
      ["Content-Type", "j"],
    ],
    body: "q",
  },
  { method: "GET", path: "/p", headers: [["Content-Length", "0"]], body: "" },
  { method: "POST", path: "/p", headers: [["transfer-encoding", "gzip, chunked"]], body: "q" },
  { method: "POST", path: "/p", headers: [["Transfer-Encoding", "gzip"]], body: "q" },
  { method: "POST", path: "/p", headers: [["Transfer-Encoding", "identity"]], body: "" },
  { method: "DELETE", path: "/p", headers: [["a", "1"]], body: "q" },
  { method: "POST", path: "/p", headers: [["Expect", "100-continue"]], body: "" },
  { method: "POST", path: "/p", headers: [["Expect", "x"]], body: "abc" },
  { method: "POST", path: "/p", headers: [["Connection", "Keep-Alive, Close"]], body: "" },
];

/** Sends every case through `nodeHttpClient` and records the bytes the listener saw. */
async function httpWireVectors(): Promise<unknown[]> {
  const captured: { socket: number; raw: string }[] = [];
  let sockets = 0;
  let waiting: (() => void) | undefined;
  const server = Bun.listen<{ id: number; buf: Buffer }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { id: ++sockets, buf: Buffer.alloc(0) };
      },
      data(s, data) {
        s.data.buf = Buffer.concat([s.data.buf, Buffer.from(data)]);
        const end = s.data.buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = s.data.buf.subarray(0, end).toString("latin1");
        const rest = s.data.buf.subarray(end + 4);
        const chunked = /\r\ntransfer-encoding:[^\r]*\bchunked\b/i.test(head);
        const length = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? "0");
        if (chunked ? rest.indexOf("0\r\n\r\n") === -1 : rest.byteLength < length) return;
        captured.push({ socket: s.data.id, raw: s.data.buf.toString("latin1") });
        s.data.buf = Buffer.alloc(0);
        s.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        waiting?.();
      },
      close() {},
      error() {},
    },
  });
  const http = nodeHttpClient();
  const out = [];
  for (const c of WIRE_CASES) {
    const before = captured.length;
    const arrived = new Promise<void>((r) => {
      waiting = r;
    });
    const res = await http({
      provider: "custom",
      url: `http://127.0.0.1:${server.port}${c.path}`,
      method: c.method,
      headers: c.headers,
      body: c.body,
      signal: AbortSignal.timeout(5000),
    });
    await res.text();
    if (captured.length === before) await arrived;
    const got = captured[before];
    if (got === undefined) throw new Error("http wire capture missed a request");
    out.push({ ...c, socket: got.socket, raw: got.raw.replaceAll(String(server.port), "{port}") });
  }
  server.stop(true);
  return out;
}

/**
 * Replaces every string holding a lone surrogate with `{"$utf16": [units]}`.
 *
 * `JSON.stringify` writes a lone surrogate as a `\udXXX` escape, which strict
 * parsers (serde_json among them) refuse — and one such escape anywhere would
 * make the whole of `vectors.json` unreadable to every Rust test.
 */
function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return /[\ud800-\udfff]/.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))
      ? { $utf16: Array.from({ length: value.length }, (_, i) => value.charCodeAt(i)) }
      : value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

export async function customVectors(): Promise<Record<string, unknown>> {
  // `Date.parse` reads a zoneless date as local time; the vectors assume UTC.
  if (new Date(0).getTimezoneOffset() !== 0) throw new Error("run the export with TZ=UTC");
  return sanitize({
    custom: {
      encode: await encodeVectors(),
      decode: await decodeVectors(),
      http: await httpErrorVectors(),
    },
    sse: { maxRecordChars: MAX_RECORD_CHARS, cases: await sseVectors() },
    httpWire: await httpWireVectors(),
    // Appended last, so every section above keeps its bytes.
    customLargeDecode: await largeDecodeVectors(),
  }) as Record<string, unknown>;
}
