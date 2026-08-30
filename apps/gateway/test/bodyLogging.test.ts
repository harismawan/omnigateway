import { expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@omni/ir";
import { ADAPTERS, type HttpClient, type HttpRequest, type HttpResponse } from "@omni/providers";
import { type BodyArtifact, createStore, deriveKey, type Settings, type Store } from "@omni/store";
import {
  type CaptureLogger,
  captureLogger,
  seedApiKey,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import {
  createBodyCollector,
  createFrameSink,
  MAX_CAPTURED_BODY_BYTES,
} from "../src/bodyCapture.ts";
import { pruneLogs } from "../src/maintenance.ts";
import { proxyRoutes } from "../src/routes/proxy.ts";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const ENCRYPTION_KEY = "test-encryption-key-0123456789";

/**
 * A store on disk, because the artifact tree is derived from the database path
 * and an in-memory database has nowhere to put one.
 */
async function tempStore(): Promise<{ store: Store; root: string }> {
  const root = join(tmpdir(), `omni-gateway-bodies-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey(ENCRYPTION_KEY),
  });
  return { store, root };
}

async function cleanup(store: Store, root: string): Promise<void> {
  store.close();
  await rm(root, { recursive: true, force: true });
}

/** One complete Anthropic stream, split the way a socket would deliver it. */
const ANTHROPIC_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_up","model":"claude-opus-4","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

/** An OpenAI-shaped chat stream, which is what the `custom` adapter decodes. */
const CUSTOM_FRAMES = [
  'data: {"id":"chat_1","model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
  "data: [DONE]\n\n",
];

/**
 * A body that delivers `frames`, then either ends or hangs until the request is
 * aborted.
 *
 * Hanging on the signal is what a real socket does: `nodeHttpClient` destroys
 * the outgoing request when the signal fires, and the response stream errors.
 * A stub that ignored the signal would let a capture drain outlive the request
 * that started it, which is the failure mode worth reproducing rather than
 * hiding.
 */
function bodyOf(
  frames: string[],
  signal: AbortSignal,
  deliver = frames.length,
  /**
   * A pause before each frame, for the tests that need upstream silence rather
   * than a burst. Zero leaves `start` synchronous, so the default behaves
   * exactly as it did before this existed; a non-zero gap delays the abort
   * listener below with it, so the two are not combined.
   */
  gapMs = 0,
): HttpResponse {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const frame of frames.slice(0, deliver)) {
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(frame));
      }
      if (deliver >= frames.length) {
        controller.close();
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          controller.error(new Error("upstream connection destroyed"));
        },
        { once: true },
      );
    },
  });
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body,
    text: async () => frames.join(""),
  };
}

type UpstreamOptions = {
  /** How many frames reach the client before the stream stalls. */
  deliver?: number;
  /** Providers whose first call answers with this status instead of a stream. */
  failFirst?: { status: number; body: string };
  /** Silence between frames, for the keepalive path. */
  gapMs?: number;
  /** Replaces the Anthropic frame set, for the tests that need a large one. */
  frames?: string[];
};

function upstream(options: UpstreamOptions = {}): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (req) => {
    calls.push(req);
    if (options.failFirst !== undefined && calls.length === 1) {
      const text = options.failFirst.body;
      return {
        status: options.failFirst.status,
        headers: new Headers({ "content-type": "application/json" }),
        body: new Response(text).body,
        text: async () => text,
      };
    }
    const frames = req.provider === "custom" ? CUSTOM_FRAMES : (options.frames ?? ANTHROPIC_FRAMES);
    return bodyOf(frames, req.signal, options.deliver ?? frames.length, options.gapMs ?? 0);
  };
  return { http, calls };
}

type HarnessOptions = {
  allowed?: boolean;
  settings?: Partial<Settings>;
  http?: HttpClient;
  logger?: Logger;
  /** A second target the pool fails over to, so an artifact can hold two attempts. */
  failover?: boolean;
  credential?: { authType: "oauth" | "apiKey"; accessToken?: string; apiKey?: string };
  keys?: Array<{ label: string; bodyLoggingOptOut?: boolean }>;
  /** Short enough that ordinary upstream silence produces a keepalive comment. */
  keepaliveMs?: number;
};

async function harness(options: HarnessOptions = {}) {
  const { store, root } = await tempStore();
  if (options.settings !== undefined) await store.config.putSettings(options.settings);

  const credential = options.credential ?? { authType: "oauth" as const };
  await seedCredential(store, {
    id: "c1",
    provider: "anthropic",
    authType: credential.authType,
    accessToken:
      credential.authType === "apiKey" ? null : (credential.accessToken ?? "oauth-access-c1"),
    apiKey: credential.apiKey ?? null,
    refreshToken: "oauth-refresh-c1",
  });
  const targets = [target({ provider: "anthropic", model: "claude-opus-4", tier: 1 })];
  if (options.failover === true) {
    await seedCredential(store, {
      id: "c2",
      provider: "custom",
      authType: "apiKey",
      accessToken: null,
      refreshToken: null,
      apiKey: "custom-key",
      providerData: {
        endpointId: "local",
        endpointLabel: "Local",
        origin: "http://localhost:8000",
        protocol: "chat_completions",
      },
    });
    targets.push(
      target({ provider: "custom", endpointId: "local", model: "upstream-model", tier: 2 }),
    );
  }
  await store.config.putModel(virtualModel({ id: "fast", targets }));

  const keys: Record<string, string> = {};
  for (const spec of options.keys ?? [{ label: "default" }]) {
    const { raw } = await seedApiKey(store, {
      label: spec.label,
      bodyLoggingOptOut: spec.bodyLoggingOptOut === true,
    });
    keys[spec.label] = raw;
  }

  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: ADAPTERS,
    http: options.http ?? upstream().http,
    now: () => NOW,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    bodyLoggingAllowed: options.allowed === true,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.keepaliveMs === undefined ? {} : { keepaliveMs: options.keepaliveMs }),
  });

  const call = (body: unknown, key = "default") =>
    app.handle(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${keys[key] ?? ""}`,
        },
        body: JSON.stringify(body),
      }),
    );

  return { store, root, app, call, keys };
}

