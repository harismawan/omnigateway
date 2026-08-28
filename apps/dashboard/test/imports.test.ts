import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  bareImportsOf,
  type ForbiddenImport,
  forbiddenImportsIn,
  sourceFiles,
} from "../../../scripts/lib/imports.ts";

const SRC = resolve(import.meta.dir, "../src");
/**
 * The test tree is walked too.
 *
 * `test/helpers/fixtures.ts` documents that its provider data is "hand-written
 * rather than imported from `@omni/providers`" — a convention with no
 * enforcement. Someone simplifying that into a real import would make the whole
 * console suite assert against the build-time provider list, which is the drift
 * this sub-project removed, and every test would still be green.
 */
const TEST = import.meta.dir;

/**
 * Boundary rule 12 as an instrument rather than prose.
 *
 * The rule says the console may import `@omni/store/types`, `@omni/ir` and
 * `@omnigateway/dashboard-sdk`, and may not reach provider adapters, the HTTP
 * client or runtime store code. Everything else it needs comes over `/api/*`.
 *
 * It had no enforcement. Removing `@omni/providers` from
 * `apps/dashboard/package.json` does **not** provide one: workspace resolution
 * finds a sibling package by name whether or not it is declared, so a console
 * file importing the catalog again typechecks, lints and passes every test —
 * verified, not assumed. That is the failure this whole sub-project exists to
 * prevent: a provider loaded from disk appears nowhere, because something went
 * back to reading a build-time list.
 *
 * A denylist rather than an allowlist, deliberately. An allowlist over every
 * bare specifier would churn on each new npm dependency and would eventually be
 * relaxed to stop failing, which is how a guard becomes decoration. The denylist
 * names exactly what rule 12 forbids.
 */
const FORBIDDEN: ReadonlyArray<ForbiddenImport> = [
  {
    pattern: /^@omni\/providers(\/|$)/,
    why: "provider data must come from /api/catalog; a build-time import cannot see a provider loaded from disk at boot",
    // **Type-only too, and this was the hole.** `Bun.Transpiler` erases type
    // imports before reporting them, so the check below enforced rule 12 only
    // at runtime while its docstring claimed it "names exactly what rule 12
    // forbids" — and rule 12 says "neither subpath, not even the leaf ones".
    // A type import of a descriptor, or of `keyof typeof PROVIDER_DESCRIPTORS`,
    // puts a build-time-closed provider set back into the console's type system
    // with no runtime bytes to give it away.
    alsoTypeOnly: true,
  },
  {
    pattern: /^@omni\/store$/,
    why: "runtime store code. `@omni/store/types` is the permitted subpath",
  },
  { pattern: /^@omni\/control(\/|$)/, why: "admin operations belong behind /api/*" },
  { pattern: /^@omni\/router(\/|$)/, why: "routing is the gateway's, not the console's" },
  { pattern: /^@omni\/rtk(\/|$)/, why: "not the console's concern" },
  { pattern: /^node:/, why: "the console runs in a browser" },
];

test("no console source file imports anything boundary 12 forbids", () => {
  const { files, violations } = forbiddenImportsIn(SRC, FORBIDDEN);
  // Proof the walk found the console rather than an empty directory — the
  // assertion below is "this list is empty", which is also what a broken
  // harness reports.
  expect(files.length).toBeGreaterThan(30);
  expect(violations).toEqual([]);
});

test("no console test file imports anything boundary 12 forbids either", () => {
  // Same rule, and the tree the original walk skipped. A fixture that reached
  // for the real provider table would make 546 tests agree with a list the
  // console must not have.
  //
  // The `node:` rule is dropped for this tree, and only that one. It says the
  // console runs in a browser, which is true of `src` and false of a suite that
  // reads fixtures off disk under Bun — applying it here would fail three
  // correct files and teach the next person to delete the walk rather than
  // narrow it. Every rule about *what the console may know* still applies.
  const { files, violations } = forbiddenImportsIn(
    TEST,
    FORBIDDEN.filter(({ pattern }) => !pattern.test("node:fs")),
  );
  expect(files.length).toBeGreaterThan(20);
  expect(violations).toEqual([]);
});

test("the permitted imports really are present, so the check above is not vacuous", () => {
  // If the scanner returned nothing at all, the denylist test would pass for the
  // wrong reason. These three are what rule 12 explicitly allows, and the console
  // does use them.
  const all = new Set(sourceFiles(SRC).flatMap((file) => bareImportsOf(file).any));
  expect(all).toContain("@omni/store/types");
  expect(all).toContain("react");
  expect([...all].some((s) => s.startsWith("@tanstack/"))).toBe(true);
});
