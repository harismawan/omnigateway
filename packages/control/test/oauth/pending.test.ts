import { expect, test } from "bun:test";
import { createPendingFlows } from "../../src/oauth/pending.ts";

let clock = 1_000_000;
const flows = () => createPendingFlows({ now: () => clock, ttlMs: 600_000 });

const flow = (state: string) => ({
  provider: "anthropic" as const,
  label: "work",
  pending: { verifier: "v", challenge: "c", state, redirectUri: "r" },
});

test("stores and takes a flow by id", () => {
  const p = flows();
  const id = p.put(flow("s1"));
  expect(p.take(id)?.label).toBe("work");
});

test("take is single-use", () => {
  const p = flows();
  const id = p.put(flow("s1"));
  p.take(id);
  expect(p.take(id)).toBeNull();
});

test("finds a flow by its state parameter", () => {
  const p = flows();
  p.put(flow("s1"));
  expect(p.byState("s1")?.label).toBe("work");
});

test("byState does not consume the flow", () => {
  const p = flows();
  p.put(flow("s1"));
  p.byState("s1");
  expect(p.byState("s1")).not.toBeNull();
});

test("returns null for an unknown state", () => {
  expect(flows().byState("nope")).toBeNull();
});

test("never finds a blank state", () => {
  const p = flows();
  p.put(flow(""));
  expect(p.byState("")).toBeNull();
});

test("expires a flow after the ttl", () => {
  const p = flows();
  const id = p.put(flow("s1"));
  clock += 600_001;
  expect(p.take(id)).toBeNull();
  expect(p.byState("s1")).toBeNull();
});

test("sweep drops expired flows", () => {
  const p = flows();
  p.put(flow("s1"));
  expect(p.size()).toBe(1);
  clock += 600_001;
  p.sweep();
  expect(p.size()).toBe(0);
});

test("ids are unguessable", () => {
  const p = flows();
  expect(p.put(flow("s1"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