const ASK = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

/** Reads back one stored artifact, failing loudly rather than returning null. */
async function artifactOf(store: Store, requestId: string): Promise<BodyArtifact> {
  const read = await store.bodies.get(requestId);
  if (read === null) throw new Error(`no body row for ${requestId}`);
  if (read.artifact === null)
    throw new Error(`artifact for ${requestId} is ${read.row.detailState}`);
  return read.artifact;
}

/** Polls rather than sleeping a fixed interval, which keeps a test off a guess. */
async function until(what: string, ready: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits for a streamed request's row.
 *
 * The SSE writer closes the stream and *then* writes its log, so a client that
 * has read the last frame has not necessarily seen the write land.
 */
async function waitForBody(store: Store, requestId: string): Promise<void> {
  await until(
    `a body row for ${requestId}`,
    async () => (await store.bodies.get(requestId)) !== null,
  );
}

/** Steps into a captured body without pretending to know its shape. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const CAPTURE_ON: Partial<Settings> = { bodyLoggingEnabled: true };

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

test("captures nothing when the setting is left at its default", async () => {
  const { store, root, call } = await harness({ allowed: true });
  expect((await store.config.getSettings()).bodyLoggingEnabled).toBe(false);

  expect((await call(ASK)).status).toBe(200);

  expect(await store.bodies.get("req_1")).toBeNull();
  await cleanup(store, root);
});

test("captures nothing when the setting is on but the environment does not permit it", async () => {
  const { store, root, call } = await harness({ allowed: false, settings: CAPTURE_ON });

  expect((await call(ASK)).status).toBe(200);

  expect(await store.bodies.get("req_1")).toBeNull();
  await cleanup(store, root);
});

test("captures an artifact when both keys are set", async () => {
  const { store, root, call } = await harness({ allowed: true, settings: CAPTURE_ON });

  expect((await call(ASK)).status).toBe(200);

  const artifact = await artifactOf(store, "req_1");
  expect(artifact.requestId).toBe("req_1");
  expect(artifact.attempts).toHaveLength(1);
  await cleanup(store, root);
});

test("never captures a key that opted out, while capturing another on the same gateway", async () => {
  const { store, root, call } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    keys: [{ label: "quiet", bodyLoggingOptOut: true }, { label: "loud" }],
  });

  expect((await call(ASK, "quiet")).status).toBe(200);
  expect((await call(ASK, "loud")).status).toBe(200);

  expect(await store.bodies.get("req_1")).toBeNull();
  expect((await artifactOf(store, "req_2")).attempts).toHaveLength(1);
  await cleanup(store, root);
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

test("holds the client pair and one ordered entry per wire call", async () => {
  const wire = upstream({ failFirst: { status: 500, body: '{"error":{"message":"boom"}}' } });
  const { store, root, call } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    failover: true,
    http: wire.http,
  });

  expect((await call(ASK)).status).toBe(200);

  const artifact = await artifactOf(store, "req_1");
  // One entry per outbound call, not per dispatch attempt: the two happen to
  // agree here, and the artifact's numbering follows the wire either way.
  expect(wire.calls.map((c) => c.provider)).toEqual(["anthropic", "custom"]);
  expect(artifact.attempts.map((a) => [a.attempt, a.provider])).toEqual([
    [1, "anthropic"],
    [2, "custom"],
  ]);
  // The failed attempt kept both halves: the request that went out and the
  // upstream's own error body, read through `text()` rather than the stream.
  expect(field(artifact.attempts[0]?.request, "model")).toBe("claude-opus-4");
  expect(field(field(artifact.attempts[0]?.response, "error"), "message")).toBe("boom");
  expect(field(artifact.attempts[1]?.request, "model")).toBe("upstream-model");

  // The client half is the surface's own request and response, not a provider's.
  expect(field(artifact.client.request, "model")).toBe("fast");
  expect(field(artifact.client.response, "id")).toBe("req_1");
  expect(field(artifact.client.response, "content")).toEqual([{ type: "text", text: "Hi" }]);
  await cleanup(store, root);
});

/** The `event:` name of each captured frame, in order. */
function eventNames(frames: unknown): string[] {
  if (!Array.isArray(frames)) throw new Error("expected the client response to be SSE frames");
  return frames.map((frame) =>
    typeof frame === "string" ? (frame.match(/^event: (.+)$/m)?.[1] ?? frame) : String(frame),
  );
}

/**
 * The whole sequence, not its last element.
 *
 * A response the gateway streamed *is* the frames it wrote, so the artifact has
 * to hold all of them: `message_start` carries the upstream message id, the
 * model, and the input token count, and an artifact that kept only the terminal
 * frame would still satisfy every "it ends with message_stop" assertion while
 * being useless for the incident it was captured for.
 *
 * The upstream is deliberately slow and the keepalive interval deliberately
 * short, so the route really does write keepalive comments during this request
 * — the exclusion below is otherwise an assertion about a code path the test
 * never reaches.
 */
test("captures a streaming request as every frame the gateway wrote, minus its keepalives", async () => {
  const { store, root, call } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    http: upstream({ gapMs: 20 }).http,
    keepaliveMs: 5,
  });

  const res = await call({ ...ASK, stream: true });
  const wire = await res.text();
  expect(wire).toContain("Hello");
  // The client really was sent padding, so its absence from the artifact is the
  // exclusion working rather than the path never having run.
  expect(wire).toContain(": keepalive");
  await waitForBody(store, "req_1");

  const artifact = await artifactOf(store, "req_1");
  expect(eventNames(artifact.client.response)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  // Keepalive comments are the route's own padding and are not part of what
  // either side sent.
  const frames = artifact.client.response;
  if (!Array.isArray(frames)) throw new Error("expected the client response to be SSE frames");
  expect(frames.some((f) => typeof f === "string" && f.includes("keepalive"))).toBe(false);
  expect(artifact.client.truncated).toBe(false);
  expect(artifact.attempts).toHaveLength(1);
  expect(String(artifact.attempts[0]?.response)).toContain("content_block_delta");
  await cleanup(store, root);
});

