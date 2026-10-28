import { expect, test } from "bun:test";
import { createAdminAuth, type Principal } from "@omni/control";
import { memoryStore } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { promptsRoutes } from "../../src/routes/prompts.ts";

const TEAM = { id: "team", name: "Team", text: "team policy", activate: true };

test("every prompt endpoint authenticates before parsing, including machine principals", async () => {
  const store = await memoryStore();
  const auth = createAdminAuth(store, { now: () => 1_000_000, sessionTtlMs: 60_000 });
  try {
    for (const principal of [
      null,
      { kind: "machine", tokenId: "t", pluginId: "plugin" },
      { kind: "client", apiKeyId: "other" },
      { kind: "viewer" },
      { kind: "admin" },
    ] satisfies Array<Principal | null>) {
      const routes = promptsRoutes({ store, admin: { ...auth, verify: async () => principal } });
      for (const [method, path] of [
        ["GET", "/api/prompts"],
        ["GET", "/api/prompts/ponytail-lite"],
        ["POST", "/api/prompts"],
        ["PUT", "/api/prompts/team"],
        ["POST", "/api/prompts/team/versions"],
        ["PUT", "/api/prompts/team/active"],
        ["POST", "/api/prompts/team/duplicate"],
        ["DELETE", "/api/prompts/team"],
      ] as const) {
        const response = await routes.handle(
          new Request(`http://localhost${path}`, {
            method,
            headers: { cookie: "omni_admin=token", "content-type": "application/json" },
            ...(method === "GET" || method === "DELETE" ? {} : { body: "invalid json" }),
          }),
        );
        const allowed =
          principal?.kind === "admin" || (principal?.kind === "viewer" && method === "GET");
        if (allowed) expect(response.status).not.toBe(401);
        else expect(response.status).toBe(401);
      }
    }
  } finally {
    store.close();
  }
});

async function harness() {
  const store = await memoryStore();
  const invalidated: string[] = [];
  const routing: string[] = [];
  store.routing.subscribe((change) => routing.push(change.type));
  const app = createApp({
    store,
    baseUrl: "http://localhost",
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
  const call = (method: string, path: string, body?: unknown, cookie = "") =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const setup = await call("POST", "/api/setup", { password: "hunter2hunter2" });
  const admin = setup.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { store, call, admin, invalidated, routing };
}

test("library, detail/history and every mutation delegate control and invalidate only after success", async () => {
  const h = await harness();
  try {
    const write = async (method: string, path: string, body?: unknown) => {
      h.invalidated.length = 0;
      h.routing.length = 0;
      const res = await h.call(method, path, body, h.admin);
      expect(res.status).toBe(200);
      expect(h.invalidated).toEqual(["res:prompts"]);
      expect(h.routing).toContain("promptsChanged");
      return res.json();
    };
    expect(await write("POST", "/api/prompts", TEAM)).toMatchObject({
      id: "team",
      activeVersion: 1,
    });
    expect(await (await h.call("GET", "/api/prompts", undefined, h.admin)).json()).toMatchObject([
      { id: "ponytail-lite", builtin: true },
      { id: "ponytail-full" },
      { id: "ponytail-ultra" },
      { id: "team", assignments: { global: false, keyIds: [] } },
    ]);
    await write("PUT", "/api/prompts/team", { name: "Renamed", description: "Description" });
    await write("POST", "/api/prompts/team/versions", {
      text: "draft",
      activate: false,
      note: "draft note",
    });
    await write("PUT", "/api/prompts/team/active", { version: 2 });
    expect(
      await (await h.call("GET", "/api/prompts/team", undefined, h.admin)).json(),
    ).toMatchObject({
      name: "Renamed",
      activeVersion: 2,
      versions: [
        { version: 2, text: "draft" },
        { version: 1, text: "team policy" },
      ],
    });
    await write("POST", "/api/prompts/ponytail-lite/duplicate", { id: "copy", name: "Copy" });
    await write("DELETE", "/api/prompts/copy");
  } finally {
    h.store.close();
  }
});

test("strict bodies, duplicate IDs, missing retained versions, builtins and assigned deletion refuse without invalidation", async () => {
  const h = await harness();
  try {
    expect((await h.call("POST", "/api/prompts", TEAM, h.admin)).status).toBe(200);
    for (const [method, path, body, status] of [
      ["POST", "/api/prompts", TEAM, 409],
      ["POST", "/api/prompts", { ...TEAM, id: "other", extra: true }, 400],
      ["PUT", "/api/prompts/team", { name: "No", text: "not metadata" }, 400],
      ["POST", "/api/prompts/team/versions", { text: "   " }, 400],
      ["POST", "/api/prompts/team/versions", { text: "valid", extra: true }, 400],
      ["PUT", "/api/prompts/team/active", { version: 999 }, 400],
      ["PUT", "/api/prompts/team/active", { version: 1, extra: true }, 400],
      ["POST", "/api/prompts/team/duplicate", { id: "copy", name: "Copy", extra: true }, 400],
      ["PUT", "/api/prompts/ponytail-lite", { name: "No" }, 400],
    ] as const) {
      h.invalidated.length = 0;
      expect((await h.call(method, path, body, h.admin)).status).toBe(status);
      expect(h.invalidated).toEqual([]);
    }
    await h.call(
      "PUT",
      "/api/settings",
      { ...(await h.store.config.getSettings()), prompts: ["team"] },
      h.admin,
    );
    h.invalidated.length = 0;
    expect((await h.call("DELETE", "/api/prompts/team", undefined, h.admin)).status).toBe(409);
    expect(h.invalidated).toEqual([]);
  } finally {
    h.store.close();
  }
});

test("mint, per-key assignments and global settings invalidate library assignment counts", async () => {
  const h = await harness();
  try {
    await h.call("POST", "/api/prompts", TEAM, h.admin);
    h.invalidated.length = 0;
    h.routing.length = 0;
    const res = await h.call(
      "POST",
      "/api/keys",
      { label: "holder", prompts: { ids: ["team"], inheritGlobal: false } },
      h.admin,
    );
    expect(res.status).toBe(200);
    const key = (await res.json()) as { id: string };
    expect(h.invalidated).toContain("res:prompts");
    expect(h.routing).toContain("promptsChanged");
    h.invalidated.length = 0;
    h.routing.length = 0;
    expect(
      (
        await h.call(
          "PUT",
          `/api/keys/${key.id}/prompts`,
          { ids: [], inheritGlobal: true },
          h.admin,
        )
      ).status,
    ).toBe(200);
    expect(h.invalidated).toEqual(["res:keys", "res:prompts"]);
    expect(h.routing).toContain("promptsChanged");
    for (const body of [
      { ids: [] },
      { inheritGlobal: true },
      { ids: [], inheritGlobal: true, extra: 1 },
    ]) {
      expect((await h.call("PUT", `/api/keys/${key.id}/prompts`, body, h.admin)).status).toBe(400);
    }
    h.invalidated.length = 0;
    expect(
      (
        await h.call(
          "PUT",
          "/api/settings",
          { ...(await h.store.config.getSettings()), prompts: ["team"] },
          h.admin,
        )
      ).status,
    ).toBe(200);
    expect(h.invalidated).toContain("res:prompts");
    const library = (await (
      await h.call("GET", "/api/prompts", undefined, h.admin)
    ).json()) as Array<{ id: string; assignments: unknown }>;
    expect(library.find((p) => p.id === "team")?.assignments).toEqual({ global: true, keyIds: [] });
  } finally {
    h.store.close();
  }
});
