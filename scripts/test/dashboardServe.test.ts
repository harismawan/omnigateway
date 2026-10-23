import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDashboardServer } from "../../apps/dashboard/tooling/serve.ts";
import { createRebuilder, watchDashboard } from "../../apps/dashboard/tooling/watch.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-serve-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/assets"), { recursive: true });
  await Bun.write(join(root, "dist/index.html"), "<html><body>console</body></html>");
  await Bun.write(join(root, "dist/assets/main.js"), "export const ok = true;");
  return root;
}
async function server(options: Parameters<typeof startDashboardServer>[0]) {
  const app = await startDashboardServer({ hostname: "127.0.0.1", port: 0, ...options });
  cleanups.push(() => app.close());
  return app;
}

test("preview serves existing artifacts and deep links without reload injection or rebuilding", async () => {
  const root = await fixture();
  const app = await server({ root, mode: "preview" });
  expect(await (await fetch(new URL("/accounts", app.url))).text()).toBe(
    "<html><body>console</body></html>",
  );
  expect(await (await fetch(new URL("/assets/main.js", app.url))).text()).toContain(
    "export const ok",
  );
  expect((await fetch(new URL("/assets/missing.js", app.url))).status).toBe(404);
  expect((await fetch(new URL("/__omni_reload", app.url))).status).toBe(404);
  await Bun.write(join(root, "dist/index.html"), "changed");
  expect(await (await fetch(app.url)).text()).toBe("changed");
});

test("preview refuses missing dist and does not create a build", async () => {
  const root = await fixture();
  await rm(join(root, "dist"), { recursive: true });
  await expect(startDashboardServer({ root, mode: "preview", port: 0 })).rejects.toThrow("build");
});

test("proxy preserves body/query/cookies, manual redirects and multiple response cookies", async () => {
  let seen: { body: string; host: string | null; cookie: string | null; path: string } | undefined;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen = {
        body: await req.text(),
        host: req.headers.get("host"),
        cookie: req.headers.get("cookie"),
        path: new URL(req.url).pathname + new URL(req.url).search,
      };
      const headers = new Headers({ location: "/api/next" });
      headers.append("set-cookie", "a=1; Path=/; HttpOnly");
      headers.append("set-cookie", "b=2; Path=/");
      return new Response("redirect-body", { status: 307, headers });
    },
  });
  cleanups.push(() => {
    upstream.stop(true);
  });
  const app = await server({ root: await fixture(), mode: "preview", upstream: upstream.url.href });
  const response = await fetch(new URL("/api/login?next=%2F", app.url), {
    method: "POST",
    body: "password=test",
    headers: { cookie: "existing=ok" },
    redirect: "manual",
  });
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("/api/next");
  expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2; Path=/"]);
  expect(await response.text()).toBe("redirect-body");
  expect(seen).toEqual({
    body: "password=test",
    host: app.url.host,
    cookie: "existing=ok",
    path: "/api/login?next=%2F",
  });
});

test("proxy streams before upstream completion and cancels when the reader disconnects", async () => {
  const cancelled = Promise.withResolvers<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("first"));
          },
          cancel() {
            cancelled.resolve();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  cleanups.push(() => {
    upstream.stop(true);
  });
  const app = await server({ root: await fixture(), mode: "preview", upstream: upstream.url.href });
  const abort = new AbortController();
  const response = await fetch(new URL("/api/events", app.url), { signal: abort.signal });
  if (!response.body) throw new Error("missing stream");
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  abort.abort();
  await Promise.race([
    cancelled.promise,
    Bun.sleep(1000).then(() => {
      throw new Error("upstream not cancelled");
    }),
  ]);
});

test("backend failures and health are not SPA HTML", async () => {
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("healthy"),
  });
  const url = upstream.url.href;
  const app = await server({ root: await fixture(), mode: "preview", upstream: url });
  expect(await (await fetch(new URL("/health", app.url))).text()).toBe("healthy");
  upstream.stop(true);
  const failed = await fetch(new URL("/api/status", app.url));
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("<html>");
});

test("rebuilder serializes rapid invalidations, reports failure, and recovers", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let runs = 0;
  let active = 0;
  let maximum = 0;
  const published: number[] = [];
  const errors: unknown[] = [];
  const rebuilder = createRebuilder(
    async () => {
      maximum = Math.max(maximum, ++active);
      const run = ++runs;
      try {
        if (run === 1) {
          entered.resolve();
          await release.promise;
        }
        if (run === 2) throw new Error("broken source");
        published.push(run);
      } finally {
        active--;
      }
    },
    (error) => errors.push(error),
  );
  const first = rebuilder.request();
  await entered.promise;
  void rebuilder.request();
  void rebuilder.request();
  release.resolve();
  await first;
  expect(runs).toBe(2);
  expect(maximum).toBe(1);
  expect(published).toEqual([1]);
  expect(errors).toHaveLength(1);
  await rebuilder.request();
  expect(published).toEqual([1, 3]);
});

