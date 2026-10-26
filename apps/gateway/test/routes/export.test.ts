import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { memoryStore } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import type { ExportRequest, ExportSupervisor } from "../../src/exportHost/supervisor.ts";
import { status } from "../exportHost/fakes.ts";

/**
 * The export admin routes over the real app, with the worker replaced by a
 * stub: what the routes relay, what they answer when the worker is down, and
 * that every mutation tells the console and the worker. Auth is in
 * `authMatrix.test.ts`.
 */

const WEBHOOK = {
  id: "hook",
  type: "webhook",
  startFrom: "now",
  config: { url: "https://receiver.example/in", headers: {} },
  secret: { signingSecret: "shh-very-secret" },
};

type Stub = Pick<
  ExportSupervisor,
  | "destinationsChanged"
  | "request"
  | "state"
  | "statuses"
  | "restarts"
  | "pause"
  | "resume"
  | "halt"
>;

async function harness(worker: Partial<Stub> = {}) {
  const store = await memoryStore();
  const requests: ExportRequest[] = [];
  let changes = 0;
  const invalidated: string[] = [];
  const stub: Stub = {
    destinationsChanged: async () => {
      changes += 1;
    },
    request: (async (r: ExportRequest) => {
      requests.push(r);
      throw new GatewayError("OVERLOADED", "export worker not running");
    }) as Stub["request"],
    state: () => "idle",
    statuses: () => [],
    restarts: () => 0,
    pause: async () => {},
    resume: async () => {},
    halt: async () => {},
    ...worker,
  };
  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    exportWorker: stub,
    broadcaster: {
      invalidate: (topic: string) => invalidated.push(topic),
      invalidateAll() {},
      declareStream() {},
      declared: () => false,
      stream() {},
      channel: () => true,
      resetStream() {},
      stop() {},
    },
  });
  const login = await app.handle(
    new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2hunter2" }),
    }),
  );
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, call, requests, changes: () => changes, invalidated };
}

test("with the worker down, test, skip, preview and acknowledge answer 503 export worker not running", async () => {
  const h = await harness();
  await h.call("POST", "/api/export/destinations", WEBHOOK);
  for (const [method, path, body] of [
    ["POST", "/api/export/destinations/hook/test", undefined],
    ["POST", "/api/export/destinations/hook/skip", undefined],
    ["POST", "/api/export/destinations/hook/gap/acknowledge", { seenAt: 1 }],
    ["GET", "/api/export/preview?requestId=req_1", undefined],
  ] as const) {
    const res = await h.call(method, path, body);
    expect({ path, status: res.status, body: res.body }).toEqual({
      path,
      status: 503,
      body: { error: { code: "OVERLOADED", message: "export worker not running" } },
    });
  }
});

test("a worker paused by a restore is, to the caller, not running", async () => {
  const h = await harness({
    request: (async (r: ExportRequest) => ({
      type: r.type === "skip" ? "skipResult" : "testResult",
      ref: "1",
      ok: false,
      error: "export worker paused",
      status: null,
    })) as unknown as Stub["request"],
  });
  const res = await h.call("POST", "/api/export/destinations/hook/skip");
  expect(res.status).toBe(503);
  expect(res.body).toEqual({ error: { code: "OVERLOADED", message: "export worker not running" } });
});

test("create, edit, bodies and remove go through control, announce res:export and wake the worker", async () => {
  const h = await harness();
  const created = await h.call("POST", "/api/export/destinations", WEBHOOK);
  expect(created.status).toBe(200);
  const destination = created.body.destination as Record<string, unknown>;
  expect(destination).toMatchObject({ id: "hook", type: "webhook", hasSecret: true, status: null });
  // Never the secret, in any read.
  expect(JSON.stringify(created.body)).not.toContain("shh-very-secret");
  expect(h.changes()).toBe(1);

  const edited = await h.call("PUT", "/api/export/destinations/hook", { enabled: false });
  expect((edited.body.destination as { enabled: boolean }).enabled).toBe(false);
  const bodies = await h.call("PUT", "/api/export/destinations/hook/bodies", { include: true });
  expect(bodies.status).toBe(400);
  expect(
    await h.call("PUT", "/api/export/destinations/hook/bodies", { include: false }),
  ).toMatchObject({
    status: 200,
  });

  const list = await h.call("GET", "/api/export/destinations");
  expect(list.body).toMatchObject({ worker: { state: "idle", restarts: 0 } });
  expect(JSON.stringify(list.body)).not.toContain("shh-very-secret");
  expect((await h.call("GET", "/api/export/destinations/hook")).status).toBe(200);

  expect(await h.call("DELETE", "/api/export/destinations/hook")).toEqual({
    status: 200,
    body: { ok: true },
  });
  expect((await h.call("GET", "/api/export/destinations/hook")).status).toBe(400);
  expect(h.changes()).toBe(4);
  expect(h.invalidated.filter((t) => t === "res:export")).toHaveLength(4);

  // A refused write announces nothing.
  expect((await h.call("POST", "/api/export/destinations", { id: "BAD" })).status).toBe(400);
  expect(h.changes()).toBe(4);
});

