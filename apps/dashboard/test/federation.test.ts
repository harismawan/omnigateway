import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@omnigateway/dashboard-sdk";
import React from "react";
import * as sdkShim from "../shared/dashboard-sdk.ts";
import { SHARED_IMPORTS, sharedEntryName } from "../shared/manifest.ts";
import * as reactShim from "../shared/react.ts";

const sharedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shared");

/** Packages that ship CommonJS, where `export *` yields a module with no named exports. */
const COMMONJS = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];

test("every shared specifier has an entry module to build", () => {
  // A specifier in the map with no file behind it builds cleanly and 404s at
  // boot, because nothing in the build ever looks for it.
  for (const url of Object.values(SHARED_IMPORTS)) {
    const entry = join(sharedDir, `${sharedEntryName(url)}.ts`);
    expect(() => readFileSync(entry, "utf8")).not.toThrow();
  }
});

test("every entry module is reachable from the map", () => {
  // The reverse direction: an orphan shim is dead weight that looks load-bearing
  // and quietly stops being built the day someone renames its specifier.
  const mapped = new Set(Object.values(SHARED_IMPORTS).map(sharedEntryName));
  const onDisk = readdirSync(sharedDir)
    .filter((f) => f.endsWith(".ts") && f !== "manifest.ts")
    .map((f) => f.slice(0, -3));
  expect(onDisk.sort()).toEqual([...mapped].sort());
});

test("a CommonJS package is re-exported by destructuring, never by `export *`", () => {
  // This is the trap, and it is silent. React ships CommonJS, so a bundler
  // cannot enumerate its named exports statically: `export * from "react"`
  // compiles without a warning into a module whose only export is `default`.
  // Every `import { useState } from "react"` in the console and in every plugin
  // then fails at runtime, and nothing in the build points here.
  for (const specifier of COMMONJS) {
    const url = SHARED_IMPORTS[specifier as keyof typeof SHARED_IMPORTS];
    const source = readFileSync(join(sharedDir, `${sharedEntryName(url)}.ts`), "utf8");
    // Statements only. These files document the trap in prose, so a naive
    // substring search matches the comment warning against it.
    const statements = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("*") && !line.startsWith("/"));

    expect(statements.some((line) => line.startsWith("export *"))).toBe(false);
    expect(statements.some((line) => line.startsWith("export const {"))).toBe(true);
  }
});

/**
 * React keys `shared/react.ts` deliberately does not re-export.
 *
 * Named one at a time, with a reason each, rather than matched by a pattern.
 * Every exclusion here is `__`-prefixed or `unstable_`-prefixed or otherwise
 * shouts "internal" — but "it looked internal" is exactly the judgement this
 * test exists to stop anyone making at a glance, and a predicate would let the
 * next such key through without anyone deciding anything. React adding a key,
 * of any shape, should cost one line and one thought.
 */
const NOT_RE_EXPORTED: ReadonlyArray<readonly [string, string]> = [
  [
    "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
    "React's private dispatcher. Shared through the single React instance the whole point of this shim is to preserve, never through an import.",
  ],
  [
    "__COMPILER_RUNTIME",
    "The React Compiler's own runtime, resolved by compiled output rather than written by hand.",
  ],
  [
    "act",
    "A test utility. It is not in `@types/react`'s public surface either, so federating it would not even typecheck, and a plugin's tests do not run through the federation boundary.",
  ],
  [
    "unstable_useCacheRefresh",
    "The `unstable_` prefix is React's own statement that it carries no compatibility promise; this boundary is versioned and cannot re-export something that is not.",
  ],
];

test("the React shim re-exports every public React export", () => {
  // The silent failure this catches: React ships a new export, the hand-written
  // list in `shared/react.ts` does not gain it, and a plugin importing it gets
  // `undefined` at runtime with nothing failing at build time. Same class as the
  // `export *` trap above, arriving by upgrade instead of by authorship.
  const held = new Set(NOT_RE_EXPORTED.map(([name]) => name));

  // Read off the module namespace rather than parsed out of the file, so the
  // test measures what the shim actually exports rather than what its source
  // looks like. `default` is the whole namespace object and is not a React key.
  const exported = new Set(Object.keys(reactShim));
  exported.delete("default");

  const expected = Object.keys(React).filter((name) => !held.has(name));

  // Compared both ways by a single equality. A missing name is the upgrade case;
  // an extra name is the reverse — React removed or renamed an export and the
  // shim is now re-exporting `undefined` under a name plugins still import.
  expect([...exported].sort()).toEqual(expected.sort());
});

test("the SDK shim re-exports the whole SDK", () => {
  // The React shim above is checked this way because a missing name is
  // `undefined` at runtime with nothing failing at build time. The SDK shim has
  // the same hole and a worse landing: the console imports `useLive` as a *bare
  // specifier*, so a shim that stops exporting it is not `undefined` — it is a
  // module that does not provide the requested binding, which is a load-time
  // SyntaxError and a console that never boots.
  //
  // This is not hypothetical. Reducing `shared/dashboard-sdk.ts` to a single
  // named re-export left the whole suite green, including the real-build test,
  // while the emitted entry shipped `export{i as pluginApiPath}` and the
  // console chunks went on importing `useLive` from it.
  //
  // A superset rather than an equality: the shim is `export *`, so it cannot
  // add names, and pinning it to an exact list would make every new SDK export
  // fail here instead of where it was added.
  const exported = new Set(Object.keys(sdkShim));
  for (const name of Object.keys(sdk)) {
    expect(exported).toContain(name);
  }
  // Guards the loop: an SDK that exported nothing would satisfy it vacuously,
  // and `export *` of an empty module is exactly what a bad refactor leaves.
  expect(Object.keys(sdk).length).toBeGreaterThan(0);
  expect(Object.keys(sdk)).toContain("useLive");
});

test("every deliberately withheld React key is still a React key", () => {
  // The exclusion list rots in the other direction too: React drops a key, the
  // entry outlives it, and the reason for it becomes unfalsifiable — the next
  // reader cannot tell a live decision from a fossil. `captureOwnerStack` is the
  // near miss to keep in mind: it is re-exported, and it is development-only, so
  // it is present here and absent from a production build. That asymmetry is
  // React's, and it is faithfully reproduced rather than papered over.
  for (const [name, reason] of NOT_RE_EXPORTED) {
    expect(reason.length).toBeGreaterThan(0);
    expect(Object.keys(React)).toContain(name);
  }
});

test("the map covers exactly the packages a plugin may not bundle its own copy of", () => {
  // React and react-dom must be one instance across the console and every
  // plugin or hooks throw "invalid hook call". styled-components must be one or
  // the two halves render with different stylesheets. Adding a package here is
  // a deliberate widening of the federation contract.
  //
  // `@omnigateway/dashboard-sdk` is here for a different reason than the rest,
  // and the difference is why it is worth a sentence. The others are about
  // instance identity, and every one of them announces a breach: a thrown hook
  // error, a component rendered from the wrong stylesheet. The SDK holds
  // `LiveContext`, so a duplicate is a duplicate *context object* — a panel
  // reading it finds no provider, takes the "polling is off" default, and never
  // polls again. Nothing throws. Nothing logs. The only symptom is a screen
  // that quietly stops updating, which is also what a working pause looks like.
  expect(Object.keys(SHARED_IMPORTS).sort()).toEqual([
    "@omnigateway/dashboard-sdk",
    "@tanstack/react-query",
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "styled-components",
  ]);
});
