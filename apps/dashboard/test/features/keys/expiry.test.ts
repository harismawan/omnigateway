import { afterAll, expect, test } from "bun:test";
import { keyUsable } from "@omni/store/types";
import { fromLocalInput, keyState, toLocalInput } from "../../../src/features/keys/expiry.ts";
import { apiKey } from "../../helpers/fixtures.ts";

/**
 * Runs one assertion under a fixed zone, because the ambient one proves nothing.
 *
 * `bun test` pins the process to UTC and reports it as an unset `TZ`, so every
 * offset the board renders is zero and a conversion that subtracts the offset,
 * adds it, or ignores it entirely produces the same string. The three round-trip
 * assertions in `keys.test.tsx` were identities for exactly this reason: they
 * recomputed the implementation's own expression under a zero offset.
 *
 * Restored to `"UTC"` rather than to the absence, because deleting the variable
 * hands the next file the host's own zone rather than the runner's default —
 * measured, on a machine at UTC-7.
 */
function withTz<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    process.env.TZ = before ?? "UTC";
  }
}

afterAll(() => {
  process.env.TZ = "UTC";
});

/**
 * One instant, its local wall time, and the zone that relates them.
 *
 * Two zones on opposite sides of UTC, and in Denver's case two offsets — June is
 * MDT and January is MST — so a conversion that hard-codes one offset, or the
 * wrong sign, cannot satisfy the table. Each `local` is written out rather than
 * computed: an expectation derived from the code under test agrees with it by
 * construction.
 */
const CASES = [
  { tz: "Asia/Kolkata", at: Date.UTC(2030, 5, 1, 12, 0), local: "2030-06-01T17:30" },
  // Past midnight local, so the date moves and not just the clock.
  { tz: "Asia/Kolkata", at: Date.UTC(2030, 5, 1, 20, 0), local: "2030-06-02T01:30" },
  { tz: "America/Denver", at: Date.UTC(2030, 5, 1, 12, 0), local: "2030-06-01T06:00" },
  // Back a day, and on the other side of the DST boundary from the line above.
  { tz: "America/Denver", at: Date.UTC(2030, 0, 1, 4, 0), local: "2029-12-31T21:00" },
] as const;

test("an instant renders as its local wall time, in whichever zone the operator is in", () => {
  for (const { tz, at, local } of CASES) {
    expect(withTz(tz, () => toLocalInput(at))).toBe(local);
  }
});

test("what the field holds parses back to the instant it names, not to the same clock in UTC", () => {
  for (const { tz, at, local } of CASES) {
    expect(withTz(tz, () => fromLocalInput(local))).toEqual({ at });
    // And the other direction of the same trip, which is what the dialog does
    // when an operator opens it and saves without touching the field.
    expect(withTz(tz, () => fromLocalInput(toLocalInput(at)))).toEqual({ at });
  }
});

/** Blank is "never", in both directions, and is how an expiry is cleared. */
test("blank and null are the same fact", () => {
  expect(toLocalInput(null)).toBe("");
  expect(fromLocalInput("")).toEqual({ at: null });
  expect(fromLocalInput("   ")).toEqual({ at: null });
});

test("something that is not a date is reported rather than sent as NaN", () => {
  expect(fromLocalInput("next tuesday")).toEqual({ problem: `"next tuesday" is not a date` });
});

/**
 * A stored instant outside `Date`'s ±8.64e15 range.
 *
 * `keyExpirySchema` refuses it, so it can only arrive from a restored or
 * hand-edited row — the same way `sqlite/config.ts` reads targets back
 * unvalidated. Blank rather than a throw, because this runs in a `useState`
 * initialiser and a `RangeError` there takes the whole dialog into the route's
 * error boundary.
 */
test("an out-of-range instant blanks the field instead of throwing", () => {
  expect(() => toLocalInput(9e15)).not.toThrow();
  expect(toLocalInput(9e15)).toBe("");
});

/**
 * The label agrees with `/v1` at the instant itself, which is the only instant
 * where agreeing is a claim.
 *
 * `keyState` reads the boundary out of `keyUsable` rather than restating it, so
 * this asserts the two together: whatever the store says at `expiresAt === now`,
 * the board says the matching word.
 */
test("the label follows keyUsable exactly, boundary included", () => {
  const now = 1_000_000;
  const at = (expiresAt: number | null) => apiKey({ expiresAt });

  expect(keyUsable(at(now), now)).toBe(false);
  expect(keyState(at(now), now)).toBe("expired");

  expect(keyUsable(at(now + 1), now)).toBe(true);
  expect(keyState(at(now + 1), now)).toBe("active");

  expect(keyState(at(null), now)).toBe("active");
  // Revoked wins over both, and is the answer `keyUsable` cannot give.
  expect(keyState(apiKey({ revokedAt: 1, expiresAt: now + 1 }), now)).toBe("revoked");
  expect(keyState(apiKey({ revokedAt: 1, expiresAt: now }), now)).toBe("revoked");
});