test("reads carry the worker's latest status for the destination's own generation", async () => {
  let statuses: ReturnType<typeof status>[] = [];
  const h = await harness({ state: () => "running", statuses: () => statuses });
  const created = await h.call("POST", "/api/export/destinations", WEBHOOK);
  const generation = (created.body.destination as { generation: string }).generation;
  statuses = [
    // From before a delete-and-recreate under the same id: not this destination's.
    status({ generation: "an-old-generation", lastError: "stale" }),
    status({ generation, lastError: "HTTP 500", lagMs: 12_000 }),
  ];
  const list = await h.call("GET", "/api/export/destinations");
  const [first] = list.body.destinations as Array<{ status: Record<string, unknown> | null }>;
  expect(first?.status).toMatchObject({ lastError: "HTTP 500", lagMs: 12_000, failing: false });
  expect(first?.status).not.toHaveProperty("counters");
  expect(list.body.worker).toEqual({ state: "running", restarts: 0 });
});

test("test, skip, acknowledge and preview relay to the worker and shape its reply", async () => {
  const h = await harness({
    state: () => "running",
    request: (async (r: ExportRequest) => {
      switch (r.type) {
        case "test":
          return r.id === "bad"
            ? { type: "testResult", ref: "1", ok: false, error: "HTTP 401", status: 401 }
            : r.id === "nope"
              ? {
                  type: "testResult",
                  ref: "1",
                  ok: false,
                  error: "no such export destination",
                  status: null,
                }
              : { type: "testResult", ref: "1", ok: true, status: 200, latencyMs: 7 };
        case "skip":
          return { type: "skipResult", ref: "1", ok: true, at: 42 };
        case "ackGap":
          return { type: "ackGapResult", ref: "1", ok: true, cleared: r.seenAt === 5 };
        case "preview":
          return r.requestId === "req_1"
            ? { type: "previewResult", ref: "1", ok: true, record: { id: "req_1" } }
            : { type: "previewResult", ref: "1", ok: false, error: "no such request" };
      }
    }) as Stub["request"],
  });
  expect(await h.call("POST", "/api/export/destinations/hook/test")).toEqual({
    status: 200,
    body: { ok: true, status: 200, latencyMs: 7 },
  });
  // A delivery failure is the test's answer, not the route's error.
  expect(await h.call("POST", "/api/export/destinations/bad/test")).toEqual({
    status: 200,
    body: { ok: false, status: 401, error: "HTTP 401" },
  });
  expect((await h.call("POST", "/api/export/destinations/nope/test")).status).toBe(400);
  expect(await h.call("POST", "/api/export/destinations/hook/skip")).toEqual({
    status: 200,
    body: { ok: true, at: 42 },
  });
  expect(
    await h.call("POST", "/api/export/destinations/hook/gap/acknowledge", { seenAt: 5 }),
  ).toEqual({ status: 200, body: { ok: true, cleared: true } });
  expect(
    (await h.call("POST", "/api/export/destinations/hook/gap/acknowledge", { seenAt: -1 })).status,
  ).toBe(400);
  expect(await h.call("GET", "/api/export/preview?requestId=req_1")).toEqual({
    status: 200,
    body: { record: { id: "req_1" } },
  });
  expect(await h.call("GET", "/api/export/preview?requestId=req_2")).toEqual({
    status: 400,
    body: { error: { code: "BAD_REQUEST", message: "no such request" } },
  });
  expect((await h.call("GET", "/api/export/preview")).status).toBe(400);
  expect(h.invalidated.filter((t) => t === "res:export")).toHaveLength(2);
});
