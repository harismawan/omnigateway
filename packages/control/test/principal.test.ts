import { expect, test } from "bun:test";
import { canMutate, type Principal, scopeKey, scopeOf } from "../src/principal.ts";

const PRINCIPALS: Principal[] = [
  { kind: "admin" },
  { kind: "viewer" },
  { kind: "client", apiKeyId: "k1" },
  { kind: "machine", tokenId: "t1", pluginId: "p1" },
];

test("only the operator may mutate", () => {
  expect(PRINCIPALS.filter(canMutate)).toEqual([{ kind: "admin" }]);
});

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
 * traffic. Scoping it to an id nothing matches fails closed instead.
 */
test("a machine principal reads nothing rather than everything", () => {
  const scope = scopeOf({ kind: "machine", tokenId: "t1", pluginId: "p1" });
  expect(scope.kind).toBe("key");
  expect(scopeKey(scope)).not.toBeUndefined();
  expect(scopeKey(scope)).toBe("");
});

/**
 * `scopeKey` is what reaches the store, and `undefined` there means "every row".
 * Only the `all` scope may produce it — a narrowed scope that returned
 * `undefined` would widen silently at the one call that matters.
 */
test("undefined reaches the store for the all scope and for nothing else", () => {
  const keys = PRINCIPALS.map((p) => scopeKey(scopeOf(p)));
  expect(keys.filter((k) => k === undefined)).toHaveLength(2);
  expect(scopeKey({ kind: "all" })).toBeUndefined();
  expect(scopeKey({ kind: "key", apiKeyId: "k1" })).toBe("k1");
});
