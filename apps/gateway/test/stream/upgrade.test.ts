import { expect, test } from "bun:test";
import { memoryStore } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { streamHarness } from "./harness.ts";

test("a plain GET on /api/stream answers 426 rather than falling through to a 404", async () => {
  // No listening server needed: without an `upgrade: websocket` header the ws
  // route does not match, so this is an ordinary request. Without the companion
  // GET it would reach the static catch-all and 404 an endpoint that exists.
  const store = await memoryStore();
  const app = createApp({ store, baseUrl: "http://localhost" });

  const response = await app.handle(new Request("http://localhost/api/stream"));

  expect(response.status).toBe(426);
  expect(await response.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  store.close();
});

test("an upgrade with a valid admin cookie opens", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });

    expect(socket.closes).toEqual([]);
    expect(h.registry.stats().connections).toBe(1);
  } finally {
    await h.close();
  }
});

test("an upgrade with no admin cookie never opens", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect();

    expect(socket.closes.length).toBe(1);
    expect(h.registry.stats().connections).toBe(0);
  } finally {
    await h.close();
  }
});

test("an upgrade carrying both a bearer token and an admin cookie is refused", async () => {
  // The same rule the `/v1/*` surface applies to Bearer and `x-api-key`: two
  // credentials is an ambiguous request, not a request with a preference.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie, authorization: "Bearer something" });

    expect(socket.closes.length).toBe(1);
    expect(h.registry.stats().connections).toBe(0);
  } finally {
    await h.close();
  }
});

test("an upgrade with a bogus cookie never opens", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: "omni_admin=not-a-session" });

    expect(socket.closes.length).toBe(1);
    expect(h.registry.stats().connections).toBe(0);
  } finally {
    await h.close();
  }
});

test("an expired session closes the socket 4401 at the next heartbeat", async () => {
  // The literal, not the constant: an assertion written against the imported
  // symbol moves with a mutation to it and proves nothing. 4401 is what tells
  // the client to authenticate again rather than reconnect for ever.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    expect(h.registry.stats().connections).toBe(1);

    // Logging out ends the session the socket authenticated with, which is the
    // case the guard exists for: the connection is still open and is now held
    // by nobody.
    await fetch(`http://127.0.0.1:${h.port}/api/logout`, {
      method: "POST",
      headers: { cookie: h.cookie },
    });
    await h.beat();

    const closed = await socket.waitForClose("the socket to close");
    expect(closed.code).toBe(4401);
  } finally {
    await h.close();
  }
});

test("a live session survives the heartbeat", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    await h.beat();

    expect(socket.closes).toEqual([]);
    expect(h.registry.stats().connections).toBe(1);
  } finally {
    await h.close();
  }
});

test("subscribing acknowledges, and a published invalidation arrives", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "s1", type: "subscribe", topic: "res:usage" });
    await socket.waitFor(
      (frame) => (frame as { type?: string; id?: string }).id === "s1",
      "the subscribe ack",
    );

    h.broadcaster.invalidate("res:usage");
    const event = await socket.waitFor(
      (frame) => (frame as { type?: string }).type === "event",
      "the invalidation",
    );

    expect(event).toMatchObject({ type: "event", topic: "res:usage" });
  } finally {
    await h.close();
  }
});

test("a burst of invalidations is coalesced rather than forwarded one for one", async () => {
  // The floor, end to end. Without it a 100 req/s gateway is 100 client
  // refetches per second against a surface that polls at 60s today.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ type: "subscribe", topic: "res:usage" });
    await socket.waitFor((frame) => (frame as { type?: string }).type === "ack", "the ack");

    for (let i = 0; i < 100; i++) h.broadcaster.invalidate("res:usage");
    await socket.waitFor((frame) => (frame as { type?: string }).type === "event", "one event");
    await Bun.sleep(50);

    const events = socket.frames.filter((frame) => (frame as { type?: string }).type === "event");
    expect(events.length).toBe(1);
  } finally {
    await h.close();
  }
});

