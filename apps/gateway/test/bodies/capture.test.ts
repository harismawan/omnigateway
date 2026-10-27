import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger } from "@omni/ir";
import { ADAPTERS, type HttpClient } from "@omni/providers";
import { createStore, deriveKey, type Store } from "@omni/store";
import { seedApiKey, seedCredential, target, virtualModel } from "@omni/testkit";
import { type CaptureBudget, createCaptureBudget } from "../../src/bodies/budget.ts";
import { createBodyWriterHost } from "../../src/bodies/host.ts";
import { spawnBodyWriter } from "../../src/bodies/spawn.ts";
import { proxyRoutes } from "../../src/routes/proxy.ts";
import { createTelemetry, type Telemetry } from "../../src/telemetry/index.ts";

/**
 * Body capture under the global byte budget, through the route. Design:
 * docs/superpowers/specs/2026-10-24-log-export-design.md (*Memory and the
 * request path*, §1): a reservation past the budget abandons that request's
 * capture — never the request — and the artifact says so.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const KIB = 1024;
const MIB = 1024 * KIB;
const OMISSION = { omitted: true, reason: "capture budget exhausted", serializedBytes: null };

const encoder = new TextEncoder();

/** An Anthropic stream whose text arrives as `deltas` frames of `deltaBytes` each. */
function anthropicFrames(deltas: number, deltaBytes: number): string[] {
  // Spaces break every run, so no masking rule touches the text.
  const text = "lorem ipsum ".repeat(Math.ceil(deltaBytes / 12)).slice(0, deltaBytes);
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_up","model":"claude-opus-4","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    ...Array.from(
      { length: deltas },
      (_, i) =>
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${i}:${text}"}}\n\n`,
    ),
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

/** An upstream that streams `frames` as fast as they are read. */
function streaming(frames: string[]): HttpClient {
  return async () => {
    let i = 0;
    return {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames[i++];
          if (frame === undefined) controller.close();
          else controller.enqueue(encoder.encode(frame));
        },
      }),
      text: async () => frames.join(""),
    };
  };
}

/**
 * An upstream that hands out one frame per `release()`, so a test decides when
 * each byte exists and can watch where it gets to without reading a clock.
 */
function gated(frames: string[]): { http: HttpClient; release: () => void; done: () => boolean } {
  let released = 0;
  let wake: (() => void) | null = null;
  return {
    release() {
      released += 1;
      wake?.();
      wake = null;
    },
    done: () => released >= frames.length,
    http: async () => {
      let i = 0;
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            while (i >= released) await new Promise<void>((resolve) => (wake = resolve));
            const frame = frames[i++];
            if (frame === undefined) controller.close();
            else controller.enqueue(encoder.encode(frame));
          },
        }),
        text: async () => frames.join(""),
      };
    },
  };
}

/** Records the most it ever held, so "never past the budget" is measured rather than assumed. */
function watched(limit: number): CaptureBudget & { peak: () => number } {
  const inner = createCaptureBudget(limit);
  let peak = 0;
  return {
    reserve(bytes) {
      const ok = inner.reserve(bytes);
      peak = Math.max(peak, inner.held());
      return ok;
    },
    release: (bytes) => inner.release(bytes),
    held: () => inner.held(),
    peak: () => peak,
  };
}

function metrics(): Telemetry {
  return createTelemetry({
    metricsEnabled: true,
    maxSeries: 100,
    otlpEndpoint: null,
    otlpHeaders: {},
    traceSample: 1,
    now: () => NOW,
    version: "test",
  });
}

type Harness = {
  store: Store;
  call: (body: unknown) => Promise<Response>;
  cleanup: () => Promise<void>;
};