test("leaves streamChunks null unless the stream-chunk setting is on", async () => {
  const off = await harness({ allowed: true, settings: CAPTURE_ON });
  expect((await off.call(ASK)).status).toBe(200);
  expect((await artifactOf(off.store, "req_1")).attempts[0]?.streamChunks).toBeNull();
  await cleanup(off.store, off.root);

  const on = await harness({
    allowed: true,
    settings: { ...CAPTURE_ON, bodyLoggingCaptureStreamChunks: true },
  });
  expect((await on.call(ASK)).status).toBe(200);
  const chunks = (await artifactOf(on.store, "req_1")).attempts[0]?.streamChunks;
  expect(Array.isArray(chunks)).toBe(true);
  expect(chunks?.[0]).toContain("message_start");
  expect(chunks?.at(-1)).toContain("message_stop");
  await cleanup(on.store, on.root);
});

/**
 * `transformRequest` runs inside dispatch, so the client half is the
 * conversation before RTK and every wire half is the conversation after it.
 *
 * That asymmetry is the point of the feature rather than a defect in it:
 * `request_logs` already records which filters ran and how many code units they
 * removed, and nowhere records *what* they removed. This pins the split at the
 * two layers that were actually wrapped, so a future refactor that captures
 * both halves on one side of RTK fails here instead of quietly producing an
 * artifact whose two sides agree and prove nothing.
 */
