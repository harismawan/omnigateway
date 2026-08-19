import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@omni/store";
import { createStore, deriveKey } from "@omni/store";
import type { LimitReached, RequestCompleted } from "@omnigateway/plugin-api";
import type { PluginContext, PluginRoute, PluginStorage } from "@omnigateway/plugin-api/define";
import { WINDOW_MS } from "@omnigateway/plugin-api/events";
import { EGG_HATCH_THRESHOLD, graduationTotal, ITEM_PRICES } from "../src/balance.ts";
import companion from "../src/server.ts";
import { readCompanion, readDex } from "../src/store.ts";

/**
 * The loop as the gateway actually drives it: the plugin's own `setup`, its own
 * migrations, a real store, and real events.
 *
 * Every other test in this package exercises one piece. This is the one that
 * would notice if the pieces stopped fitting — a credit that never reaches the
 * state machine, a graduation that never reaches the Dex, an event handler
 * subscribed to the wrong thing.
 */

const KEY = "key_1";
let dir = "";
let store: Store;
let storage: PluginStorage;
let onRequest: ((event: RequestCompleted) => void) | null = null;
let onLimit: ((event: LimitReached) => void) | null = null;
let routes: readonly PluginRoute[] = [];
let logged: Array<{ message: string; event?: string | undefined }> = [];
let clock = 1_700_000_000_000;

function completed(over: Partial<RequestCompleted> = {}): RequestCompleted {
  return {
    requestId: "req_1",
    apiKeyId: KEY,
    provider: "anthropic",
    model: "claude-opus-5",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    durationMs: 10,
    ok: true,
    at: 1_000,
    ...over,
  };
}

/** Credits a flat number of tokens through the event path, as a request would. */
function spend(tokens: number, requestId = `req_${Math.trunc(tokens)}`): void {
  onRequest?.(
    completed({ requestId, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  );
}

async function boot(config: Record<string, unknown> = {}): Promise<void> {
  const applied = store.plugins.migrate("pokemon", companion.migrations ?? []);
  expect(applied.failed).toBeUndefined();

  storage = {
    run: (sql, params) =>
      store.plugins.run("pokemon", sql, params === undefined ? [] : [...params]),
    all: (sql, params) =>
      store.plugins.all("pokemon", sql, params === undefined ? [] : [...params]),
    get: (sql, params) =>
      store.plugins.get("pokemon", sql, params === undefined ? [] : [...params]),
    transaction: (fn) => store.plugins.transaction("pokemon", fn),
  };

  const context: PluginContext = {
    id: "pokemon",
    now: () => clock,
    logger: {
      debug: () => {},
      info: (message, fields) => logged.push({ message, event: fields?.event }),
      warn: () => {},
      error: () => {},
    },
    storage,
    // No `net` and no `files`: this is the offline install, which is also the
    // shape that keeps the test off the network. Prefetching a species is the
    // one thing that needs them, and it degrades rather than throwing.
    events: {
      onRequestCompleted: (handler) => {
        onRequest = handler;
      },
      onLimitReached: (handler) => {
        onLimit = handler;
      },
    },
    config,
  };

  const result = await companion.setup(context);
  routes = result?.routes ?? [];
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "poke-e2e-"));
  store = await createStore({
    path: join(dir, "t.db"),
    encryptionKey: await deriveKey("0".repeat(64)),
  });
  onRequest = null;
  onLimit = null;
  logged = [];
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("the plugin subscribes to both events and exposes its routes", async () => {
  await boot();
  expect(onRequest).not.toBeNull();
  expect(onLimit).not.toBeNull();
  expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
    "GET /keys/:id",
    "GET /sprite/:species",
    "POST /keys/:id/purchase",
    "POST /keys/:id/use",
  ]);
});

