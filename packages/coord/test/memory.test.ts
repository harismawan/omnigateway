import { expect, test } from "bun:test";
import { memoryCoord } from "../src/index.ts";
import { coordContract } from "./contract.ts";

coordContract("memory", async (now) => memoryCoord({ now }));

const T0 = 1_700_000_000_000;

/**
 * The idle-ring sweep is time-gated, and the gate must not turn into "never".
 *
 * A ring that drained is only reclaimable memory, so it is dropped at most once
 * per second rather than on every claim — but a gate that compares the wrong
 * way, or against the wrong instant, either walks every ring on every claim or
 * never walks again. `liveWindows` exists because the drop changes no other
 * answer this implementation gives.
 */
test("memory: drops a drained ring once per interval, and survives a clock step", () => {
  const coord = memoryCoord();
  coord.window.claim("a", 60_000, T0);
  coord.window.claim("b", 60_000, T0 + 500);
  expect(coord.liveWindows()).toBe(2);

  // `a` aged out, `b` has not; this claim sweeps.
  coord.window.claim("c", 60_000, T0 + 60_001);
  expect(coord.liveWindows()).toBe(2);

  // `b` droppable now, but inside the interval that just swept.
  coord.window.claim("c", 60_000, T0 + 60_501);
  expect(coord.liveWindows()).toBe(2);

  // Exactly the interval on, and `b` goes.
  coord.window.claim("c", 60_000, T0 + 61_001);
  expect(coord.liveWindows()).toBe(1);

  // Clock steps back an hour: the latch sits in the future, and must not hold
  // the sweep off for the length of the step.
  const back = T0 - 3_600_000;
  coord.window.claim("x", 60_000, back);
  coord.window.claim("y", 60_000, back + 60_001);
  expect(coord.liveWindows()).toBe(2);
});

/**
 * A gauge slot expires on time even while its holder is still running, and the
 * two consumers are commented against exactly this.
 *
 * `GAUGE_TTL_MS` in `apps/gateway/src/auth/rateLimit.ts` and `SLOT_TTL_MS` in
 * `apps/gateway/src/dispatch/loadRegistry.ts` are both 300s, and were sized as
 * "past the request deadline" when that deadline was a finite 120s. It is 0 —
 * unlimited — by default now, so nothing keeps a request under either TTL, and
 * a `concurrency: 1` key admits a second request beside a live first one.
 *
 * This pins the mechanism rather than the consequence: expiry applies in the
 * memory implementation too, not only in Redis. A comment claiming otherwise
 * (this file's own said "ignored in memory") reads as a leak-only floor and
 * hides the ceiling break on single-process installations. If a future change
 * renews slots, or makes expiry Redis-only, this test says so.
 */
test("memory: a gauge slot expires while its holder is still live", async () => {
  let at = T0;
  const coord = memoryCoord({ now: () => at });
  const TTL = 300_000;

  // An *unnamed* holder takes the only slot of a `concurrency: 1` key.
  expect(await coord.gauge.acquire("lim:k", TTL)).toBe(0);
  expect(await coord.gauge.read("lim:k")).toBe(1);

  // Still running — no release — but past its TTL.
  at = T0 + TTL + 1;
  expect(await coord.gauge.read("lim:k")).toBe(0);
  // `before` of 0 is what the limiter reads as "room for one more".
  expect(await coord.gauge.acquire("lim:k", TTL)).toBe(0);

  // One millisecond earlier the slot is still counted, so the boundary is the
  // expiry and not some other sweep. `liveSlots` keeps `expiresAt > at`, so the
  // slot is already gone *at* its expiry, not one tick after.
  at = T0;
  const fresh = memoryCoord({ now: () => at });
  await fresh.gauge.acquire("lim:j", TTL);
  at = T0 + TTL - 1;
  expect(await fresh.gauge.read("lim:j")).toBe(1);
  at = T0 + TTL;
  expect(await fresh.gauge.read("lim:j")).toBe(0);
});

/**
 * Renewal is what makes the ceiling hold for a request with no deadline.
 *
 * The test above is the defect; this is the fix. A named slot renewed inside
 * its TTL stays counted indefinitely, so `concurrency: 1` keeps refusing a
 * rival however long the first request runs — which is what
 * `docs/operations.md` promises and what `requestDeadlineMs: 0` would
 * otherwise break.
 */
test("memory: a renewed slot holds its ceiling past any number of TTLs", async () => {
  let at = T0;
  const coord = memoryCoord({ now: () => at });
  const TTL = 300_000;
  const HOLDER = "req-1";

  expect(await coord.gauge.acquire("lim:k", TTL, HOLDER)).toBe(0);

  // Twenty TTLs — over an hour — renewing at a third of the TTL each time.
  for (let i = 0; i < 60; i++) {
    at += TTL / 3;
    await coord.gauge.renew("lim:k", HOLDER, TTL);
    expect(await coord.gauge.read("lim:k")).toBe(1);
  }
  // A rival still sees the slot held, which is the whole point.
  expect(await coord.gauge.acquire("lim:k", TTL, "req-2")).toBe(1);

  // The named release drops that slot and no other.
  await coord.gauge.release("lim:k", HOLDER);
  expect(await coord.gauge.read("lim:k")).toBe(1);
  await coord.gauge.release("lim:k", "req-2");
  expect(await coord.gauge.read("lim:k")).toBe(0);
});

/**
 * The three ways a named slot must not become a second slot or a phantom.
 *
 * Re-acquiring under one name is how a retry looks, and it must move the
 * expiry rather than stack; `before` must then exclude the caller's own slot
 * or a request reads as its own rival. Renewing a slot that no longer exists
 * is how a renewal racing its own release looks, and it must stay absent
 * rather than resurrect as a holder nothing will ever release.
 */
test("memory: a named slot is idempotent, self-excluding, and never resurrected", async () => {
  let at = T0;
  const coord = memoryCoord({ now: () => at });
  const TTL = 1_000;

  expect(await coord.gauge.acquire("g", TTL, "a")).toBe(0);
  // Same name again: one slot, and `before` reports the others, not itself.
  expect(await coord.gauge.acquire("g", TTL, "a")).toBe(0);
  expect(await coord.gauge.read("g")).toBe(1);

  expect(await coord.gauge.acquire("g", TTL, "b")).toBe(1);
  // `a` re-acquiring now sees exactly one rival, never two.
  expect(await coord.gauge.acquire("g", TTL, "a")).toBe(1);
  expect(await coord.gauge.read("g")).toBe(2);

  // Released, then renewed: the renewal must find nothing and add nothing.
  await coord.gauge.release("g", "a");
  expect(await coord.gauge.read("g")).toBe(1);
  await coord.gauge.renew("g", "a", TTL);
  expect(await coord.gauge.read("g")).toBe(1);

  // Lapsed, then renewed: same rule.
  at = T0 + TTL + 1;
  expect(await coord.gauge.read("g")).toBe(0);
  await coord.gauge.renew("g", "b", TTL);
  expect(await coord.gauge.read("g")).toBe(0);
});