test("keeps the pre-RTK conversation on the client half and the compressed one on the wire", async () => {
  const chatter = Array.from(
    { length: 100 },
    () => "  (use git add to update what will be committed)",
  );
  const toolResult = [
    "## HEAD (no branch)",
    " M path with spaces.ts",
    "?? untracked file.ts",
    ...chatter,
  ].join("\n");

  const { store, root, call } = await harness({
    allowed: true,
    settings: { ...CAPTURE_ON, rtkEnabled: true },
  });

  const res = await call({
    model: "fast",
    max_tokens: 100,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "bash", input: { command: "git status" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: toolResult }] },
    ],
  });
  expect(res.status).toBe(200);

  const log = (await store.usage.recent(1))[0];
  expect(log?.rtkApplied).toBe(true);

  const artifact = await artifactOf(store, "req_1");
  const client = JSON.stringify(artifact.client.request);
  const wire = JSON.stringify(artifact.attempts[0]?.request);
  const noise = "(use git add to update what will be committed)";
  expect(client).toContain(noise);
  expect(wire).not.toContain(noise);
  // Both still hold the states the filter is required to preserve, so the wire
  // half reads as compressed rather than as a different conversation.
  expect(client).toContain("?? untracked file.ts");
  expect(wire).toContain("?? untracked file.ts");
  await cleanup(store, root);
});

test("writes an artifact for a stream the client hung up on", async () => {
  const { store, root, app, keys } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    // Three frames go out and the rest never arrive, so the disconnect lands
    // strictly mid-stream.
    http: upstream({ deliver: 3 }).http,
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  try {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${server.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.default ?? ""}`,
      },
      body: JSON.stringify({ ...ASK, stream: true }),
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("expected a streamed body");
    let sawContent = false;
    while (!sawContent) {
      const { value, done } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).includes("Hello")) sawContent = true;
    }
    controller.abort();
    await waitForBody(store, "req_1");

    const log = (await store.usage.recent(1))[0];
    expect(log?.status).toBe(499);

    const artifact = await artifactOf(store, "req_1");
    const frames = artifact.client.response;
    if (!Array.isArray(frames)) throw new Error("expected the client response to be SSE frames");
    // Whatever had gone out before the hang-up, and nothing after it: the
    // stream never reached its terminal frame.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => typeof f === "string" && f.includes("message_stop"))).toBe(false);
    // And it says so. A stream cut off mid-flight is structurally unremarkable —
    // the frames that did go out are well formed — so without the flag the
    // artifact reads as a complete short response.
    expect(artifact.client.truncated).toBe(true);
    expect(field(artifact.error, "code")).toBe("interrupted");
    expect(field(artifact.error, "status")).toBe(499);
  } finally {
    server.stop(true);
  }
  await cleanup(store, root);
});

/**
 * The other half of the same invariant.
 *
 * A non-streaming request that is hung up on never reaches the streaming path's
 * `log`; it throws out of the drain and lands in the terminal catch, which is a
 * second place `client.truncated` has to be set and was a second place nothing
 * asserted it.
 */
test("writes a truncated artifact for a non-streaming request the client hung up on", async () => {
  // The stub's own call log is kept, because it is the barrier below.
  const sent = upstream({ deliver: 0 });
  const { store, root, app, keys } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    // Nothing ever arrives, so only the hang-up ends the attempt.
    http: sent.http,
  });

  const controller = new AbortController();
  const pending = app.handle(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keys.default ?? ""}`,
      },
      body: JSON.stringify(ASK),
      signal: controller.signal,
    }),
  );
  // **The outbound call, not the pending row.** The row is written by `routeLog`
  // when routing resolves, which is strictly earlier than the attempt being
  // recorded — so aborting on it left a window where the hang-up landed after a
  // target was picked and before anything was attempted, and `artifact.attempts`
  // came back empty. Green on an idle machine, flaky under load: it failed once
  // in CI and never in six consecutive local runs of the full suite.
  //
  // `bodyCapture` pushes the attempt entry *before* it awaits `http(req)`, and
  // this stub is what `http(req)` reaches, so one recorded call implies one
  // recorded attempt. That is the same event the assertions below are about,
  // which is the property a barrier should have and the pending row never did.
  await until("the request to reach the upstream stub", async () => sent.calls.length === 1);
  controller.abort();
  await pending.catch(() => undefined);
  await waitForBody(store, "req_1");

  const artifact = await artifactOf(store, "req_1");
  expect(artifact.client.truncated).toBe(true);
  expect(field(artifact.error, "code")).toBe("interrupted");
  // The request that went out is still there, and nothing answered it.
  expect(artifact.attempts).toHaveLength(1);
  expect(artifact.attempts[0]?.response).toBeNull();
  await cleanup(store, root);
});

/**
 * A stream long enough to outrun the sink's own cap.
 *
 * The sink keeps the most recent frames, so what an eviction discards is the
 * head — `message_start`, which carries the upstream message id, the model, and
 * the input token count. The frames left behind are well formed and end on
 * `message_stop`, so an artifact that did not record the eviction is one an
 * operator reads as a complete short response.
 */
