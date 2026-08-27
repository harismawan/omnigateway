import { expect, test } from "bun:test";
import type { Principal } from "../src/principal.ts";
import { scopeKey, scopeOf } from "../src/principal.ts";

const PRINCIPALS: Principal[] = [
  { kind: "admin" },
  { kind: "viewer" },
  { kind: "client", apiKeyId: "k1" },
  { kind: "machine", tokenId: "t1", pluginId: "p1" },
];

test("admin and viewer read everything, a client reads its own key", () => {
  expect(scopeOf({ kind: "admin" })).toEqual({ kind: "all" });
  expect(scopeOf({ kind: "viewer" })).toEqual({ kind: "all" });
  expect(scopeOf({ kind: "client", apiKeyId: "k1" })).toEqual({ kind: "key", apiKeyId: "k1" });
});

test("a client scope carries its own key and never another", () => {
  expect(scopeKey(scopeOf({ kind: "client", apiKeyId: "k1" }))).toBe("k1");
  expect(scopeKey(scopeOf({ kind: "client", apiKeyId: "k2" }))).toBe("k2");
});

/**
 * The machine arm is unreachable today, which is exactly why this is asserted.
 *
 * A `default:` returning `all` would be invisible until the remote-control
 * plugin's token table lands, and then it would hand a plugin token every key's
 * traffic.
 */
test("a machine principal reads nothing rather than everything", () => {
  expect(scopeOf({ kind: "machine", tokenId: "t1", pluginId: "p1" })).toEqual({ kind: "none" });
});

/**
 * The empty string is not "matches nothing", and an earlier version of this
 * file asserted that it was.
 *
 * `usage_daily.api_key_id` is `NOT NULL DEFAULT ''`, so anonymous traffic is
 * stored under the empty string. A scope of `{ kind: "key", apiKeyId: "" }`
 * therefore reads every untagged row at the daily grain while reading, in the
 * source, exactly like a scope that matches nothing. `NONE` is its own arm so
 * that mistake cannot be made again.
 */
test("an empty key id never becomes a key scope", () => {
  expect(scopeOf({ kind: "client", apiKeyId: "" })).toEqual({ kind: "none" });
  for (const principal of PRINCIPALS) {
    const scope = scopeOf(principal);
    if (scope.kind === "key") expect(scope.apiKeyId).not.toBe("");
  }
});

/**
 * `scopeKey` is what reaches the store, and `undefined` there means "every row".
 *
 * Both `all` and `none` produce it, and they mean opposite things — so a caller
 * must check for `none` first. That is why `queryUsage` and `recentLogs` are
 * the only readers, and why this asserts the shape rather than trusting it.
 */
test("only a key scope yields a key, and none is not a key", () => {
  expect(scopeKey({ kind: "all" })).toBeUndefined();
  expect(scopeKey({ kind: "none" })).toBeUndefined();
  expect(scopeKey({ kind: "key", apiKeyId: "k1" })).toBe("k1");
});