test("a frame the client is not permitted to hold is refused", async () => {
  // An admin holds console topics. A plugin topic is granted by the plugin
  // channel registry, which is the only thing that knows what a plugin may
  // hand out.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ id: "p1", type: "subscribe", topic: "plugin:rc:session" });

    const error = await socket.waitFor(
      (frame) => (frame as { type?: string }).type === "error",
      "the refusal",
    );
    expect(error).toMatchObject({ id: "p1", message: "not permitted" });
  } finally {
    await h.close();
  }
});

test("subscribing to a stream topic with no source behind it answers error", async () => {
  // The console whose log capture is `none` lands here. It must not look to a
  // client like a topic that is merely quiet.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ type: "subscribe", topic: "stream:console" });

    const error = await socket.waitFor(
      (frame) => (frame as { type?: string }).type === "error",
      "the refusal",
    );
    expect(error).toMatchObject({ message: "no source" });
  } finally {
    await h.close();
  }
});

test("a declared stream topic replays from the ring and reports a gap past it", async () => {
  const h = await streamHarness();
  try {
    h.broadcaster.declareStream("stream:console");
    for (let i = 1; i <= 3; i++) h.broadcaster.stream("stream:console", { line: i });

    const socket = await h.connect({ cookie: h.cookie });
    socket.send({ type: "subscribe", topic: "stream:console", sinceSeq: 1 });

    await socket.waitFor((frame) => (frame as { seq?: number }).seq === 3, "the replayed frames");
    const replayed = socket.frames.filter((frame) => (frame as { type?: string }).type === "event");
    expect(replayed).toEqual([
      { type: "event", topic: "stream:console", seq: 2, payload: { line: 2 } },
      { type: "event", topic: "stream:console", seq: 3, payload: { line: 3 } },
    ]);

    // Past the head is a client out of step with the server, not one that is
    // current — and it is told so rather than left believing it caught up.
    const second = await h.connect({ cookie: h.cookie });
    second.send({ type: "subscribe", topic: "stream:console", sinceSeq: 99 });
    const gap = await second.waitFor(
      (frame) => (frame as { type?: string }).type === "gap",
      "the gap",
    );
    expect(gap).toEqual({ type: "gap", topic: "stream:console", seq: 3 });
  } finally {
    await h.close();
  }
});

test("a malformed frame is reported rather than ignored", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    socket.socket.send("not json at all");

    const error = await socket.waitFor(
      (frame) => (frame as { type?: string }).type === "error",
      "the refusal",
    );
    expect(error).toMatchObject({ message: "malformed frame" });
  } finally {
    await h.close();
  }
});

test("closing a socket removes it from the registry", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    expect(h.registry.stats().connections).toBe(1);

    socket.close();
    await Bun.sleep(50);

    expect(h.registry.stats().connections).toBe(0);
  } finally {
    await h.close();
  }
});

test("the quiesce latch does not gate /api/stream", async () => {
  // Same rule that keeps `/api/*` and `/health` live through a restore: a
  // console blacked out during the operation is a console that cannot show an
  // operator whether their database came back.
  const store = await memoryStore();
  const app = createApp({ store, baseUrl: "http://localhost" });

  const response = await app.handle(new Request("http://localhost/api/stream"));

  // 426, not the 503 the latch would produce.
  expect(response.status).toBe(426);
  store.close();
});

test("a subscription the topic cap refuses answers error, not ack", async () => {
  // Same failure "no source" exists for: an ack over a subscription the
  // registry never held reads to the console as a topic that is merely quiet.
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.cookie });
    for (let i = 0; i < 256; i++) socket.send({ type: "subscribe", topic: `res:t${i}` });
    socket.send({ id: "cap", type: "subscribe", topic: "res:one-more" });

    const answer = await socket.waitFor(
      (frame) => (frame as { id?: string }).id === "cap",
      "the answer to the 257th subscribe",
    );
    expect(answer).toMatchObject({ type: "error", message: "too many topics" });
  } finally {
    await h.close();
  }
});