test("a finished request credits its key and nobody else", async () => {
  await boot();
  spend(1_234);
  onRequest?.(
    completed({
      requestId: "req_x",
      apiKeyId: "key_other",
      tokens: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );

  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_234);
  expect(readCompanion(storage, "key_other")?.tokensTotal).toBe(99);
});

test("all four token classes count toward growth", async () => {
  // They are disjoint — `input` is uncached input — so summing them
  // double-counts nothing, and dropping any one of them would quietly halve a
  // cache-heavy install's growth.
  await boot();
  onRequest?.(completed({ tokens: { input: 1, output: 10, cacheRead: 100, cacheWrite: 1_000 } }));
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(1_111);
});

test("the operator's multiplier scales credits and is never retroactive", async () => {
  await boot({ multiplier: 10 });
  spend(1_000);
  expect(readCompanion(storage, KEY)?.tokensTotal).toBe(10_000);
});

test("a nonsense multiplier falls back to 1 rather than zeroing growth", async () => {
  // A zero or negative multiplier would stop every companion in the install
  // dead, with nothing to say why.
  for (const multiplier of [0, -5, Number.NaN, "fast"]) {
    await rm(join(dir, "t.db"), { force: true });
    store.close();
    store = await createStore({
      path: join(dir, "t.db"),
      encryptionKey: await deriveKey("0".repeat(64)),
    });
    await boot({ multiplier });
    spend(500);
    expect(readCompanion(storage, KEY)?.tokensTotal).toBe(500);
  }
});

test("an egg with no species available holds its progress instead of losing it", async () => {
  // The offline install. There is no `net`, so nothing can be rolled — and the
  // incubation has to survive that, or an outage silently costs a player their
  // egg.
  await boot();
  spend(EGG_HATCH_THRESHOLD * 2);

  const row = readCompanion(storage, KEY);
  expect(row?.state?.active).toBeNull();
  expect(row?.state?.eggUsage).toBe(EGG_HATCH_THRESHOLD * 2);
  expect(row?.tokensTotal).toBe(EGG_HATCH_THRESHOLD * 2);
});

test("a companion hatches, grows and graduates into the Dex", async () => {
  // The whole arc through the real event path. The species is planted directly,
  // because rolling one needs the network and this test does not.
  await boot();
  spend(1_000);
  storage.run("UPDATE {{companion}} SET state = ? WHERE api_key_id = ?", [
    JSON.stringify({
      consumedTotal: 1_000,
      active: null,
      eggUsage: 1_000,
      eggTier: null,
      pendingHatch: {
        speciesId: 1,
        path: [1, 2, 3],
        rarity: "common",
        isShiny: true,
        nature: "jolly",
        ditto: false,
      },
      inventory: { rareCandy: 0, mint: 0, shinyCharm: 0 },
      grantSeeded: false,
    }),
    KEY,
  ]);

  spend(EGG_HATCH_THRESHOLD + graduationTotal("common"), "req_big");

  const dex = readDex(storage, KEY);
  expect(dex).toHaveLength(1);
  expect(dex[0]).toMatchObject({ baseId: 1, finalId: 3, rarity: "common", isShiny: true });

  // And it is back to an egg, ready to start again.
  expect(readCompanion(storage, KEY)?.state?.active).toBeNull();
  expect(logged.some((l) => l.event === "companion.graduated")).toBe(true);
});

test("a weekly ceiling pays at most weekly, and never on the install itself", async () => {
  // The clock has to move here, and that is the point rather than a nuisance.
  // `LimitReached` fires continuously while a key is at its ceiling and says
  // nothing when it drops, so payment is rated by the window's own length. A
  // frozen clock means a window that can never re-arm — which is exactly what a
  // key parked at its limit should experience.
  await boot();
  spend(1_000);

  const limit: LimitReached = { apiKeyId: KEY, dimension: "tokens", window: "1w", at: 2_000 };
  const candy = () => readCompanion(storage, KEY)?.state?.inventory.rareCandy;

  // First sighting seeds and pays nothing.
  onLimit?.(limit);
  expect(candy()).toBe(0);

  // Still the same instant: a key parked at its ceiling is not a faucet.
  onLimit?.(limit);
  onLimit?.(limit);
  expect(candy()).toBe(0);

  clock += WINDOW_MS["1w"];
  onLimit?.(limit);
  expect(candy()).toBe(5);

  // And immediately again pays nothing more.
  onLimit?.(limit);
  expect(candy()).toBe(5);

  clock += WINDOW_MS["1w"];
  onLimit?.(limit);
  expect(candy()).toBe(10);
});

test("a five-hour window re-arms on its own schedule, not the weekly one", async () => {
  await boot();
  spend(1_000);
  const short: LimitReached = { apiKeyId: KEY, dimension: "requests", window: "5h", at: 1 };

  onLimit?.(short);
  clock += WINDOW_MS["5h"];
  onLimit?.(short);
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(1);
});

test("a minute ceiling pays nothing, however often it is hit", async () => {
  // Rated by its own length it would pay a candy a minute — 100M XP each,
  // ~144B a day against a 750M–6B graduation. The economy's premise is that
  // growth costs work, and a minute is not a span in which work happened.
  await boot();
  spend(1_000);
  const minute: LimitReached = { apiKeyId: KEY, dimension: "requests", window: "1m", at: 1 };
  for (let i = 0; i < 5; i++) {
    onLimit?.(minute);
    clock += WINDOW_MS["1m"];
  }
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(0);
});

test("a key at every ceiling at once is paid for none of them", async () => {
  // The install-instant windfall, end to end. Seeding is per window, so each of
  // these seeds and none pays — the earlier per-key flag paid for every window
  // after the first, up to eleven free candies for a key merely already at its
  // limits.
  await boot();
  spend(1_000);
  for (const dimension of ["tokens", "requests", "spend"] as const) {
    for (const window of ["1w", "5h"] as const) {
      onLimit?.({ apiKeyId: KEY, dimension, window, at: 1 });
    }
  }
  expect(readCompanion(storage, KEY)?.state?.inventory.rareCandy).toBe(0);
});

test("a limit on a key with no companion is ignored rather than crashing", async () => {
  // Limits fire for keys that have never served a request through this plugin.
  await boot();
  expect(() =>
    onLimit?.({ apiKeyId: "never-seen", dimension: "tokens", window: "1w", at: 1 }),
  ).not.toThrow();
});

test("the panel route reports a companion, and 404s for a key without one", async () => {
  await boot();
  spend(2_000);

  const route = routes.find((r) => r.path === "/keys/:id");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const found = await route.handler({ params: { id: KEY }, query: {}, body: null });
  expect(found.status).toBeUndefined();
  expect(found.json).toMatchObject({ tokensTotal: 2_000, wallet: 2_000 });

  const missing = await route.handler({ params: { id: "nobody" }, query: {}, body: null });
  expect(missing.status).toBe(404);
});

test("buying through the route spends the wallet and leaves growth alone", async () => {
  await boot();
  spend(ITEM_PRICES.mint * 3);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  expect(route).toBeDefined();
  if (route === undefined) return;

  const bought = await route.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "mint" },
  });
  expect(bought.status).toBeUndefined();

  const row = readCompanion(storage, KEY);
  expect(row?.tokensTotal).toBe(ITEM_PRICES.mint * 3);
  expect(row?.tokensSpent).toBe(ITEM_PRICES.mint);
  expect(row?.state?.inventory.mint).toBe(1);
});

