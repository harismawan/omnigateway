import { expect, test } from "bun:test";
import { ADMIN_COOKIE, createAdminAuth } from "@omni/control";
import type { PluginRequest, PluginResponse, PluginRoute } from "@omni/plugins";
import type { HttpClient } from "@omni/providers";
import { captureLogger, memoryStore } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { type MountedPlugin, pluginRoutes } from "../../src/plugins/routes.ts";

const NOW = 1_000_000;
const SESSION_TTL_MS = 60_000;

function route(
  path: string,
  handler: (request: PluginRequest) => PluginResponse | Promise<PluginResponse>,
  method: PluginRoute["method"] = "GET",
): PluginRoute {
  return { method, path, handler };
}

async function session() {
  const store = await memoryStore();
  const admin = createAdminAuth(store, { now: () => NOW, sessionTtlMs: SESSION_TTL_MS });
  await admin.setPassword("hunter2hunter2");
  const token = await admin.login("hunter2hunter2");
  if (token === null) throw new Error("test admin login failed");
  return { store, admin, cookie: `${ADMIN_COOKIE}=${token}` };
}

async function harness(plugins: readonly MountedPlugin[]) {
  const { store, admin, cookie } = await session();
  const logger = captureLogger();
  const app = pluginRoutes({ admin, plugins, logger });

  const call = (method: string, path: string, body?: unknown, auth = true) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(auth ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  return { store, admin, app, call, cookie, logger };
}

// 1. The host applies the guard, and a plugin cannot opt out of it.

test("an unauthenticated request is refused and the handler never runs", async () => {
  let ran = false;
  const { call } = await harness([
    {
      id: "hatch",
      routes: [
        route("/thing", () => {
          ran = true;
          return { json: { ok: true } };
        }),
      ],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing", undefined, false);
  expect(res.status).toBe(401);
  expect(ran).toBe(false);
});

test("a session token that has aged past its ttl is refused", async () => {
  // This test previously never built a stale token: the harness pins the clock,
  // so it called with no cookie at all, asserted 401, and was a duplicate of the
  // test above it. Session expiry could have been entirely broken and it passed.
  //
  // A movable clock is the whole point — the same token has to work before the
  // ttl and fail after it, or the assertion is about something else.
  const store = await memoryStore();
  let clock = NOW;
  const admin = createAdminAuth(store, { now: () => clock, sessionTtlMs: SESSION_TTL_MS });
  await admin.setPassword("hunter2hunter2");
  const token = await admin.login("hunter2hunter2");
  if (token === null) throw new Error("test admin login failed");

  const app = pluginRoutes({
    admin,
    plugins: [{ id: "hatch", routes: [route("/thing", () => ({ json: 1 }))] }],
    logger: captureLogger(),
  });
  const call = () =>
    app.handle(
      new Request("http://localhost/api/plugins/hatch/thing", {
        headers: { cookie: `${ADMIN_COOKIE}=${token}` },
      }),
    );

  expect((await call()).status).toBe(200);

  clock += SESSION_TTL_MS + 1;
  expect((await call()).status).toBe(401);
});

test("every method is guarded, not only the readable one", async () => {
  const seen: string[] = [];
  const routes: PluginRoute[] = (["GET", "POST", "PUT", "DELETE"] as const).map((method) =>
    route(
      `/${method.toLowerCase()}`,
      () => {
        seen.push(method);
        return { json: { ok: true } };
      },
      method,
    ),
  );
  const { call } = await harness([{ id: "hatch", routes }]);

  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const res = await call(method, `/api/plugins/hatch/${method.toLowerCase()}`, undefined, false);
    expect(res.status).toBe(401);
  }
  expect(seen).toEqual([]);

  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const res = await call(method, `/api/plugins/hatch/${method.toLowerCase()}`);
    expect(res.status).toBe(200);
  }
  expect(seen).toEqual(["GET", "POST", "PUT", "DELETE"]);
});

// 2. A plugin cannot shadow a core route.

test("a traversing route path is refused at mount time", async () => {
  let ran = false;
  const traversals = ["/../keys", "/../../api/keys", "/a/../../keys", "/%2e%2e/keys", "/..%2fkeys"];
  const { call, logger } = await harness([
    {
      id: "hatch",
      routes: traversals.map((path) =>
        route(path, () => {
          ran = true;
          return { json: { escaped: true } };
        }),
      ),
    },
  ]);

  // Nothing was mounted, so nothing answers — at the escaped path or at the
  // literal one the plugin wrote.
  for (const path of ["/api/keys", "/api/plugins/hatch/../keys", "/api/plugins/keys"]) {
    const res = await call("GET", path);
    expect(res.status).toBe(404);
  }
  expect(ran).toBe(false);
  expect(logger.records.filter((line) => line.msg === "plugin route refused").length).toBe(
    traversals.length,
  );
});

test("a refused route costs only itself", async () => {
  const { call } = await harness([
    {
      id: "hatch",
      routes: [
        route("/../keys", () => ({ json: {} })),
        route("/fine", () => ({ json: { ok: 1 } })),
      ],
    },
  ]);

  const good = await call("GET", "/api/plugins/hatch/fine");
  expect(good.status).toBe(200);
  expect(await good.json()).toEqual({ ok: 1 });
});

test("a path with an empty segment is refused rather than collapsed", async () => {
  const { call, logger } = await harness([
    {
      id: "hatch",
      routes: [
        route("/thing/", () => ({ json: { from: "trailing" } })),
        route("//thing", () => ({ json: { from: "double" } })),
        route("/a//b", () => ({ json: { from: "inner" } })),
      ],
    },
  ]);

  // Each has a canonical spelling the author can write instead, so refusing is
  // cheap; collapsing would mount a path nobody wrote at a place two plugins
  // could then disagree about.
  for (const path of ["/api/plugins/hatch/thing", "/api/plugins/hatch/a/b", "/api/plugins/thing"]) {
    expect((await call("GET", path)).status).toBe(404);
  }
  expect(logger.records.filter((line) => line.msg === "plugin route refused").length).toBe(3);
});

test("an id that is not manifest-shaped mounts nothing", async () => {
  const { call, logger } = await harness([
    { id: "../..", routes: [route("/keys", () => ({ json: { escaped: true } }))] },
    { id: "Hatch", routes: [route("/thing", () => ({ json: { escaped: true } }))] },
  ]);

  expect((await call("GET", "/api/keys")).status).toBe(404);
  expect((await call("GET", "/api/plugins/Hatch/thing")).status).toBe(404);
  expect(logger.records.filter((line) => line.msg === "plugin route refused").length).toBe(2);
});

test("a mounted route lands under the plugin prefix and only there", async () => {
  const { call } = await harness([
    { id: "hatch", routes: [route("/keys/:id/purchase", () => ({ json: { ok: 1 } }), "POST")] },
  ]);

  expect((await call("POST", "/api/plugins/hatch/keys/k1/purchase", {})).status).toBe(200);
  expect((await call("POST", "/api/keys/k1/purchase", {})).status).toBe(404);
  expect((await call("POST", "/keys/k1/purchase", {})).status).toBe(404);
});

// 3. Two plugins are isolated from one another.

test("two plugins declaring the same path get their own mounts", async () => {
  const { call } = await harness([
    { id: "a", routes: [route("/thing", () => ({ json: { from: "a" } }))] },
    { id: "b", routes: [route("/thing", () => ({ json: { from: "b" } }))] },
  ]);

  expect(await (await call("GET", "/api/plugins/a/thing")).json()).toEqual({ from: "a" });
  expect(await (await call("GET", "/api/plugins/b/thing")).json()).toEqual({ from: "b" });
});

test("neither plugin answers at the other's path or at the bare prefix", async () => {
  const { call } = await harness([
    { id: "a", routes: [route("/only-a", () => ({ json: { from: "a" } }))] },
    { id: "b", routes: [route("/only-b", () => ({ json: { from: "b" } }))] },
  ]);

  expect((await call("GET", "/api/plugins/a/only-b")).status).toBe(404);
  expect((await call("GET", "/api/plugins/b/only-a")).status).toBe(404);
  expect((await call("GET", "/api/plugins/only-a")).status).toBe(404);
});

// 4. `PluginResponse` translation.

test("json is serialised as application/json and defaults to 200", async () => {
  const { call } = await harness([
    { id: "hatch", routes: [route("/thing", () => ({ json: { count: 2 } }))] },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual({ count: 2 });
});

test("an explicit status is honoured", async () => {
  const { call } = await harness([
    { id: "hatch", routes: [route("/thing", () => ({ status: 202, json: { queued: true } }))] },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing");
  expect(res.status).toBe(202);
});

test("bytes are returned verbatim with the declared content type", async () => {
  const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const { call } = await harness([
    {
      id: "hatch",
      routes: [route("/asset", () => ({ bytes: payload, contentType: "image/png" }))],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/asset");
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
});

test("bytes without a content type fall back to octet-stream", async () => {
  const { call } = await harness([
    { id: "hatch", routes: [route("/asset", () => ({ bytes: new Uint8Array([1, 2]) }))] },
  ]);

  const res = await call("GET", "/api/plugins/hatch/asset");
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
});

test("a json response ignores a content type the plugin tried to set", async () => {
  const { call } = await harness([
    {
      id: "hatch",
      routes: [route("/thing", () => ({ json: { a: 1 }, contentType: "text/html" }))],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing");
  expect(res.headers.get("content-type")).toBe("application/json");
});

test("cacheControl is the only header a plugin can influence", async () => {
  /**
   * The type forbids arbitrary headers, so this asserts the *translation*: a
   * response object carrying extra members — which is what untyped plugin code
   * compiled elsewhere actually hands over — contributes nothing to the wire.
   */
  const smuggled = {
    json: { ok: true },
    cacheControl: "private, max-age=30",
    headers: { "set-cookie": "omni_admin=stolen", "access-control-allow-origin": "*" },
    "set-cookie": "omni_admin=stolen",
  } as unknown as PluginResponse;

  const { call } = await harness([{ id: "hatch", routes: [route("/thing", () => smuggled)] }]);
  const res = await call("GET", "/api/plugins/hatch/thing");

  expect(res.headers.get("cache-control")).toBe("private, max-age=30");
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect([...res.headers.keys()].sort()).toEqual(["cache-control", "content-type"]);
});

test("a cacheControl carrying a header injection is dropped, not sent", async () => {
  const { call } = await harness([
    {
      id: "hatch",
      routes: [
        route("/thing", () => ({
          json: { ok: true },
          cacheControl: "no-store\r\nset-cookie: omni_admin=stolen",
        })),
      ],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
});

// 5. A throwing handler returns 500 and leaks nothing.

test("a throwing handler is a 500 that carries none of the error", async () => {
  const { call, logger } = await harness([
    {
      id: "hatch",
      routes: [
        route("/boom", () => {
          throw new Error("connect ECONNREFUSED /home/op/secrets/token.json sk-ant-oat01-abc");
        }),
      ],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/boom");
  const text = await res.text();
  expect(res.status).toBe(500);
  expect(text).not.toContain("ECONNREFUSED");
  expect(text).not.toContain("/home/op");
  expect(text).not.toContain("sk-ant-oat01-abc");
  expect(text).not.toContain("at ");
  expect(JSON.parse(text)).toEqual({
    error: { code: "INTERNAL", message: "plugin route failed" },
  });

  // Logged instead, through the `plugin` field `LogFields` already allows and
  // with nothing free-text beside it.
  const failure = logger.records.find((line) => line.msg === "plugin route handler failed");
  expect(failure?.level).toBe("error");
  expect(failure?.fields).toEqual({ plugin: "hatch" });
  expect(logger.lines.join("\n")).not.toContain("sk-ant-oat01-abc");
});

test("a rejected promise is treated the same as a throw", async () => {
  const { call } = await harness([
    {
      id: "hatch",
      routes: [route("/boom", async () => Promise.reject(new Error("sk-ant-oat01-abc")))],
    },
  ]);

  const res = await call("GET", "/api/plugins/hatch/boom");
  expect(res.status).toBe(500);
  expect(await res.text()).not.toContain("sk-ant-oat01-abc");
});

test("a handler returning nothing is a 500 rather than an empty 200", async () => {
  const { call } = await harness([
    { id: "hatch", routes: [route("/thing", () => undefined as unknown as PluginResponse)] },
  ]);

  const res = await call("GET", "/api/plugins/hatch/thing");
  expect(res.status).toBe(500);
});

test("a handler returning something that is not a response is a 500", async () => {
  /**
   * A plugin is compiled elsewhere, so the type is advice on the other side of
   * the boundary. A string return reads as a response with no status and no
   * body, which would answer 200 with `null` — a failure that looks like an
   * empty success.
   */
  const { call } = await harness([
    {
      id: "hatch",
      routes: [
        route("/string", () => "ok" as unknown as PluginResponse),
        route("/number", () => 7 as unknown as PluginResponse),
      ],
    },
  ]);

  expect((await call("GET", "/api/plugins/hatch/string")).status).toBe(500);
  expect((await call("GET", "/api/plugins/hatch/number")).status).toBe(500);
});

// The request a plugin sees.

test("params, query, and a JSON body reach the handler; headers do not", async () => {
  let seen: PluginRequest | null = null;
  const { call } = await harness([
    {
      id: "hatch",
      routes: [
        route(
          "/keys/:id/purchase",
          (request) => {
            seen = request;
            return { json: { ok: true } };
          },
          "POST",
        ),
      ],
    },
  ]);

  const res = await call("POST", "/api/plugins/hatch/keys/k1/purchase?dry=yes", { amount: 3 });
  expect(res.status).toBe(200);
  const request = seen as PluginRequest | null;
  expect(request?.params).toEqual({ id: "k1" });
  expect(request?.query).toEqual({ dry: "yes" });
  expect(request?.body).toEqual({ amount: 3 });
  // The whole shape, so a future field cannot arrive unnoticed: no headers, no
  // cookie, no `Request`.
  expect(Object.keys(request ?? {}).sort()).toEqual(["body", "params", "query"]);
});

test("a GET and a bodiless POST both see a null body", async () => {
  const bodies: unknown[] = [];
  const record = (request: PluginRequest): PluginResponse => {
    bodies.push(request.body);
    return { json: { ok: true } };
  };
  const { call } = await harness([
    { id: "hatch", routes: [route("/g", record), route("/p", record, "POST")] },
  ]);

  expect((await call("GET", "/api/plugins/hatch/g")).status).toBe(200);
  expect((await call("POST", "/api/plugins/hatch/p")).status).toBe(200);
  expect(bodies).toEqual([null, null]);
});

test("a malformed body is a 400 and the handler never runs", async () => {
  let ran = false;
  const { app, cookie } = await harness([
    {
      id: "hatch",
      routes: [
        route(
          "/thing",
          () => {
            ran = true;
            return { json: { ok: true } };
          },
          "POST",
        ),
      ],
    },
  ]);

  const res = await app.handle(
    new Request("http://localhost/api/plugins/hatch/thing", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{not json",
    }),
  );
  expect(res.status).toBe(400);
  expect(ran).toBe(false);
});

// 6. A failing plugin does not affect anything else.

test("a plugin that throws leaves the core routes working", async () => {
  const { store, admin, cookie } = await session();
  let healthy = 0;

  const app = pluginRoutes({
    admin,
    plugins: [
      {
        id: "hatch",
        routes: [
          route("/boom", () => {
            throw new Error("boom");
          }),
        ],
      },
      {
        id: "other",
        routes: [
          route("/fine", () => {
            healthy += 1;
            return { json: { ok: true } };
          }),
        ],
      },
    ],
  });

  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));

  expect((await get("/api/plugins/hatch/boom")).status).toBe(500);
  expect((await get("/api/plugins/other/fine")).status).toBe(200);
  expect((await get("/api/plugins/hatch/boom")).status).toBe(500);
  expect((await get("/api/plugins/other/fine")).status).toBe(200);
  expect(healthy).toBe(2);
  expect(store).toBeDefined();
});

// Composition in `createApp`.

/**
 * A whole app, logged in through its own `/api/login`.
 *
 * `AdminAuth` holds its sessions in memory, so a token minted from a second
 * instance over the same store would not verify here — the password is what the
 * store carries across, and the cookie has to come from the app under test.
 */
async function appHarness(plugins: readonly MountedPlugin[]) {
  const store = await memoryStore();
  const seed = createAdminAuth(store, { now: () => NOW, sessionTtlMs: SESSION_TTL_MS });
  await seed.setPassword("hunter2hunter2");

  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    now: () => NOW,
    rand: () => 0.5,
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
    plugins,
  });

  const login = await app.handle(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "hunter2hunter2" }),
    }),
  );
  const setCookie = login.headers.get("set-cookie");
  if (setCookie === null) throw new Error("test admin login returned no cookie");
  const cookie = setCookie.split(";")[0] ?? "";

  const get = (path: string) =>
    app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));

  return { store, app, cookie, get };
}

test("plugin routes are reachable through createApp and survive a plugin failure", async () => {
  const { get } = await appHarness([
    {
      id: "hatch",
      routes: [
        route("/thing", () => ({ json: { ok: true } })),
        route("/boom", () => {
          throw new Error("boom");
        }),
      ],
    },
  ]);

  expect((await get("/api/plugins/hatch/thing")).status).toBe(200);
  expect((await get("/api/plugins/hatch/boom")).status).toBe(500);
  // A core route, after the failure, at the position a plugin cannot occupy.
  const keys = await get("/api/keys");
  expect(keys.status).toBe(200);
  expect((await get("/health")).status).toBe(200);
});

test("a plugin cannot claim a core admin path through createApp", async () => {
  const { get } = await appHarness([
    { id: "hatch", routes: [route("/../keys", () => ({ json: { escaped: true } }))] },
  ]);

  const res = await get("/api/keys");
  expect(res.status).toBe(200);
  // The core listing, not the plugin's payload.
  expect(await res.json()).toEqual({ keys: [] });
});

test("an app with no plugins answers as it did before", async () => {
  const store = await memoryStore();
  const app = createApp({
    store,
    baseUrl: "http://localhost:9000",
    now: () => NOW,
    http: (() => {
      throw new Error("a stub adapter reached the transport");
    }) as HttpClient,
  });

  expect((await app.handle(new Request("http://localhost/health"))).status).toBe(200);
  const missing = await app.handle(new Request("http://localhost/api/plugins/hatch/thing"));
  expect(missing.status).toBe(404);
});
