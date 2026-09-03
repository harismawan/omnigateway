import { createAdminAuth } from "@omni/control";
import { memoryCoord } from "@omni/coord";
import type { Store } from "@omni/store";
import { captureLogger, memoryStore, seedApiKey } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import type { Broadcaster } from "../../src/stream/broadcaster.ts";
import { createBroadcaster } from "../../src/stream/broadcaster.ts";
import { type ChannelRegistry, createChannelRegistry } from "../../src/stream/channels.ts";
import type { Schedule } from "../../src/stream/coalescer.ts";
import { createSocketRegistry, type SocketRegistry } from "../../src/stream/registry.ts";
import { createRing, type Ring } from "../../src/stream/ring.ts";

/**
 * A gateway on a real port, because a WebSocket upgrade cannot be driven
 * through `app.handle(new Request(...))`.
 *
 * The shape follows the one existing precedent for this in the suite,
 * `test/routes/proxy.test.ts`: listen on 0, read the assigned port off
 * `app.server`, talk to it with a real client, and `await app.stop(true)` in a
 * `finally`. Forceful, because a test that left a socket open would otherwise
 * wait out the drain.
 */
export type StreamHarness = {
  port: number;
  /** An operator session. The three below are the other principals. */
  cookie: string;
  /** A read-only administrator's session. */
  viewerCookie: string;
  /** A key holder's session, and the key it was opened with. */
  clientCookie: string;
  clientKeyId: string;
  /** The store behind the app, for a test that has to revoke that key. */
  store: Store;
  registry: SocketRegistry;
  broadcaster: Broadcaster;
  ring: Ring;
  /** The plugin channels this gateway knows about. Empty until a test opens one. */
  channels: ChannelRegistry;
  /** Everything the gateway logged, for the lines that are batched rather than per-event. */
  logger: ReturnType<typeof captureLogger>;
  /** Runs whatever is already due without advancing the clock. */
  settle(): void;
  /** Advances the injected heartbeat clock and fires whatever is due. */
  beat(): Promise<void>;
  connect(headers?: Record<string, string>): Promise<TestSocket>;
  close(): Promise<void>;
};

export type TestSocket = {
  socket: WebSocket;
  /** Every server frame received, parsed. */
  frames: unknown[];
  closes: { code: number; reason: string }[];
  send(frame: unknown): void;
  /** Resolves when a frame satisfying the predicate arrives, or times out. */
  waitFor(match: (frame: unknown) => boolean, label: string): Promise<unknown>;
  waitForClose(label: string): Promise<{ code: number; reason: string }>;
  close(): void;
};

const PASSWORD = "correct-horse-battery-staple";
const VIEWER_PASSWORD = "read-only-horse-battery";

