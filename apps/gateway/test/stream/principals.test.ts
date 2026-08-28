import { expect, test } from "bun:test";
import { streamHarness, type TestSocket } from "./harness.ts";

/**
 * The socket driven as each principal, against a listening gateway.
 *
 * `authorised()` is unit-tested exhaustively in `authorised.test.ts` against a
 * stub registry, and that grid is the right place for the rule itself. What it
 * cannot show is that the rule is *reached*: `beforeHandle` changed from
 * `requireAdmin` to "any session opens, `authorised` decides what it may hold",
 * and every existing socket test drives an admin cookie. A regression that
 * re-widened the upgrade, or that never consulted the principal at all, leaves
 * the unit grid green.
 */

type Frame = { type: string; topic?: string; id?: string; message?: string };

const isFor = (id: string) => (frame: unknown) => (frame as Frame).id === id;

async function subscribe(socket: TestSocket, topic: string, id: string): Promise<Frame> {
  socket.send({ id, type: "subscribe", topic });
  return (await socket.waitFor(isFor(id), `reply to ${topic}`)) as Frame;
}

test("a client session opens the socket and holds its two topics", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.clientCookie });
    expect(socket.closes).toEqual([]);
    expect(h.registry.stats().connections).toBe(1);

    for (const topic of ["res:usage", "res:logs"]) {
      const reply = await subscribe(socket, topic, `sub-${topic}`);
      expect({ topic, type: reply.type }).toEqual({ topic, type: "ack" });
    }
  } finally {
    await h.close();
  }
});

test("a client session is refused every other topic, one reply at a time", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.clientCookie });

    const refused: string[] = [];
    for (const topic of [
      "res:keys",
      "res:credentials",
      "res:settings",
      "res:models",
      "res:quota",
      "stream:console",
      "plugin:rc:events",
    ]) {
      const reply = await subscribe(socket, topic, `sub-${topic}`);
      // An `error` reply, not a silent non-ack: a subscribe that is simply
      // never answered is indistinguishable from a topic that is quiet.
      if (reply.type !== "error") refused.push(`${topic} -> ${reply.type}`);
    }
    expect(refused).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a viewer holds every res topic and the console tail", async () => {
  const h = await streamHarness();
  try {
    // Declared first. A `stream:*` topic nobody declared is refused whoever
    // asks — the operator included — so without this the viewer's refusal would
    // look like a principal rule when it is the topic having no owner. That is
    // the same distinction `authorised` draws for plugin channels, and it
    // caught this test the first time it ran.
    h.broadcaster.declareStream("stream:console");

    const socket = await h.connect({ cookie: h.viewerCookie });
    expect(socket.closes).toEqual([]);

    const wrong: string[] = [];
    for (const topic of [
      "res:usage",
      "res:logs",
      "res:keys",
      "res:credentials",
      "res:settings",
      "res:models",
      "res:quota",
      // A diagnostic, and a viewer is the operator minus mutations and secrets.
      "stream:console",
    ]) {
      const reply = await subscribe(socket, topic, `sub-${topic}`);
      if (reply.type !== "ack") wrong.push(`${topic} -> ${reply.type}`);
    }
    expect(wrong).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a client is refused the console tail even once it is declared", async () => {
  const h = await streamHarness();
  try {
    // The control for the test above: with the topic declared, a refusal can
    // only be the principal rule.
    h.broadcaster.declareStream("stream:console");
    const client = await h.connect({ cookie: h.clientCookie });
    const viewer = await h.connect({ cookie: h.viewerCookie });

    expect((await subscribe(client, "stream:console", "sub-client")).type).toBe("error");
    expect((await subscribe(viewer, "stream:console", "sub-viewer")).type).toBe("ack");
  } finally {
    await h.close();
  }
});

test("a viewer is refused a plugin channel", async () => {
  const h = await streamHarness();
  try {
    h.channels.for("rc").open("events");
    const socket = await h.connect({ cookie: h.viewerCookie });

    const reply = await subscribe(socket, "plugin:rc:events", "sub-plugin");
    // Opened, so this is not "nobody owns it" — it is third-party code, and a
    // read-only administrator is not the operator who installed it.
    expect(reply.type).toBe("error");

    // The operator on the same gateway does get it, so the refusal is about the
    // principal rather than about the channel being unavailable.
    const operator = await h.connect({ cookie: h.cookie });
    expect((await subscribe(operator, "plugin:rc:events", "sub-admin")).type).toBe("ack");
  } finally {
    await h.close();
  }
});

/**
 * The one path that re-checks a client's key on a long-lived connection.
 *
 * An HTTP session dies on its next request because `verify` re-reads the key
 * row. A socket makes no further requests — it is the heartbeat's `revalidate`
 * thunk or nothing, and that thunk is the only thing standing between a revoked
 * key and a push feed that runs until the process restarts.
 */
test("revoking a key closes its live socket at the next heartbeat", async () => {
  const h = await streamHarness();
  try {
    const socket = await h.connect({ cookie: h.clientCookie });
    expect((await subscribe(socket, "res:usage", "sub-usage")).type).toBe("ack");
    expect(h.registry.stats().connections).toBe(1);

    await h.store.keys.revoke(h.clientKeyId);
    await h.beat();

    const closed = await socket.waitForClose("the revoked client socket");
    // 4401 is "do not reconnect", which is exactly right: reconnecting with the
    // same revoked key would fail the upgrade anyway.
    expect(closed.code).toBe(4401);
    expect(h.registry.stats().connections).toBe(0);
  } finally {
    await h.close();
  }
});

test("revoking one key leaves another principal's socket alone", async () => {
  const h = await streamHarness();
  try {
    const client = await h.connect({ cookie: h.clientCookie });
    const operator = await h.connect({ cookie: h.cookie });
    expect(h.registry.stats().connections).toBe(2);

    await h.store.keys.revoke(h.clientKeyId);
    await h.beat();

    await client.waitForClose("the revoked client socket");
    // The operator's session has nothing to do with that key.
    expect(operator.closes).toEqual([]);
    expect(h.registry.stats().connections).toBe(1);
  } finally {
    await h.close();
  }
});