test("marks a streamed response whose frames outgrew the sink as truncated", async () => {
  // Each delta is a single unbroken run, so masking collapses it and the stored
  // artifact stays small: this is measuring the sink's cap, not the artifact's.
  const filler = "x".repeat(30_000);
  const huge = [
    ANTHROPIC_FRAMES[0] ?? "",
    ANTHROPIC_FRAMES[1] ?? "",
    ...Array.from(
      { length: 20 },
      () =>
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${filler}"}}\n\n`,
    ),
    ...ANTHROPIC_FRAMES.slice(3),
  ];
  const { store, root, call } = await harness({
    allowed: true,
    settings: CAPTURE_ON,
    http: upstream({ frames: huge }).http,
  });

  const res = await call({ ...ASK, stream: true });
  expect(await res.text()).toContain("message_stop");
  await waitForBody(store, "req_1");

  const artifact = await artifactOf(store, "req_1");
  const names = eventNames(artifact.client.response);
  // The tail survived and the head did not, which is the trade the sink makes.
  expect(names.at(-1)).toBe("message_stop");
  expect(names).not.toContain("message_start");
  expect(artifact.client.truncated).toBe(true);
  await cleanup(store, root);
});

/**
 * Capture is opt-in bookkeeping; the request is the product.
 *
 * A failed artifact write must cost the client nothing and must not cost the
 * operator the row, which is the record everything else is joined to.
 */
test("degrades a failed artifact write to a missing artifact, not a failed request", async () => {
  const logger: CaptureLogger = captureLogger("debug");
  const { store, root, call } = await harness({ allowed: true, settings: CAPTURE_ON, logger });
  store.bodies.put = async () => {
    throw new Error("artifact volume is full");
  };

  const res = await call(ASK);

  expect(res.status).toBe(200);
  expect(await store.bodies.get("req_1")).toBeNull();
  const rows = await store.usage.recent(10);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe("done");
  expect(rows[0]?.status).toBe(200);
  expect(logger.records.some((r) => r.msg === "failed to persist request bodies")).toBe(true);
  await cleanup(store, root);
});

/**
 * The artifact is written after the drains have finished, not after they have
 * probably finished.
 *
 * The trailing frame below arrives long after the decoder has seen
 * `message_stop` and the route has rendered its response, so it can only reach
 * the artifact through `settle`. Without that await the write happens on
 * whatever the capture branch had got to, which on a fast stub is usually
 * everything — which is why this stream is slow by construction rather than by
 * luck.
 */
test("waits for the capture drains before writing the artifact", async () => {
  const encoder = new TextEncoder();
  const http: HttpClient = async () => ({
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of ANTHROPIC_FRAMES) controller.enqueue(encoder.encode(frame));
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.enqueue(encoder.encode("event: trailing_marker\ndata: {}\n\n"));
        controller.close();
      },
    }),
    text: async () => ANTHROPIC_FRAMES.join(""),
  });
  const { store, root, call } = await harness({ allowed: true, settings: CAPTURE_ON, http });

  expect((await call(ASK)).status).toBe(200);

  const artifact = await artifactOf(store, "req_1");
  expect(String(artifact.attempts[0]?.response)).toContain("trailing_marker");
  await cleanup(store, root);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The regression test that fails if `LogFields` is ever widened.
 *
 * Body capture adds a storage path for prompts; it must not add a printing one.
 * `LogFields` is a closed allowlist with no index signature and is the
 * compile-time redaction boundary, so the way this breaks is somebody adding a
 * free-text member to it and passing a body through — which compiles, and which
 * this catches.
 */
test("keeps a prompt marker out of the stdout sink while capture is on", async () => {
  const logger: CaptureLogger = captureLogger("debug");
  const marker = "MARKER-DO-NOT-LOG-7f3a2b";
  const { store, root, call } = await harness({
    allowed: true,
    settings: { ...CAPTURE_ON, bodyLoggingCaptureStreamChunks: true },
    logger,
  });

  const res = await call({
    ...ASK,
    messages: [{ role: "user", content: `please remember ${marker}` }],
  });
  expect(res.status).toBe(200);

  // The artifact really did capture it, so the absence below is redaction
  // rather than capture having quietly done nothing.
  expect(JSON.stringify(await artifactOf(store, "req_1"))).toContain(marker);
  expect(logger.lines.length).toBeGreaterThan(0);
  expect(logger.lines.join("\n")).not.toContain(marker);
  expect(JSON.stringify(logger.records)).not.toContain(marker);
  await cleanup(store, root);
});