async function until<T>(poll: () => T | undefined, label: string, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = poll();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

export async function streamHarness(
  over: { heartbeatMs?: number; pongDeadlineMs?: number } = {},
): Promise<StreamHarness> {
  const store = await memoryStore();

  let clock = Date.now();
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const schedule: Schedule = (run, ms) => {
    const timer = { at: clock + ms, run, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  const logger = captureLogger();
  // Late-bound exactly as production does it, so the harness exercises the same
  // wiring rather than a simpler one that would hide a missing hook-up.
  let channelsRef: ChannelRegistry | undefined;
  const registry = createSocketRegistry({
    onDetach: (id, topics) => channelsRef?.closed(id, topics),
    logger,
    now: () => clock,
    schedule,
    heartbeatMs: over.heartbeatMs ?? 20_000,
    ...(over.pongDeadlineMs === undefined ? {} : { pongDeadlineMs: over.pongDeadlineMs }),
  });
  const ring = createRing({ frames: 100, bytes: 1024 * 1024 });
  const broadcaster = createBroadcaster({
    registry,
    ring,
    coord: memoryCoord({ now: () => clock }),
    nodeId: "test-node",
    now: () => clock,
    schedule,
  });
  // The error report is drained by the same injected scheduler the heartbeat
  // uses, so a test can assert one batched line rather than sleeping for it.
  const channels = createChannelRegistry({
    sockets: registry,
    fanout: (topic, payload) => broadcaster.channel(topic, payload),
    logger,
    scheduler: (run) => schedule(run, 0),
  });
  channelsRef = channels;

  // The app builds its own AdminAuth, so a session is minted through a second
  // one over the same store rather than by reaching into the app.
  const admin = createAdminAuth(store, { now: () => Date.now(), sessionTtlMs: 12 * 3_600_000 });
  await admin.setInitialPassword(PASSWORD);
  // The other two principals, minted over the same store for the same reason.
  await admin.setViewerPassword(VIEWER_PASSWORD);
  const key = await seedApiKey(store, { label: "socket" });

  const app = createApp({
    store,
    baseUrl: "http://localhost",
    registry,
    broadcaster,
    ring,
    channels,
    logger,
  });
  app.listen({ port: 0, hostname: "127.0.0.1", idleTimeout: 255 });
  const server = app.server;
  if (server === null) throw new Error("app did not start listening");

  // Typed optional because a server can be listening on a unix socket, which has
  // no port. This one asked for TCP on port 0, so an absent port is a broken
  // assumption rather than a case to handle.
  const { port } = server;
  if (port === undefined) throw new Error("app is not listening on a TCP port");

  const login = await app.handle(
    new Request(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  const setCookie = login.headers.get("set-cookie");
  if (setCookie === null) throw new Error(`login did not set a cookie (${login.status})`);
  const cookie = setCookie.split(";")[0] ?? "";

  /** A cookie for one of the other two principals, through their real routes. */
  const sessionFor = async (path: string, body: unknown): Promise<string> => {
    const res = await app.handle(
      new Request(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const header = res.headers.get("set-cookie");
    if (header === null) throw new Error(`${path} did not set a cookie (${res.status})`);
    return header.split(";")[0] ?? "";
  };
  const viewerCookie = await sessionFor("/api/login", {
    password: VIEWER_PASSWORD,
    mode: "viewer",
  });
  const clientCookie = await sessionFor("/api/client/login", { key: key.raw });

  const open: TestSocket[] = [];

  return {
    port,
    cookie,
    viewerCookie,
    clientCookie,
    clientKeyId: key.key.id,
    store,
    registry,
    broadcaster,
    ring,
    channels,
    logger,

    settle() {
      // Fires what is already due without moving the clock. The batched channel
      // error report is scheduled at zero delay, so a test asserting one line
      // per plugin would otherwise have to buy a whole heartbeat to see it.
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.run();
        }
      }
    },

    async beat() {
      clock += over.heartbeatMs ?? 20_000;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= clock) {
          timer.cancelled = true;
          timer.run();
        }
      }
      // Lets the revalidation promise inside the tick settle before a caller
      // asserts on what it did.
      await Bun.sleep(20);
    },

    async connect(headers = {}) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/stream`, { headers });
      const frames: unknown[] = [];
      const closes: { code: number; reason: string }[] = [];
      let opened = false;

      socket.addEventListener("open", () => {
        opened = true;
      });
      socket.addEventListener("message", (event) => {
        frames.push(JSON.parse(String(event.data)));
      });
      socket.addEventListener("close", (event) => {
        closes.push({ code: event.code, reason: event.reason });
      });
      socket.addEventListener("error", () => {
        // A refused upgrade surfaces as an error followed by a close. The close
        // is what tests assert on; swallowing this stops it becoming an
        // unhandled event.
      });

      const testSocket: TestSocket = {
        socket,
        frames,
        closes,
        send(frame) {
          socket.send(JSON.stringify(frame));
        },
        async waitFor(match, label) {
          return await until(() => frames.find(match), label);
        },
        async waitForClose(label) {
          return await until(() => closes[0], label);
        },
        close() {
          socket.close();
        },
      };
      open.push(testSocket);

      // Settles into whichever terminal state the upgrade reached, so a caller
      // asserting a refusal does not have to know it never opened.
      await until(
        () => (opened || closes.length > 0 ? true : undefined),
        "the socket to open or be refused",
      );
      return testSocket;
    },

    async close() {
      for (const item of open) item.socket.close();
      registry.stop();
      broadcaster.stop();
      channels.stop();
      await app.stop(true);
      store.close();
    },
  };
}
