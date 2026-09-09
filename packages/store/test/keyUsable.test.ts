import { expect, test } from "bun:test";
import { type ApiKey, keyUsable } from "../src/types.ts";

const NOW = 1_700_000_000_000;

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "k1",
    label: "k1",
    prefix: "sk-omni-cccc",
    hash: "a".repeat(64),
    modelAllowlist: null,
    limits: {},
    bodyLoggingOptOut: false,
    createdAt: 0,
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

test("a key with no expiry is usable, and revocation still refuses one", () => {
  expect(keyUsable(key(), NOW)).toBe(true);
  expect(keyUsable(key({ revokedAt: 1 }), NOW)).toBe(false);
});

/**
 * The boundary, stated as an instant rather than a range.
 *
 * `expiresAt === now` is expired: the stored value is when the key stops being
 * accepted, so the instant it names is already outside. A `>=` here would leave
 * one millisecond in which a key that has expired still serves, and that
 * millisecond is exactly what a test written against `Date.now()` would never
 * observe.
 */
test("expiry is exclusive at its own instant", () => {
  expect(keyUsable(key({ expiresAt: NOW - 1 }), NOW)).toBe(false);
  expect(keyUsable(key({ expiresAt: NOW }), NOW)).toBe(false);
  expect(keyUsable(key({ expiresAt: NOW + 1 }), NOW)).toBe(true);
});

/**
 * Both clauses, not either.
 *
 * A revoked key whose expiry is still ahead is the case a one-clause rewrite
 * would serve, and it is the one an operator is most likely to create: revoking
 * a key that also carried an expiry.
 */
test("revoked and unexpired is still unusable", () => {
  expect(keyUsable(key({ revokedAt: 1, expiresAt: NOW + 60_000 }), NOW)).toBe(false);
  expect(keyUsable(key({ revokedAt: 1, expiresAt: NOW - 60_000 }), NOW)).toBe(false);
});
