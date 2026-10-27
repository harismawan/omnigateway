import { afterEach, expect, test } from "bun:test";
import { destination, row, sharedLease, stateOf, T0, type World, world } from "../harness.ts";

test.each([false, true])(
  "consistent admission closes both review interleavings (segmented=%s)",
  async (segmented) => {
    for (const mode of ["destination", "settings"] as const) {
      const w = setup(segmented ? 1500 : 5000);
      artifact(w, segmented ? "PRIVATE".repeat(2000) : "PRIVATE");
      let changed = false;
      const change = () => {
        changed = true;
        if (mode === "settings") w.settings.bodyLoggingEnabled = false;
        else {
          const d = w.destinations[0];
          if (d) {
            d.revision++;
            d.config = { url: "https://replacement.test/in" };
          }
        }
      };
      // The historical final settings/key awaits, without a local notification.
      let settingsReads = 0;
      w.beforeSettings = async () => {
        if (mode === "destination" && ++settingsReads === 5) change();
      };
      const has = w.optOut.has.bind(w.optOut);
      let keyReads = 0;
      w.optOut.has = (id) => {
        if (mode === "settings" && ++keyReads === 3) change();
        return has(id);
      };
      // Replacement linearization boundary: edits committed before admission
      // must be visible together, regardless of earlier prerequisite ordering.
      w.beforeAdmission = async () => {
        if (!changed) change();
      };
      await w.loop.start();
      await w.settle();
      expect(changed).toBe(true);
      expect(w.sent).toHaveLength(0);
      expect((await stateOf(w)).cursorId).toBe("");
    }
  },
);

test.each([
  "settings",
  "key",
  "revision",
  "generation",
  "enabled",
  "includeBodies",
  "removed",
] as const)(
  "every segment takes a fresh admission snapshot after DB-only %s change",
  async (mode) => {
    const w = setup(1500);
    artifact(w, "PRIVATE".repeat(2000));
    w.answer = (req) => {
      if (req.headers["x-omni-body-part"]) {
        const d = w.destinations[0];
        if (mode === "settings") w.settings.bodyLoggingEnabled = false;
        if (mode === "key") w.optOut.add("key");
        if (mode === "removed") w.destinations.length = 0;
        if (d) {
          if (mode === "revision") d.revision++;
          if (mode === "generation") d.generation = "replacement";
          if (mode === "enabled") d.enabled = false;
          if (mode === "includeBodies") d.includeBodies = false;
        }
      }
      return new Response(null, { status: 200 });
    };
    await w.loop.start();
    await w.settle();
    expect(w.sent.filter((s) => s.headers["x-omni-body-part"])).toHaveLength(1);
    expect((await stateOf(w)).cursorId).toBe("");
  },
);

test("oversized metadata is dropped without blocking later rows, with gates off or segmented bodies", async () => {
  for (const enabled of [false, true]) {
    const w = setup(1500);
    w.settings.bodyLoggingEnabled = enabled;
    const first = w.rows[0];
    if (first) first.traceMetadata = { large: "x".repeat(5000) };
    artifact(w, "large ".repeat(2000));
    w.rows.push(row("later", T0 - 19000, { apiKeyId: "key" }));
    await w.loop.start();
    await w.settle();
    expect((await stateOf(w)).cursorId).toBe("later");
    expect((await stateOf(w)).droppedTotal).toBe(1);
    expect((await stateOf(w)).lastError).toBe("dropped 1 of 2: record-too-large");
    expect(w.sent.flatMap((s) => s.ids)).toEqual(["later"]);
  }
});

test("body opt-in retains bounded metadata batching and flushes multiple rows before pending", async () => {
  const w = setup(1000000);
  w.settings.bodyLoggingEnabled = false;
  w.rows.splice(0);
  for (let n = 0; n < 100; n++) w.rows.push(row(`r${n}`, T0 - 20000 + n, { apiKeyId: "key" }));
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]?.ids).toHaveLength(100);
  const pending = setup();
  const first = pending.rows[0];
  if (first) first.bodyState = "pending";
  pending.rows.unshift(row("m1", T0 - 22000), row("m2", T0 - 21000));
  await pending.loop.start();
  await pending.settle();
  expect(pending.sent.map((s) => s.ids)).toEqual([["m1", "m2"]]);
});

