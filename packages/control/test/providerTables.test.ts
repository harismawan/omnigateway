import { expect, test } from "bun:test";
import * as providers from "@omni/providers";
import * as catalogSubpath from "@omni/providers/catalog";
import * as descriptorsSubpath from "@omni/providers/descriptors";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import * as control from "../src/index.ts";
import { seedBuiltinOAuth } from "../src/oauth/index.ts";

/**
 * Every table keyed by a provider id must answer `undefined` for a key it does
 * not hold, including the ones every object inherits.
 *
 * **Discovered, not listed.** A hand-written list is what failed here once
 * already: the rule was written as "every provider-keyed table", the fix and its
 * test covered the six in `@omni/providers`, and `OAUTH_PROVIDERS` in this
 * package went on leaking for another round — the same defect, the same
 * signature, in a table nobody had enumerated. A list of tables to check has
 * exactly the property the thing it is checking lacks.
 *
 * So this walks the public surface of both packages and decides for itself what
 * looks provider-keyed. A new table is covered on the day it is exported; one
 * that is renamed or moved does not fall out of scope silently.
 */

/** Provider ids, read from the registry so a seventh is in scope immediately. */
const IDS = Object.keys(PROVIDER_DESCRIPTORS);

/**
 * Keys every ordinary object answers for.
 *
 * `__proto__` is deliberately absent: on a null-prototype object it is a missing
 * key, but on a plain one it is an accessor rather than a value, so it would
 * fail for a reason unrelated to this.
 */
const INHERITED = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];

/**
 * Whether a value is a lookup table keyed by provider id.
 *
 * Two ids rather than one, because a single match is more likely to be a record
 * that merely *mentions* a provider — a fixture, a default — than a table
 * dispatched on. Two is enough to mean "keyed by provider" in practice and has
 * no false positives in this repo today.
 */
function isProviderKeyed(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = new Set(Object.keys(value));
  return IDS.filter((id) => keys.has(id)).length >= 2;
}

function tablesIn(namespace: Record<string, unknown>, label: string) {
  return Object.entries(namespace)
    .filter(([, value]) => isProviderKeyed(value))
    .map(([name, value]) => [`${label}.${name}`, value as Record<string, unknown>] as const);
}

test("every exported provider-keyed table refuses inherited keys", () => {
  // `OAUTH_PROVIDERS` is filled at boot rather than at import — the five vendor
  // flows live in `@omni/providers` now and arrive through
  // `registerOAuthProvider`. Unseeded it holds no provider id, so the walk below
  // would not recognise it as a table and the assertion that the walk *found*
  // it would be the thing that failed. Seeded here rather than left to another
  // file in the same run, because a table that is only discoverable when the
  // whole suite runs is one this test cannot claim to cover.
  seedBuiltinOAuth();

  const found = [
    ...tablesIn(providers as Record<string, unknown>, "@omni/providers"),
    ...tablesIn(descriptorsSubpath as Record<string, unknown>, "@omni/providers/descriptors"),
    ...tablesIn(catalogSubpath as Record<string, unknown>, "@omni/providers/catalog"),
    ...tablesIn(control as Record<string, unknown>, "@omni/control"),
  ];

  // The walk itself has to be shown to work. If a refactor stops exporting these
  // tables, the loop below passes over an empty list and reports nothing — which
  // is indistinguishable from a clean run.
  const names = found.map(([name]) => name);
  expect(names.length).toBeGreaterThanOrEqual(6);
  expect(names.some((n) => n.endsWith("PROVIDER_DESCRIPTORS"))).toBe(true);
  expect(names.some((n) => n.endsWith("OAUTH_PROVIDERS"))).toBe(true);

  for (const [name, table] of found) {
    for (const key of INHERITED) {
      expect({ table: name, key, value: table[key] }).toEqual({
        table: name,
        key,
        value: undefined,
      });
    }
  }
});