/**
 * Headers are where every provider's credential lives, and the decorator never
 * receives them.
 *
 * The credential below is deliberately one the masker would *not* catch — no
 * `sk-`/`ak-`/`pk-` prefix, under the forty-one character opaque threshold, and
 * carried in `x-api-key` rather than after a `Bearer` scheme the masker
 * recognises. A bearer token would be elided by masking even if headers were
 * captured, so a test using one passes whether or not the exclusion holds.
 */
test("keeps an upstream credential out of every artifact", async () => {
  const secret = "upstream-secret-9f2a";
  const { store, root, call } = await harness({
    allowed: true,
    settings: { ...CAPTURE_ON, bodyLoggingCaptureStreamChunks: true },
    credential: { authType: "apiKey", apiKey: secret },
  });

  expect((await call(ASK)).status).toBe(200);

  const read = await store.bodies.get("req_1");
  expect(read?.artifact).not.toBeNull();
  expect(JSON.stringify(read?.artifact)).not.toContain(secret);
  // And not in the bytes on disk either, which is where a capture that stashed
  // headers somewhere the reader ignores would still show up.
  const relPath = read?.row.relPath;
  if (relPath === undefined || relPath === null) throw new Error("expected a stored artifact");
  const bytes = await readFile(join(root, "request_bodies", relPath), "utf8");
  expect(bytes).not.toContain(secret);
  await cleanup(store, root);
});

// ---------------------------------------------------------------------------
// Non-interference
// ---------------------------------------------------------------------------

/** Reads a stream to a string, the way an adapter's SSE parser would. */
async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function fixedRequest(): HttpRequest {
  return {
    provider: "anthropic",
    url: "https://example.invalid/v1/messages",
    method: "POST",
    headers: [["Authorization", "Bearer never-captured"]],
    body: JSON.stringify({ model: "claude-opus-4" }),
    signal: new AbortController().signal,
  };
}

test("delivers the adapter the same bytes with capture on and off", async () => {
  const source = (): HttpClient => async (req) => bodyOf(ANTHROPIC_FRAMES, req.signal);

  const bare = await readAll((await source()(fixedRequest())).body);
  const collector = createBodyCollector({ captureStreamChunks: false });
  const wrapped = await readAll((await collector.wrap(source())(fixedRequest())).body);

  expect(wrapped).toBe(bare);
  expect(wrapped).toBe(ANTHROPIC_FRAMES.join(""));
  await collector.settle();
  expect(String(collector.attempts()[0]?.response)).toBe(bare);
});

/**
 * The adapter's branch must not wait for the capture branch.
 *
 * The mistake this guards against is buffering the whole response and handing
 * the adapter a replay of it, which passes a byte-equality test and turns every
 * streamed token into a latency bug. So the assertion is about *when*: the
 * adapter reads the first frame while the response is still arriving and while
 * the capture drain has recorded nothing final.
 */
test("hands the adapter its first frame before the capture branch has finished", async () => {
  const controller = new AbortController();
  const collector = createBodyCollector({ captureStreamChunks: false });
  const http = collector.wrap(async (req) => bodyOf(ANTHROPIC_FRAMES, req.signal, 1));

  const res = await http({ ...fixedRequest(), signal: controller.signal });
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");

  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("message_start");
  // The source is still open, so nothing has finished draining. The response
  // arrived anyway.
  expect(collector.attempts()[0]?.response).toBe(null);

  controller.abort();
  await reader.cancel().catch(() => undefined);
  await collector.settle();
  // The drain ended on the source erroring rather than on the stream ending,
  // which is exactly the truncation a cut-off response should record.
  expect(collector.attempts()[0]?.truncated).toBe(true);
});

/**
 * A drain still running contributes what it has read, not nothing.
 *
 * This is the partial-artifact guarantee `Attempt` is mutable for: a hung
 * upstream or a stream cut off by a disconnect should leave a truncated body in
 * the artifact rather than an empty one. It is pinned here because the response
 * text is held as segments and joined at read time — joining once at the end of
 * the drain instead is cheaper-looking, passes every settled test above, and
 * turns exactly this case into an empty string.
 */
