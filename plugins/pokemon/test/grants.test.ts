import { expect, test } from "bun:test";
import { decideGrant, grantSize, windowKey } from "../src/grants.ts";

test("a window's key is its dimension and window, and nothing volatile", () => {
  // The bug this prevents has shipped twice, in two codebases. A reset instant
  // is recomputed on every evaluation, so keying an edge trigger on it re-fires
  // the grant on every refresh while the key sits at its ceiling.
  expect(windowKey({ dimension: "tokens", window: "1w" })).toBe("tokens:1w");
  expect(windowKey({ dimension: "requests", window: "1m" })).toBe("requests:1m");

  // Stable across repeated calls with the same input, which is the property an
  // edge key actually needs.
  const a = windowKey({ dimension: "spend", window: "5h" });
  const b = windowKey({ dimension: "spend", window: "5h" });
  expect(a).toBe(b);
});

test("different windows on the same dimension are different keys", () => {
  // Otherwise filling a minute limit would mark the weekly one as paid.
  expect(windowKey({ dimension: "tokens", window: "1m" })).not.toBe(
    windowKey({ dimension: "tokens", window: "1w" }),
  );
});

test("a week's ceiling is worth more than an afternoon's", () => {
  expect(grantSize("1w")).toBe(5);
  expect(grantSize("5h")).toBe(1);
  expect(grantSize("1m")).toBe(1);
});

test("the first sighting of a key seeds and pays nothing", () => {
  // Installing the plugin against a key already at its ceiling must not be a
  // backdated windfall.
  const decision = decideGrant({ window: "1w", grantedTier: 0, seeded: false });
  expect(decision.grant).toBe(false);
  if (decision.grant) return;
  expect(decision.seedTo).toBe(1);
});

test("a window at its ceiling pays once, not on every evaluation", () => {
  // Edge, not level. A key sitting at its limit reports it continuously; paying
  // each time turns a rate limit into a faucet.
  const first = decideGrant({ window: "1w", grantedTier: 0, seeded: true });
  expect(first).toEqual({ grant: true, count: 5, tier: 1 });

  const again = decideGrant({ window: "1w", grantedTier: 1, seeded: true });
  expect(again).toEqual({ grant: false });
});

test("a window that emptied and refilled pays again", () => {
  // The other half of an edge trigger: once the stored tier is cleared, the next
  // fill is a genuine new edge rather than the same one still being reported.
  expect(decideGrant({ window: "5h", grantedTier: 0, seeded: true })).toEqual({
    grant: true,
    count: 1,
    tier: 1,
  });
});

test("seeding takes precedence over an edge, so the first event never pays", () => {
  // Both conditions true at once. An unseeded key whose window looks like a
  // fresh edge is still the install moment, not an achievement.
  const decision = decideGrant({ window: "1w", grantedTier: 0, seeded: false });
  expect(decision.grant).toBe(false);
});