test("dev publishes only successful builds, retains old assets and reloads after recovery", async () => {
  const root = await fixture();
  let version = 0;
  let broken = false;
  const app = await server({
    root,
    mode: "dev",
    watch: false,
    build: async (_root, output) => {
      if (broken) throw new Error("syntax error");
      await Bun.write(join(output, "index.html"), `<html><body>build-${++version}</body></html>`);
      await Bun.write(join(output, `asset-${version}.js`), `${version}`);
    },
    onError: () => {},
  });
  const initial = await (await fetch(app.url)).text();
  expect(initial).toContain("build-1");
  expect(initial).toContain("EventSource");
  const controller = new AbortController();
  const stream = await fetch(new URL("/__omni_reload?version=1", app.url), {
    signal: controller.signal,
  });
  if (!stream.body) throw new Error("missing reload stream");
  const reader = stream.body.getReader();
  await reader.read(); // connection heartbeat
  broken = true;
  await app.rebuild();
  expect(await (await fetch(app.url)).text()).toContain("build-1");
  broken = false;
  await app.rebuild();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: 2");
  expect(await (await fetch(app.url)).text()).toContain("build-2");
  expect(await (await fetch(new URL("/asset-1.js", app.url))).text()).toBe("1");
  controller.abort();
  expect(await Bun.file(join(root, "dist/index.html")).text()).not.toContain("EventSource");
});

test("watch catches nested route add/delete but ignores generated tree and output", async () => {
  const root = await fixture();
  await mkdir(join(root, "src/routes"), { recursive: true });
  let notify = Promise.withResolvers<void>();
  let changes = 0;
  const close = watchDashboard(root, () => {
    changes++;
    notify.resolve();
  });
  cleanups.push(close);
  await Bun.write(join(root, "src/routeTree.gen.ts"), "generated");
  await Bun.write(join(root, "dist/ignored.js"), "built");
  await Bun.sleep(100);
  expect(changes).toBe(0);
  await Bun.write(join(root, "src/routes/new.tsx"), "route");
  await Promise.race([
    notify.promise,
    Bun.sleep(1000).then(() => {
      throw new Error("add not watched");
    }),
  ]);
  notify = Promise.withResolvers<void>();
  await rm(join(root, "src/routes/new.tsx"));
  await Promise.race([
    notify.promise,
    Bun.sleep(1000).then(() => {
      throw new Error("delete not watched");
    }),
  ]);
});

test("preview serves assets through symlinked roots but refuses escaping symlinks", async () => {
  const root = await fixture();
  const alias = `${root}-alias`;
  await symlink(root, alias);
  cleanups.push(() => rm(alias));
  await symlink(join(root, "package-secret.txt"), join(root, "dist/assets/escape.txt"));
  await Bun.write(join(root, "package-secret.txt"), "secret");
  const app = await server({ root: alias, mode: "preview" });
  expect((await fetch(new URL("/assets/main.js", app.url))).status).toBe(200);
  expect((await fetch(new URL("/assets/escape.txt", app.url))).status).toBe(404);
});

test("dev serves assets when the system temporary directory is symlinked", async () => {
  const root = await fixture();
  const alias = `${root}-tmp`;
  await symlink(root, alias);
  cleanups.push(() => rm(alias));
  const previous = process.env.TMPDIR;
  let app: Awaited<ReturnType<typeof startDashboardServer>>;
  try {
    process.env.TMPDIR = alias;
    app = await server({
      root,
      mode: "dev",
      watch: false,
      build: async (_root, output) => {
        await Bun.write(join(output, "index.html"), "<body>dev</body>");
        await Bun.write(join(output, "asset.js"), "export const ok = true");
      },
    });
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  expect((await fetch(new URL("/asset.js", app.url))).status).toBe(200);
});

test("edits during the initial build are serialized before startup finishes", async () => {
  const root = await fixture();
  const source = join(root, "src/value.ts");
  await Bun.write(source, "before");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let runs = 0;
  const starting = server({
    root,
    mode: "dev",
    build: async (_root, output) => {
      const value = await Bun.file(source).text();
      if (++runs === 1) {
        entered.resolve();
        await release.promise;
      }
      await Bun.write(join(output, "index.html"), `<body>${value}</body>`);
    },
  });
  await entered.promise;
  await Bun.write(source, "after");
  await Bun.sleep(150);
  release.resolve();
  const app = await starting;
  expect(await (await fetch(app.url)).text()).toContain("after");
  expect(runs).toBe(2);
});

test("failed startup releases watchers and temporary artifacts", async () => {
  const root = await fixture();
  await Bun.write(join(root, "src/value.ts"), "before");
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  cleanups.push(() => {
    occupied.stop(true);
  });
  let runs = 0;
  let artifact = "";
  if (occupied.port === undefined) throw new Error("no port");
  await expect(
    startDashboardServer({
      root,
      mode: "dev",
      hostname: "127.0.0.1",
      port: occupied.port,
      build: async (_root, output) => {
        runs++;
        artifact = join(output, "index.html");
        await Bun.write(artifact, "<body>built</body>");
      },
    }),
  ).rejects.toThrow();
  await Bun.write(join(root, "src/value.ts"), "after");
  await Bun.sleep(150);
  expect(runs).toBe(1);
  expect(await Bun.file(artifact).exists()).toBe(false);
});