test("reports what a still-running drain has already read", async () => {
  const controller = new AbortController();
  const collector = createBodyCollector({ captureStreamChunks: false });
  const http = collector.wrap(async (req) => bodyOf(ANTHROPIC_FRAMES, req.signal, 2));

  const res = await http({ ...fixedRequest(), signal: controller.signal });
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");

  // Drive the adapter's branch far enough that the tee has released both
  // delivered frames, then let the capture drain's pending reads run. Reading
  // to the end would hang: the source stays open until the abort below.
  await reader.read();
  await reader.read();

  // Waited for rather than counted in microtask ticks. How many turns the tee
  // needs to hand the capture branch its chunks is a scheduling detail, and a
  // fixed tick count is a test that passes on an idle machine and reports a
  // product bug on a loaded one. The deadline still fails if nothing arrives.
  const deadline = Date.now() + 2_000;
  while (collector.attempts()[0]?.response === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const partial = String(collector.attempts()[0]?.response);
  expect(partial).toContain("message_start");
  // Still open, so this is genuinely a drain in flight rather than a finished one.
  expect(partial).not.toBe(ANTHROPIC_FRAMES.join(""));

  controller.abort();
  await reader.cancel().catch(() => undefined);
  await collector.settle();
});

/**
 * The stronger form of the same rule, and the one the spec states outright: a
 * capture branch that has stalled must not hold the adapter's bytes up.
 *
 * The stall here is a promise the test resolves, not a timer, so a delivery path
 * that waited on capture would not be slow — it would never finish, and this
 * test would hang rather than pass a little later. The tee is replaced rather
 * than the source slowed, because slowing the source delays both halves and
 * proves nothing about which one waits for the other.
 */
test("delivers the adapter's stream while the capture branch is stalled", async () => {
  const collector = createBodyCollector({ captureStreamChunks: false });
  let release = (): void => {};
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });

  const http = collector.wrap(async (req) => {
    const res = bodyOf(ANTHROPIC_FRAMES, req.signal);
    const source = res.body;
    if (source === null) throw new Error("expected a body");
    const [adapterBranch, captureBranch] = source.tee();
    // The collector tees on first touch; it gets these two, with the capture
    // half gated behind the stall.
    source.tee = () => [
      adapterBranch,
      new ReadableStream<Uint8Array>({
        async start(controller) {
          await stalled;
          const reader = captureBranch.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done === true) break;
            if (value !== undefined) controller.enqueue(value);
          }
          controller.close();
        },
      }),
    ];
    return res;
  });

  const res = await http(fixedRequest());
  expect(await readAll(res.body)).toBe(ANTHROPIC_FRAMES.join(""));
  // The adapter is finished and capture has not seen a byte.
  expect(collector.attempts()[0]?.response).toBeNull();

  release();
  await collector.settle();
  expect(String(collector.attempts()[0]?.response)).toBe(ANTHROPIC_FRAMES.join(""));
});

/**
 * The capture branch is drained to the end even once nothing it reads can be
 * kept.
 *
 * Stopping at the cap would leave the tee's second branch unread and un-cancelled
 * — the source then buffers for it for as long as the response lasts, which is
 * the latency bug the spec forbids in as many words. So the loop reads past the
 * cap and throws the bytes away, and the observable consequence is that the
 * source is exhausted even though the adapter stopped reading after one chunk.
 */
test("drains the capture branch past its byte cap rather than abandoning it", async () => {
  const CHUNK = 64 * 1024;
  const chunks = Math.ceil((MAX_CAPTURED_BODY_BYTES * 1.5) / CHUNK);
  const filler = new TextEncoder().encode("a".repeat(CHUNK));
  let pulled = 0;
  let closed = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) {
        closed = true;
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(filler);
    },
  });

  const collector = createBodyCollector({ captureStreamChunks: false });
  const http = collector.wrap(async () => ({
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: source,
    text: async () => "",
  }));

  const res = await http(fixedRequest());
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("expected a body");
  // One chunk, then the adapter loses interest without cancelling — a decoder
  // that has seen its terminal event does exactly this.
  await reader.read();
  await collector.settle();

  expect(pulled).toBe(chunks);
  expect(closed).toBe(true);
  const attempt = collector.attempts()[0];
  expect(attempt?.truncated).toBe(true);
  // Read to the end, kept to the cap: the bytes past it were dropped, not stored.
  expect(String(attempt?.response).length).toBeLessThanOrEqual(MAX_CAPTURED_BODY_BYTES + CHUNK);
});

/**
 * The sink keeps what it can and admits what it could not.
 *
 * Both halves matter and each hides a different defect. Keeping every frame
 * inside the cap is what a "the last frame is message_stop" assertion cannot
 * see — a sink that recorded only the final frame of every stream would satisfy
 * it — and the flag is the only trace an eviction leaves anywhere.
 */
test("the frame sink keeps everything inside its cap and marks what it drops", () => {
  const sink = createFrameSink();
  for (const frame of ["first", "second", "third"]) sink.write(frame);
  expect(sink.frames).toEqual(["first", "second", "third"]);
  expect(sink.truncated).toBe(false);

  // Four frames of two hundred kilobytes, against a cap of five hundred and
  // twelve: the first two and everything before them have to go.
  const big = "y".repeat(200_000);
  for (let i = 0; i < 4; i++) sink.write(`${i}:${big}`);

  expect(sink.truncated).toBe(true);
  expect(sink.frames.map((frame) => frame.slice(0, 2))).toEqual(["2:", "3:"]);
  expect(sink.frames.reduce((n, frame) => n + frame.length, 0)).toBeLessThanOrEqual(
    MAX_CAPTURED_BODY_BYTES,
  );
});