async function harness(options: {
  http: HttpClient;
  capture: boolean;
  budget?: CaptureBudget;
  telemetry?: Telemetry;
}): Promise<Harness> {
  const root = join(tmpdir(), `omni-capture-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const store = await createStore({
    path: join(root, "omnigateway.db"),
    encryptionKey: await deriveKey("test-encryption-key-0123456789"),
  });
  await store.config.putSettings({ bodyLoggingEnabled: true });
  await seedCredential(store, { id: "c1", provider: "anthropic" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  const { raw } = await seedApiKey(store, { label: "k" });
  const budget = options.budget ?? createCaptureBudget(512 * MIB);
  const writer = createBodyWriterHost({
    spawn: () =>
      spawnBodyWriter({
        databasePath: store.databasePath,
        databaseUrl: null,
        encryptionKey: "test-encryption-key-0123456789",
      }),
    bodies: store.bodies,
    budget,
    logger: noopLogger,
    now: () => NOW,
    timers: { setTimeout, clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
  });
  await writer.start();
  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: ADAPTERS,
    http: options.http,
    now: () => NOW,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    bodyLoggingAllowed: options.capture,
    bodyWriter: writer,
    captureBudget: budget,
    ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
  });
  return {
    store,
    call: (body) =>
      app.handle(
        new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
    cleanup: async () => {
      await writer.pause();
      writer.stop();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const ASK = { model: "fast", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

/** Event-loop turns with nothing new before a release's window is closed. */
const QUIET = 50;

/** Waits for a request's body state to leave `pending`, which happens after its stream ends. */
async function settledState(store: Store, id: string): Promise<string | null | undefined> {
  for (let i = 0; i < 400; i++) {
    const state = (await store.usage.get(id))?.bodyState;
    if (state !== "pending") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`body state of ${id} never settled`);
}

async function artifactOf(store: Store, id: string) {
  const read = await store.bodies.get(id);
  if (read?.artifact === null || read === null) throw new Error(`no artifact for ${id}`);
  return read.artifact;
}

// ---------------------------------------------------------------------------
// The budget across concurrent streams
// ---------------------------------------------------------------------------

test("concurrent long streams never hold more than the budget, and each is abandoned, not slowed", async () => {
  const budget = watched(1 * MIB);
  const telemetry = metrics();
  // Thirty-two 64 KiB deltas: 2 MiB of text a stream, twice over once the
  // client's frames are counted beside the wire's.
  const frames = anthropicFrames(32, 64 * KIB);
  const h = await harness({ http: streaming(frames), capture: true, budget, telemetry });
  try {
    const responses = await Promise.all([1, 2, 3].map(() => h.call({ ...ASK, stream: true })));
    const bodies = await Promise.all(responses.map((res) => res.text()));
    for (const body of bodies) {
      expect(body).toContain("message_stop");
      expect(body.match(/event: content_block_delta/g)?.length).toBe(32);
    }

    for (const id of ["req_1", "req_2", "req_3"]) {
      expect(`${id}: ${await settledState(h.store, id)}`).toBe(`${id}: omitted`);
      const artifact = await artifactOf(h.store, id);
      expect(artifact.client).toEqual({ request: OMISSION, response: OMISSION, truncated: true });
      expect(artifact.attempts.map((a) => [a.provider, a.request, a.truncated])).toEqual([
        ["anthropic", OMISSION, true],
      ]);
      // The row itself is untouched by what happened to its body.
      expect((await h.store.usage.get(id))?.status).toBe(200);
    }
    // Something was held — the capture really ran — and never past the line.
    expect(budget.peak()).toBeGreaterThan(512 * KIB);
    expect(budget.peak()).toBeLessThanOrEqual(1 * MIB);
    expect(telemetry.registry.value("omni_bodies_dropped_total", { reason: "budget" })).toBe(3);
    // Every abandoned capture gave its bytes back: the whole budget is free again.
    expect(budget.held()).toBe(0);
    expect(budget.reserve(1 * MIB)).toBe(true);
  } finally {
    await h.cleanup();
  }
});

/**
 * "Not slowed", measured without a clock.
 *
 * The upstream releases one frame at a time, and after each release the test
 * lets the event loop run until it has gone quiet — `QUIET` turns with no new
 * client bytes — writing down which client bytes arrived in that window. A
 * capture that held the client's bytes back — buffering them, waiting on its
 * own branch, pacing delivery to anything but the upstream — shows up as a
 * frame landing after a later release than it does in a run that captures
 * nothing, or not at all. The two transcripts must be identical, and the bytes
 * the client reads must be too.
 *
 * Quiet rather than a fixed count of turns: setting capture up (a settings
 * read, the request text) costs turns before the head that are not the stream,
 * and a fixed window let them spill into the next release under load.
 */
test("a stream whose capture is abandoned reaches the client byte-identical and on the same turns", async () => {
  const frames = anthropicFrames(12, 16 * KIB);

  async function transcript(
    capture: boolean,
    budget?: CaptureBudget,
  ): Promise<{
    log: string[];
    bytes: string;
    store: Store;
    cleanup: () => Promise<void>;
  }> {
    const upstream = gated(frames);
    const h = await harness({
      http: upstream.http,
      capture,
      ...(budget === undefined ? {} : { budget }),
    });
    const log: string[] = [];
    const chunks: string[] = [];
    const pending = h.call({ ...ASK, stream: true });
    // The head needs the first frames to commit, so it lands inside a release's window.
    let res: Response | null = null;
    void pending.then((r) => {
      res = r;
    });
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    /** Runs turns until `QUIET` pass with nothing new reaching the client (or a head). */
    const quiet = async () => {
      let seen = -1;
      for (let still = 0, spent = 0; still < QUIET && spent < 10_000; spent++) {
        const now = log.length + (res === null ? 0 : 1);
        still = now === seen ? still + 1 : 0;
        seen = now;
        await turn();
      }
    };
    const reading = (async () => {
      while (res === null) await turn();
      const reader = (res as Response).body?.getReader();
      if (reader === undefined) throw new Error("expected a stream");
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        chunks.push(text);
        log.push(`client ${text.match(/^event: (\w+)/)?.[1] ?? "?"}`);
      }
    })();
    for (let i = 0; !upstream.done(); i++) {
      log.push(`release ${i}`);
      upstream.release();
      await quiet();
    }
    upstream.release();
    await reading;
    return { log, bytes: chunks.join(""), store: h.store, cleanup: h.cleanup };
  }

  const bare = await transcript(false);
  // Room for the request and the first two deltas on both sides, then not.
  const budget = watched(48 * KIB);
  const captured = await transcript(true, budget);
  try {
    expect(captured.bytes).toBe(bare.bytes);
    expect(captured.log).toEqual(bare.log);
    // Every delta reached the client in the window its release opened.
    const deltas = bare.log.filter((line) => line === "client content_block_delta").length;
    expect(deltas).toBe(12);

    // It was abandoned mid-stream, not before it began.
    expect(budget.peak()).toBeGreaterThan(32 * KIB);
    expect(await settledState(captured.store, "req_1")).toBe("omitted");
    expect((await artifactOf(captured.store, "req_1")).client.response).toEqual(OMISSION);
    expect(budget.held()).toBe(0);
    // Uncaptured: no body state, no artifact.
    expect((await bare.store.usage.get("req_1"))?.bodyState).toBeNull();
    expect(await bare.store.bodies.get("req_1")).toBeNull();
  } finally {
    await bare.cleanup();
    await captured.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The row's body state, and the reservation's lifetime
// ---------------------------------------------------------------------------

test("a captured request is pending while in flight and ready once its body is written", async () => {
  const frames = anthropicFrames(2, 64);
  const upstream = gated(frames);
  const budget = watched(64 * MIB);
  const h = await harness({ http: upstream.http, capture: true, budget });
  try {
    const pending = h.call(ASK);
    // Release until routing has begun the row.
    for (let i = 0; i < 4 && (await h.store.usage.get("req_1")) === null; i++) {
      upstream.release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await h.store.usage.get("req_1"))?.bodyState).toBe("pending");
    while (!upstream.done()) upstream.release();
    upstream.release();
    const res = await pending;
    const sent = await res.text();

    expect(res.status).toBe(200);
    expect(await settledState(h.store, "req_1")).toBe("ready");
    const artifact = await artifactOf(h.store, "req_1");
    // The response captured is the string the client was sent, parsed once by the writer.
    expect(artifact.client.response).toEqual(JSON.parse(sent));
    expect(artifact.client.request).toEqual(ASK);
    expect(budget.held()).toBe(0);
  } finally {
    await h.cleanup();
  }
});

test("the reservation is held until the write and released after it, even when it fails", async () => {
  const budget = watched(64 * MIB);
  const h = await harness({ http: streaming(anthropicFrames(1, 64)), capture: true, budget });
  try {
    const heldAtPublish: number[] = [];
    const publish = h.store.bodies.publish;
    h.store.bodies.publish = async (row) => {
      heldAtPublish.push(budget.held());
      if (heldAtPublish.length === 2) throw new Error("artifact volume is full");
      return publish(row);
    };

    expect((await h.call(ASK)).status).toBe(200);
    expect(await settledState(h.store, "req_1")).toBe("ready");
    expect((await h.call(ASK)).status).toBe(200);
    expect(await settledState(h.store, "req_2")).toBe("failed");

    // Held while the write ran: at least the request text.
    expect(heldAtPublish).toHaveLength(2);
    for (const held of heldAtPublish)
      expect(held).toBeGreaterThanOrEqual(JSON.stringify(ASK).length);
    for (let i = 0; i < 100 && budget.held() > 0; i++) await Bun.sleep(5);
    expect(budget.held()).toBe(0);
    expect((await h.store.usage.get("req_1"))?.bodyState).toBe("ready");
    expect((await h.store.usage.get("req_2"))?.bodyState).toBe("failed");
  } finally {
    await h.cleanup();
  }
});

test("a body over the artifact limit is recorded as omitted, not ready", async () => {
  const h = await harness({ http: streaming(anthropicFrames(1, 64)), capture: true });
  try {
    // Too deep for the native serializer: omitted however small.
    let deep = '"leaf"';
    for (let i = 0; i < 100_000; i++) deep = `[${deep}]`;
    const body = `{"model":"fast","max_tokens":1,"messages":[{"role":"user","content":"hi"}],"metadata":{"x":${deep}}}`;
    const res = await h.call(body);
    await res.text();
    expect(await settledState(h.store, "req_1")).toBe("omitted");
    const artifact = await artifactOf(h.store, "req_1");
    expect(artifact.client.request).toEqual({
      omitted: true,
      reason: "nesting too deep",
      serializedBytes: null,
    });
  } finally {
    await h.cleanup();
  }
}, 20_000);

test("a request refused before routing is still captured, as the text that arrived", async () => {
  const h = await harness({ http: streaming([]), capture: true });
  try {
    const res = await h.call("{not json");
    expect(res.status).toBe(500);
    const sent = await res.text();
    expect(await settledState(h.store, "req_1")).toBe("ready");
    const row = await h.store.usage.get("req_1");
    expect(row?.state).toBe("done");
    expect(row?.bodyState).toBe("ready");
    const artifact = await artifactOf(h.store, "req_1");
    // Not JSON, so kept as the string it was.
    expect(artifact.client.request).toBe("{not json");
    expect(artifact.client.response).toEqual(JSON.parse(sent));
    expect(artifact.attempts).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("a request with capture off carries no body state and writes nothing", async () => {
  const h = await harness({ http: streaming(anthropicFrames(1, 64)), capture: false });
  try {
    expect((await h.call(ASK)).status).toBe(200);
    expect((await h.store.usage.get("req_1"))?.bodyState).toBeNull();
    expect(await h.store.bodies.get("req_1")).toBeNull();
  } finally {
    await h.cleanup();
  }
});
