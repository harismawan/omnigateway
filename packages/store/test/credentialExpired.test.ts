import { expect, test } from "bun:test";
import { type AuthType, credentialExpired } from "../src/types.ts";

const NOW = 1_700_000_000_000;

function credential(
  overrides: Partial<{
    authType: AuthType;
    expiresAt: number | null;
    hasRefreshToken: boolean;
  }> = {},
): { authType: AuthType; expiresAt: number | null; hasRefreshToken: boolean } {
  return { authType: "oauth", expiresAt: null, hasRefreshToken: false, ...overrides };
}

/**
 * The sibling of `keyUsable`, and pinned the same way for the same reason.
 *
 * Two of these clauses had no test when the helper landed, and both fail open —
 * they report a working account as expired, which the router then refuses.
 */
test("an API key is never expired, whatever its expiresAt says", () => {
  // The clause the CLI's restatement dropped. `expiresAt` on an API key is
  // operator bookkeeping and the router has never refused one for it, so a
  // listing that says otherwise disagrees with what the gateway does.
  expect(credentialExpired(credential({ authType: "apiKey", expiresAt: NOW - 1 }), NOW)).toBe(
    false,
  );
});

test("a null expiry is never expired", () => {
  // Without the `expiresAt !== null` clause this reads `null <= now`, which JS
  // coerces to `0 <= now` — true. A credential that never expires would be
  // refused on every request, and the message would say it had expired.
  expect(credentialExpired(credential({ expiresAt: null }), NOW)).toBe(false);
});

test("the boundary instant is already expired", () => {
  // Exclusive, the same direction `keyUsable` takes: `expiresAt` is when the
  // token stops working, so the instant it names is outside. `<` here would
  // leave one millisecond in which an expired token is still handed upstream.
  expect(credentialExpired(credential({ expiresAt: NOW }), NOW)).toBe(true);
  expect(credentialExpired(credential({ expiresAt: NOW + 1 }), NOW)).toBe(false);
});

test("a refreshable credential past expiry is not expired", () => {
  // Dispatch refreshes before the call, so the router keeps it. This is the
  // one clause that makes the predicate "beyond use" rather than "past expiry".
  expect(credentialExpired(credential({ expiresAt: NOW - 1, hasRefreshToken: true }), NOW)).toBe(
    false,
  );
  expect(credentialExpired(credential({ expiresAt: NOW - 1, hasRefreshToken: false }), NOW)).toBe(
    true,
  );
});
