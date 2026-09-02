import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { createPendingFlows } from "../../src/oauth/pending.ts";

let clock = 1_000_000;
const flows = () => createPendingFlows({ now: () => clock, ttlMs: 600_000 });

const flow = (state: string) => ({
  provider: "anthropic" as const,
  label: "work",
  pending: { verifier: "v", challenge: "c", state, redirectUri: "r" },
});

test("stores and takes a flow by id", async () => {
  const p = flows();
  const id = await p.put(flow("s1"));
  expect((await p.take(id))?.label).toBe("work");
});

test("take is single-use", async () => {
  const p = flows();
  const id = await p.put(flow("s1"));
  await p.take(id);
  expect(await p.take(id)).toBeNull();
});

test("peek does not consume the flow", async () => {
  const p = flows();
  const id = await p.put(flow("s1"));
  await p.peek(id);
  expect(await p.peek(id)).not.toBeNull();
});

test("expires a flow after the ttl", async () => {
  const p = flows();
  const id = await p.put(flow("s1"));
  clock += 600_001;
  expect(await p.take(id)).toBeNull();
});

test("ids are unguessable", async () => {
  const p = flows();
  expect(await p.put(flow("s1"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
});

/** A flow started on one process finishes on another sharing its coord. */
test("a flow started by one process can be taken by another", async () => {
  const coord = memoryCoord({ now: () => clock });
  const a = createPendingFlows({ now: () => clock, ttlMs: 600_000, coord });
  const b = createPendingFlows({ now: () => clock, ttlMs: 600_000, coord });
  const id = await a.put(flow("s1"));
  expect((await b.take(id))?.label).toBe("work");
  expect(await a.take(id)).toBeNull();
});
