import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { memoryStore } from "./helpers/fixtures.ts";

async function app() {
  return createApp({
    store: await memoryStore(),
    baseUrl: "http://localhost",
    staticDir: `${import.meta.dir}/fixtures/static`,
  });
}

test("the index is served at the root", async () => {
  const res = await (await app()).handle(new Request("http://localhost/"));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("text/html");
  expect(await res.text()).toContain('<div id="root">');
});

test("an HTML navigation falls back to the index so deep links work", async () => {
  const res = await (await app()).handle(
    new Request("http://localhost/logs", { headers: { accept: "text/html" } }),
  );

  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<div id="root">');
});

test("a non-navigation miss returns JSON rather than the app shell", async () => {
  const res = await (await app()).handle(
    new Request("http://localhost/missing.js", { headers: { accept: "application/javascript" } }),
  );

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("an encoded api path returns JSON rather than the app shell", async () => {
  const res = await (await app()).handle(
    new Request("http://localhost/%61pi%2Fnope", { headers: { accept: "text/html" } }),
  );

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("an encoded path separator does not fall back to the app shell", async () => {
  const res = await (await app()).handle(
    new Request("http://localhost/%2Fapi%2Fnope", { headers: { accept: "text/html" } }),
  );

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("an in-tree symlink to an outside file is not served", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omnigateway-static-"));
  const bundle = join(directory, "bundle");
  const outside = join(directory, "outside.js");
  const link = join(bundle, "leak.js");

  try {
    mkdirSync(bundle);
    writeFileSync(join(bundle, "index.html"), '<div id="root"></div>');
    writeFileSync(outside, "outside content");
    try {
      symlinkSync(outside, link);
    } catch {
      return;
    }

    const gateway = createApp({
      store: await memoryStore(),
      baseUrl: "http://localhost",
      staticDir: bundle,
    });
    const res = await gateway.handle(new Request("http://localhost/leak.js"));

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("outside content");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("an unknown api path stays a 404 and never falls back to html", async () => {
  const res = await (await app()).handle(new Request("http://localhost/api/nope"));

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});

test("an unknown proxy path stays a 404", async () => {
  const res = await (await app()).handle(new Request("http://localhost/v1/nope"));

  expect(res.status).toBe(404);
});

test("an unknown OAuth path stays a 404", async () => {
  const res = await (await app()).handle(new Request("http://localhost/oauth/nope"));

  expect(res.status).toBe(404);
});

test("hashed assets are served with a long cache lifetime", async () => {
  const res = await (await app()).handle(new Request("http://localhost/assets/app-abc123.js"));

  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("immutable");
  expect(res.headers.get("content-type") ?? "").toContain("text/javascript");
});

test("the index is never cached, so a deploy is picked up immediately", async () => {
  const res = await (await app()).handle(new Request("http://localhost/"));

  expect(res.headers.get("cache-control")).toContain("no-cache");
});

test("static paths cannot escape the dashboard directory", async () => {
  const res = await (await app()).handle(
    new Request("http://localhost/assets/%252e%252e/%252e%252e/src/app.ts"),
  );

  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("createApp");
});

test("a missing dashboard bundle leaves non-gateway paths unrouted", async () => {
  const gateway = createApp({
    store: await memoryStore(),
    baseUrl: "http://localhost",
    staticDir: `${import.meta.dir}/fixtures/missing`,
  });
  const res = await gateway.handle(new Request("http://localhost/logs"));

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
});