test.each([false, true])(
  "elapsed deadline blocks bodies without timer callbacks (lease=%s)",
  async (lease) => {
    const w = lease
      ? world({
          bodies: true,
          lease: sharedLease(() => T0).lease,
          destinations: [destination({ includeBodies: true })],
          rows: [row("body", T0 - 20000, { apiKeyId: "key" })],
        })
      : setup();
    if (lease) {
      worlds.push(w);
      w.settings.bodyLoggingEnabled = true;
      const log = w.rows[0];
      if (log) log.bodyState = "ready";
    }
    artifact(w, "secret");
    w.beforeAdmission = async () => {
      w.clock.now += 61000;
    };
    await w.loop.start();
    await w.settle();
    expect(w.sent).toHaveLength(0);
    expect((await stateOf(w)).cursorId).toBe("");
  },
);

test("database-only gate flip before admission prevents body send", async () => {
  const w = setup();
  artifact(w, "secret");
  w.beforeAdmission = async () => {
    w.settings.bodyLoggingEnabled = false;
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(0);
  expect((await stateOf(w)).cursorId).toBe("");
});

test("local cancellation during admission still blocks transport synchronously", async () => {
  const w = setup();
  artifact(w, "PRIVATE");
  w.beforeAdmission = async () => {
    await w.loop.handle({ type: "gatesChanged", gates: { bodyLoggingAllowed: false } });
  };
  await w.loop.start();
  await w.settle();
  expect(w.sent).toHaveLength(0);
  expect((await stateOf(w)).cursorId).toBe("");
});

test("database policy enable does not require a local gates notification", async () => {
  const w = setup();
  artifact(w, "PRIVATE");
  await w.loop.handle({
    type: "gatesChanged",
    gates: { bodyLoggingAllowed: true, bodyLoggingEnabled: false },
  });
  await w.loop.start();
  await w.settle();
  expect(w.sent[0]?.body).toContain("PRIVATE");
  expect((await stateOf(w)).cursorId).toBe("body");
});

test("inline and segmented receiver rejections keep bounded safe dropped summaries", async () => {
  for (const type of ["elasticsearch", "otlp"] as const)
    for (const large of [false, true]) {
      const w = setup(5000);
      const d = w.destinations[0];
      if (!d) throw new Error("missing destination");
      d.type = type;
      d.config =
        type === "elasticsearch"
          ? { url: "https://es.test", auth: "none" }
          : { endpoint: "https://collector.test", signal: "logs" };
      artifact(w, large ? "hello ".repeat(3000) : "small");
      w.answer = () =>
        type === "elasticsearch"
          ? Response.json({
              errors: true,
              items: [
                {
                  index: {
                    status: 400,
                    error: { type: "mapper_parsing_exception", reason: "secret receiver text" },
                  },
                },
              ],
            })
          : Response.json({
              partialSuccess: { rejectedLogRecords: "1", errorMessage: "secret receiver text" },
            });
      await w.loop.start();
      await w.settle();
      const state = await stateOf(w);
      expect(state.cursorId).toBe("body");
      expect(state.droppedTotal).toBe(1);
      expect(state.lastError).toBe(
        type === "elasticsearch" ? "dropped 1 of 1: mapper_parsing_exception" : "dropped 1 of 1",
      );
      expect(w.logger.lines.join("\n")).not.toContain("secret receiver text");
    }
});

test("segmented metadata rejection reason survives accepted body segments", async () => {
  const w = setup(1500);
  const d = w.destinations[0];
  if (!d) throw new Error("missing destination");
  d.type = "elasticsearch";
  d.config = { url: "https://es.test", auth: "none" };
  artifact(w, "large ".repeat(3000));
  let calls = 0;
  w.answer = () =>
    Response.json({
      errors: ++calls === 1,
      items: [
        {
          index: {
            status: calls === 1 ? 400 : 201,
            ...(calls === 1
              ? { error: { type: "mapper_parsing_exception", reason: "never repeat" } }
              : {}),
          },
        },
      ],
    });
  await w.loop.start();
  await w.settle();
  expect((await stateOf(w)).lastError).toBe("dropped 1 of 1: mapper_parsing_exception");
});

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
