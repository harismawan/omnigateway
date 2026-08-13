import { expect, test } from "bun:test";
import { healthKey } from "@omni/router";
import { createLoadRegistry } from "../../src/dispatch/loadRegistry.ts";

const KEY = healthKey("cred-1", "claude-opus-4");

test("counts a request from acquire until release", () => {
  const registry = createLoadRegistry();
  expect(registry.counts().get(KEY)).toBeUndefined();

  const release = registry.acquire("cred-1", "claude-opus-4");
  expect(registry.counts().get(KEY)).toBe(1);

  release();
  expect(registry.counts().get(KEY) ?? 0).toBe(0);
});

test("counts concurrent requests on one credential", () => {
  const registry = createLoadRegistry();
  const first = registry.acquire("cred-1", "claude-opus-4");
  const second = registry.acquire("cred-1", "claude-opus-4");
  expect(registry.counts().get(KEY)).toBe(2);

  first();
  expect(registry.counts().get(KEY)).toBe(1);
  second();
  expect(registry.counts().get(KEY) ?? 0).toBe(0);
});

test("counts the same credential separately per model", () => {
  const registry = createLoadRegistry();
  registry.acquire("cred-1", "claude-opus-4");
  const counts = registry.counts();
  expect(counts.get(KEY)).toBe(1);
  expect(counts.get(healthKey("cred-1", "claude-sonnet-4")) ?? 0).toBe(0);
});

test("a second release does nothing", () => {
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

test("counts are a snapshot, not a live view", () => {
  const registry = createLoadRegistry();
  registry.acquire("cred-1", "claude-opus-4");
  const taken = registry.counts();
  registry.acquire("cred-1", "claude-opus-4");

  // Ranking holds this map across a request and must not see it shift underneath.
  expect(taken.get(KEY)).toBe(1);
  expect(registry.counts().get(KEY)).toBe(2);
});