/**
 * The eviction loop stops at one frame rather than at none.
 *
 * A frame can be larger than the whole cap on its own — a tool result or an
 * image comes back as a single `message_delta` — and evicting it leaves the
 * sink empty, which is not a bounded record of the stream but the absence of
 * one. Keeping it is the same choice the artifact writer makes when a bounded
 * payload is still oversized: record something and say it was cut, never
 * silently record nothing.
 */
test("the frame sink keeps a lone frame that is larger than the cap on its own", () => {
  const sink = createFrameSink();
  const huge = `data: ${"z".repeat(MAX_CAPTURED_BODY_BYTES)}`;
  sink.write(huge);

  expect(sink.frames).toEqual([huge]);
  // Nothing was dropped, so nothing is claimed to have been.
  expect(sink.truncated).toBe(false);

  // And the next frame evicts it rather than the loop having simply given up:
  // the cap still governs once there is more than one frame to choose between.
  sink.write("data: after");
  expect(sink.frames).toEqual(["data: after"]);
  expect(sink.truncated).toBe(true);
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

function artifactFor(requestId: string, at: number): BodyArtifact {
  return {
    schemaVersion: 1,
    requestId,
    at,
    client: { request: { model: "fast" }, response: { ok: true }, truncated: false },
    attempts: [],
    error: null,
  };
}

test("sweeps body rows and their files on the retention window, the row cap, and orphans", async () => {
  const { store, root } = await tempStore();
  const day = 24 * 60 * 60 * 1000;
  const now = 500 * day;

  await store.bodies.put(artifactFor("req_expired", now - 31 * day));
  await store.bodies.put(artifactFor("req_kept_a", now - 2 * day));
  await store.bodies.put(artifactFor("req_kept_b", now - 1 * day));
  await store.bodies.put(artifactFor("req_kept_c", now - 1000));
  // A file whose row never landed, which a crash between the two writes leaves.
  const orphan = await store.bodies.put(artifactFor("req_orphan", now - 1000));
  store.close();
  const reopened = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey(ENCRYPTION_KEY),
  });
  await reopened.config.putSettings({ logRetentionDays: 30 });
  // Drop the row and leave the file, the way an interrupted write would.
  await dropRow(root, "req_orphan");

  const swept = await pruneLogs(reopened, now);
  expect(swept.bodies).toBe(1);
  expect(swept.bodyOrphans).toBe(1);
  expect(await reopened.bodies.get("req_expired")).toBeNull();
  expect((await reopened.bodies.get("req_kept_c"))?.artifact).not.toBeNull();
  await expect(readFile(join(root, "request_bodies", orphan.relPath ?? ""))).rejects.toThrow();

  // The window keeps three rows; a cap of one prunes the two oldest with their
  // files, which is the bound that actually holds disk down.
  expect(await reopened.bodies.pruneToCap(1)).toBe(2);
  expect(await reopened.bodies.get("req_kept_a")).toBeNull();
  expect((await reopened.bodies.get("req_kept_c"))?.artifact).not.toBeNull();

  await cleanup(reopened, root);
});

/**
 * The row cap is what actually bounds disk, and it only does so if the sweep
 * runs it.
 *
 * Asserted through `pruneLogs` rather than by calling `pruneToCap` directly:
 * the cap's real default is a hundred thousand rows and no test creates those,
 * so what is at stake here is the wiring — and the wiring is precisely what a
 * direct call does not exercise.
 */
test("the hourly sweep runs the body row cap at the repository's own default", async () => {
  const { store, root } = await tempStore();
  const caps: Array<number | undefined> = [];
  store.bodies.pruneToCap = async (cap) => {
    caps.push(cap);
    return 3;
  };

  const swept = await pruneLogs(store, NOW);

  // Once, with no cap of its own, so the bound is the repository's rather than
  // one the sweep invented, and what it removed is reported rather than dropped.
  expect(caps).toEqual([undefined]);
  expect(swept.bodiesOverCap).toBe(3);
  await cleanup(store, root);
});

/** Deletes one row, leaving its artifact file behind. */
async function dropRow(root: string, requestId: string): Promise<void> {
  const { openDb } = await import("@omni/store");
  const db = openDb(join(root, "omnigateway.db"));
  db.run("DELETE FROM request_bodies WHERE request_id = ?", [requestId]);
  db.close();
}
