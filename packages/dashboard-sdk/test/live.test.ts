import { expect, test } from "bun:test";
import * as sdk from "../src/index.ts";
import { type Cadence, LiveProvider, useLive } from "../src/live.ts";

/**
 * What this file can and cannot check, stated because the gap is deliberate.
 *
 * `LiveProvider` and `useLive` need a renderer, and registering happy-dom
 * mutates process-wide globals — which is why the root `bun test` excludes the
 * dashboard suite in the first place. So the behavioural test (pausing turns a
 * cadence into `false`) lives in `apps/dashboard/test/session/live.test.tsx`,
 * against the console's own re-export, where a DOM already exists.
 *
 * That left `bun test` with no coverage of this module at all: deleting
 * `useLive` from the SDK's exports, or breaking `cadence` outright, kept the
 * root suite at full green. What follows is the part that needs no DOM: the
 * export surface. It is not much, and it is the difference between a
 * contributor editing `packages/` getting a failure and getting silence.
 *
 * It does not cover `cadence`'s behaviour, and that gap is real rather than
 * hidden — breaking `cadence` still passes here and fails in the dashboard
 * suite, which `bun run test:all` and CI both run.
 */

test("the package exports the switch by the names the console imports", () => {
  // The console and every plugin import these by name through the import map,
  // where a missing binding is a load-time SyntaxError rather than an
  // `undefined` — so a rename here breaks the console at boot, not at use.
  for (const name of ["useLive", "LiveProvider"]) {
    expect(Object.keys(sdk)).toContain(name);
  }
  expect(typeof sdk.useLive).toBe("function");
  expect(typeof sdk.LiveProvider).toBe("function");
});

test("the index re-export is the module's own binding", () => {
  // Not a copy and not a wrapper. A wrapper here would be a second identity for
  // the provider, which is the same class of failure as a second context.
  expect(sdk.useLive).toBe(useLive);
  expect(sdk.LiveProvider).toBe(LiveProvider);
});

test("`Cadence` says what a paused query is, and it is not zero", () => {
  // A type-level pin rather than a call. `useLive()` cannot be invoked here:
  // `use()` resolves React's dispatcher, which only exists mid-render, so
  // calling it outside a component throws "null is not an object" rather than
  // taking the no-provider fallback. That fallback is exercised in the
  // dashboard suite, where there is a renderer.
  //
  // What is worth stating without one is that `false` — not `0` — is the
  // paused value. react-query reads `refetchInterval: 0` as "as fast as
  // possible", so the difference between the two is a paused console and a
  // console hammering the gateway.
  const paused: Cadence = false;
  const polling: Cadence = 10_000;
  expect(paused).toBe(false);
  expect(polling).toBe(10_000);
});
