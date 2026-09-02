import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { healthKey } from "@omni/router";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";

const KEY = healthKey("cred-1", "claude-opus-4");

test("counts a request from acquire until release", async () => {
  const registry = createLoadRegistry();
  expect(registry.counts().get(KEY)).toBeUndefined();

  const release = registry.acquire("cred-1", "claude-opus-4");
  expect(registry.counts().get(KEY)).toBe(1);

  release();
  expect(registry.counts().get(KEY) ?? 0).toBe(0);
});

test("counts concurrent requests on one credential", async () => {
  const registry = createLoadRegistry();
  const first = registry.acquire("cred-1", "claude-opus-4");
  const second = registry.acquire("cred-1", "claude-opus-4");
  expect(registry.counts().get(KEY)).toBe(2);

  first();
  expect(registry.counts().get(KEY)).toBe(1);
  second();
  expect(registry.counts().get(KEY) ?? 0).toBe(0);
});

test("counts the same credential separately per model", async () => {
  const registry = createLoadRegistry();
  registry.acquire("cred-1", "claude-opus-4");
  const counts = await registry.counts();
  expect(counts.get(KEY)).toBe(1);
  expect(counts.get(healthKey("cred-1", "claude-sonnet-4")) ?? 0).toBe(0);
});

test("a second release does nothing", async () => {
  const registry = createLoadRegistry();
  const busy = registry.acquire("cred-1", "claude-opus-4");
  const release = registry.acquire("cred-1", "claude-opus-4");

  release();
  release();
  release();

  // The other request is still running; a double release must not free its slot.
  expect(registry.counts().get(KEY)).toBe(1);
  busy();
  expect(registry.counts().get(KEY) ?? 0).toBe(0);
});

test("counts are a snapshot, not a live view", async () => {
  const registry = createLoadRegistry();
  registry.acquire("cred-1", "claude-opus-4");
  const taken = await registry.counts();
  registry.acquire("cred-1", "claude-opus-4");

  // Ranking holds this map across a request and must not see it shift underneath.
  expect(taken.get(KEY)).toBe(1);
  expect(registry.counts().get(KEY)).toBe(2);
});

/**
 * Two processes sharing one `Coord` see each other's load after a refresh, and
 * a process never double-counts the slots it published itself.
 */
test("reports the fleet's load after refresh, without counting itself twice", async () => {
  const coord = memoryCoord();
  const a = createLoadRegistry(coord);
  const b = createLoadRegistry(coord);

  const release = a.acquire("cred-1", "claude-opus-4");
  expect(b.counts().get(KEY) ?? 0).toBe(0);
  await b.refresh();
  expect(b.counts().get(KEY)).toBe(1);

  await a.refresh();
  expect(a.counts().get(KEY)).toBe(1);

  release();
  await b.refresh();
  expect(b.counts().get(KEY) ?? 0).toBe(0);
});
