import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import type { Store } from "@omni/store";
import { memoryStore } from "@omni/testkit";
import { createApp } from "../../src/app.ts";
import { createTelemetry } from "../../src/telemetry/index.ts";

function telemetry(enabled = true) {
  return createTelemetry({
    metricsEnabled: enabled,
    maxSeries: 100,
    otlpEndpoint: null,
    otlpHeaders: {},
    traceSample: 1,
    now: () => 0,
    version: "test",
  });
}

test("metrics route is absent unless configured", async () => {
  const store = await memoryStore();
  const app = createApp({ store, baseUrl: "http://localhost", telemetry: telemetry(false) });
  const response = await app.handle(new Request("http://localhost/metrics"));
  expect(response.status).toBe(404);
});

test("metrics bearer auth returns an empty 401 and accepts the exact token", async () => {
  const store = await memoryStore();
  const app = createApp({
    store,
    baseUrl: "http://localhost",
    metricsToken: "correct horse",
    telemetry: telemetry(),
  });
  const wrong = await app.handle(
    new Request("http://localhost/metrics", { headers: { authorization: "Bearer wrong" } }),
  );
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toBe("");
  const right = await app.handle(
    new Request("http://localhost/metrics", {
      headers: { authorization: "Bearer correct horse" },
    }),
  );
  expect(right.status).toBe(200);
  expect(await right.text()).toContain("omni_build_info");
});

test("scrape reads neither store nor coordinator", async () => {
  const base = await memoryStore();
  const store = new Proxy(base, {
    get(target, property, receiver) {
      if (property === "routing") return Reflect.get(target, property, receiver);
      throw new Error(`store read: ${String(property)}`);
    },
  }) as Store;
  const baseCoord = memoryCoord();
  let armed = false;
  const coord = new Proxy(baseCoord, {
    get(target, property, receiver) {
      if (armed) throw new Error(`coord read: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });
  const app = createApp({
    store,
    coord,
    baseUrl: "http://localhost",
    metricsToken: "token",
    telemetry: telemetry(),
  });
  armed = true;

  const response = await app.handle(
    new Request("http://localhost/metrics", { headers: { authorization: "Bearer token" } }),
  );
  expect(response.status).toBe(200);
  expect((await response.text()).length).toBeGreaterThan(0);
});
