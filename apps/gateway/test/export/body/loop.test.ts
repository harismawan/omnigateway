import { afterEach, expect, test } from "bun:test";
import { destination, row, stateOf, T0, type World, world } from "../harness.ts";

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.loop.handle({ type: "stop" });
    w.dispose();
  }
});
function setup(cap = 5000, budget?: number) {
  const bodyRow = row("body", T0 - 20000, { apiKeyId: "key" });
  bodyRow.bodyState = "ready";
  const w = world({
    bodies: true,
    ...(budget === undefined ? {} : { budget }),
    destinations: [destination({ includeBodies: true, maxRequestBytes: cap })],
    rows: [bodyRow],
  });
  worlds.push(w);
  w.settings.bodyLoggingEnabled = true;
  return w;
}
function artifact(w: World, request: unknown, extra = {}) {
  w.bodies.set(
    "body",
    JSON.stringify({
      schemaVersion: 1,
      requestId: "body",
      client: { request, response: null, truncated: false },
      ...extra,
    }),
  );
}
test("inline client only, unavailable, incomplete and historical omission states", async () => {
  for (const [request, extra, state] of [
    [{ hello: "world" }, {}, "included"],
    [null, { client: { request: 1, response: 2, truncated: true } }, "incomplete"],
    [
      {
        omitted: true,
        reason: "artifact exceeded 524288 bytes after structural bounding",
        serializedBytes: null,
      },
      {},
      "omitted",
    ],
  ] as const) {
    const w = setup();
    artifact(w, request, extra);
    await w.loop.start();
    await w.settle();
    const record = JSON.parse(w.sent[0]?.body ?? "").records[0];
    expect(record.body.state).toBe(state);
    expect(w.sent[0]?.body).not.toContain('attempts":[]');
  }
  const w = setup();
  await w.loop.start();
  await w.settle();
  expect(JSON.parse(w.sent[0]?.body ?? "").records[0].body.state).toBe("unavailable");
});
test("pending preserves cursor order until exactly 60 seconds after completion", async () => {
  const w = setup();
  const first = w.rows[0];
  if (first) first.bodyState = "pending";
  w.rows.push(row("later", T0 - 19000, { apiKeyId: "key" }));
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(0);
  expect((await stateOf(w)).cursorId).toBe("");
  await w.advance(40000);
  expect(w.sent.flatMap((s) => s.ids)).toEqual(["body", "later"]);
  expect(JSON.parse(w.sent[0]?.body ?? "").records[0].body.state).toBe("unavailable");
});
test("budget omits before body export and opt-out/settings gates remove body", async () => {
  const w = setup(5000, 100);
  artifact(w, "large");
  await w.loop.start();
  await w.settle();
  expect(JSON.parse(w.sent[0]?.body ?? "").records[0].body).toEqual({
    state: "omitted",
    reason: "export budget",
  });
  for (const gate of ["key", "settings", "env"]) {
    const g = setup();
    artifact(g, "secret");
    if (gate === "key") g.optOut.add("key");
    if (gate === "settings") g.settings.bodyLoggingEnabled = false;
    if (gate === "env")
      await g.loop.handle({ type: "gatesChanged", gates: { bodyLoggingAllowed: false } });
    await g.loop.start();
    await g.settle();
    expect(g.sent[0]?.body).not.toContain("secret");
    expect(JSON.parse(g.sent[0]?.body ?? "").records[0].body).toBeUndefined();
  }
});
test("segmented webhook POSTs respect cap, replay after partial send and halve once on413", async () => {
  const w = setup(2200);
  artifact(w, '\u0000"\\😀'.repeat(1000));
  let count = 0;
  w.answer = () => {
    count++;
    return new Response(null, { status: count === 2 ? 413 : 200 });
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent.filter((s) => s.headers["x-omni-body-part"]).length).toBeGreaterThan(2);
  for (const s of w.sent) expect(Buffer.byteLength(s.body)).toBeLessThanOrEqual(2200);
  expect((await stateOf(w)).cursorId).toBe("body");
});
test("gate flip between segments cancels uncommitted record and never sends remaining body", async () => {
  const w = setup(1100);
  artifact(w, "secret ".repeat(1000));
  w.answer = (req) => {
    if (req.headers["x-omni-body-part"])
      void w.loop.handle({ type: "gatesChanged", gates: { bodyLoggingAllowed: false } });
    return new Response(null, { status: 200 });
  };
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).cursorId).toBe("");
  expect(w.sent.filter((s) => s.headers["x-omni-body-part"])).toHaveLength(1);
  await w.advance(5000);
  expect((await stateOf(w)).cursorId).toBe("body");
  expect(w.sent.at(-1)?.body).not.toContain("secret");
});

test("partial delivery replays metadata and stable segments before advancing cursor", async () => {
  const w = setup(1300);
  artifact(w, "hello ".repeat(1000));
  let bodyPosts = 0;
  w.answer = (req) =>
    new Response(null, {
      status: req.headers["x-omni-body-part"] && ++bodyPosts === 2 ? 503 : 200,
    });
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).cursorId).toBe("");
  const first = w.sent.find((s) => s.headers["x-omni-body-part"]);
  if (!first) throw new Error("expected first body segment");
  await w.advance(5000);
  expect((await stateOf(w)).cursorId).toBe("body");
  expect(
    w.sent
      .filter(
        (s) =>
          s.headers["x-omni-body-part"] === first?.headers["x-omni-body-part"] &&
          s.headers["x-omni-body-segment"] === "0",
      )
      .map((s) => s.body),
  ).toEqual([first.body, first.body]);
});

test("metadata before a pending body is sent first without overtaking that cursor", async () => {
  const w = setup();
  const body = w.rows[0];
  if (body) body.bodyState = "pending";
  w.rows.unshift(row("metadata", T0 - 21000, { apiKeyId: "key" }));
  await w.loop.start();
  await w.settle();
  expect(w.sent.map((s) => s.ids)).toEqual([["metadata"]]);
  expect((await stateOf(w)).cursorId).toBe("metadata");
});

test("destination edit between segments stops old snapshot without committing", async () => {
  const w = setup(1300);
  artifact(w, "hello ".repeat(1000));
  w.answer = (req) => {
    if (req.headers["x-omni-body-part"]) {
      const d = w.destinations[0];
      if (d) d.revision++;
    }
    return new Response(null, { status: 200 });
  };
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).cursorId).toBe("");
  expect(w.sent.filter((s) => s.headers["x-omni-body-part"])).toHaveLength(1);
});

test("capture settings flipped mid-pass remove bodies from subsequent records", async () => {
  const w = setup();
  artifact(w, { secret: "first" });
  const second = row("second", T0 - 19000, { apiKeyId: "key" });
  second.bodyState = "ready";
  w.rows.push(second);
  w.bodies.set(
    "second",
    JSON.stringify({
      schemaVersion: 1,
      requestId: "second",
      client: { request: "never-send", response: null, truncated: false },
    }),
  );
  w.answer = () => {
    w.settings.bodyLoggingEnabled = false;
    return new Response(null, { status: 200 });
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent.map((s) => s.ids)).toEqual([["body"], ["second"]]);
  expect(w.sent[1]?.body).not.toContain("never-send");
  expect(JSON.parse(w.sent[1]?.body ?? "").records[0].body).toBeUndefined();
});