test("an unaffordable purchase is refused and changes nothing", async () => {
  await boot();
  spend(10);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  const refused = await route?.handler({
    params: { id: KEY },
    query: {},
    body: { kind: "item", item: "shinyCharm" },
  });

  expect(refused?.status).toBe(409);
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(0);
});

test("an unknown shop entry is refused before it can be priced", async () => {
  await boot();
  spend(10_000_000_000);

  const route = routes.find((r) => r.path === "/keys/:id/purchase");
  for (const body of [
    { kind: "item", item: "masterBall" },
    { kind: "egg", tier: "legendary" },
    { kind: "nonsense" },
    null,
    "egg",
  ]) {
    const refused = await route?.handler({ params: { id: KEY }, query: {}, body });
    expect(refused?.status).toBe(400);
  }
  expect(readCompanion(storage, KEY)?.tokensSpent).toBe(0);
});

test("a sprite request without the net capability degrades rather than throwing", async () => {
  await boot();
  const route = routes.find((r) => r.path === "/sprite/:species");
  const response = await route?.handler({ params: { species: "25" }, query: {}, body: null });
  expect(response?.status).toBe(503);
});

test("a non-numeric species id is refused before any lookup", async () => {
  await boot();
  const route = routes.find((r) => r.path === "/sprite/:species");
  const response = await route?.handler({
    params: { species: "../secret" },
    query: {},
    body: null,
  });
  expect(response?.status).toBe(400);
});
