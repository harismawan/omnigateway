/**
 * The plugin API's limit vocabulary, pinned to the rate limiter's.
 *
 * `@omnigateway/plugin-api` declares `DIMENSIONS`, `WINDOWS` and `WINDOW_MS`
 * itself instead of importing `@omni/ratelimit/catalog`. It has to: that package
 * is internal, so importing it would put `workspace:*` into the dependencies of
 * a package strangers install, and it would also drag zod into every plugin's
 * server bundle. The copy is deliberate. This file is what keeps it honest.
 *
 * It lives in `apps/gateway` because this is the only place that may import both
 * — the plugin API is a leaf by design and the rate limiter is core, so neither
 * can reach the other, and a test inside either one could only assert against
 * itself.
 *
 * Direction matters. The rate limiter is the source of truth: `DIMENSIONS` and
 * `WINDOWS` are the JSON keys of `api_keys.limits`, and a stored row outlives
 * any contract. So a failure here means the plugin API's mirror is stale, and
 * the fix is to update the mirror — never to edit the rate limiter to match it.
 *
 * A drift in the *names* would already break the build at the emit site, where
 * the gateway assigns its `Window` into `LimitReached.window`. That covers a
 * window being added or removed. It does not cover `WINDOW_MS` values drifting,
 * which no type can see, so that is the assertion doing real work here.
 */

import { describe, expect, test } from "bun:test";
import {
  DIMENSIONS as CATALOG_DIMENSIONS,
  WINDOW_MS as CATALOG_WINDOW_MS,
  WINDOWS as CATALOG_WINDOWS,
} from "@omni/ratelimit/catalog";
import {
  DIMENSIONS as PLUGIN_DIMENSIONS,
  WINDOW_MS as PLUGIN_WINDOW_MS,
  WINDOWS as PLUGIN_WINDOWS,
} from "@omnigateway/plugin-api/events";

describe("the plugin API mirrors the rate limiter's limit vocabulary", () => {
  test("names the same dimensions, in the same order", () => {
    // Order is asserted, not just membership. These are a persisted contract and
    // the arrays are the documented listing order; a reordering is the kind of
    // diff that reads as cosmetic and is not.
    expect([...PLUGIN_DIMENSIONS]).toEqual([...CATALOG_DIMENSIONS]);
  });

  test("names the same windows, in the same order", () => {
    expect([...PLUGIN_WINDOWS]).toEqual([...CATALOG_WINDOWS]);
  });

  test("gives every window the same duration", () => {
    // The assertion the types cannot make. A `5h` that means four hours in one
    // package and five in the other compiles perfectly and silently pays a
    // plugin on the wrong schedule.
    expect(PLUGIN_WINDOW_MS).toEqual(CATALOG_WINDOW_MS);
  });

  test("covers every window it names, so neither table is a subset", () => {
    // Guards the case `toEqual` alone would miss if both tables were pruned
    // together: a window present in the union with no duration behind it.
    expect(Object.keys(PLUGIN_WINDOW_MS).sort()).toEqual([...PLUGIN_WINDOWS].sort());
    expect(Object.keys(CATALOG_WINDOW_MS).sort()).toEqual([...CATALOG_WINDOWS].sort());
  });
});
