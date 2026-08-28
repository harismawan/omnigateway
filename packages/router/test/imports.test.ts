/**
 * Boundary rules 3 and 9, from the router's side.
 *
 * Rule 9 was rewritten this branch and now rests on this package: the catalog and
 * descriptor subpaths must stay leaves "because pure `packages/router` import
 * `descriptors`, and leaf property is what let it".
 * `packages/providers/test/leafSubpaths.test.ts` is cited as the pin — and it
 * proves the *leaves are leaves*. It says nothing about what the router imports.
 *
 * Nothing did. `packages/providers/package.json` exports `"."`, and the router
 * declares `@omni/providers` as an ordinary workspace dependency, so a router
 * file writing `import { PROVIDERS } from "@omni/providers"` typechecks, lints
 * and passes every test while dragging `node:http` and the HTTP client into the
 * package whose whole contract is that it has no I/O. The console has had this
 * instrument since rule 12 was written; the package rule 9 now names as its
 * beneficiary had none.
 *
 * A denylist, like the console's, and for the same reason: an allowlist over
 * every specifier churns on each dependency and gets relaxed until it stops
 * failing.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ForbiddenImport, forbiddenImportsIn } from "../../../scripts/lib/imports.ts";

const SRC = resolve(import.meta.dir, "../src");

const FORBIDDEN: ReadonlyArray<ForbiddenImport> = [
  {
    // The package root, not the subpaths. `@omni/providers/catalog` and
    // `/descriptors` are what rule 9 keeps leaves precisely so this package may
    // read them; the root is the barrel that pulls in adapters and `http.ts`.
    pattern: /^@omni\/providers$/,
    why: "the package root reaches adapters and the HTTP client; import the catalog or descriptors subpath",
    // Type-only too: rule 9's point is that no build-time import may decide the
    // provider set, and a type import of the barrel does that silently.
    alsoTypeOnly: true,
  },
  {
    // Value imports only. Every package-root import of `@omni/store` in this
    // package is `import type` and erased at build, which is the arrangement
    // rule 3 tolerates and `README.md` describes as the router's dotted edge.
    // Banning type-only here would fail four files that are correct today.
    pattern: /^@omni\/store$/,
    why: "runtime store code, and rule 3 says the router touches no database. `@omni/store/types` is the permitted subpath",
  },
  { pattern: /^@omni\/control(\/|$)/, why: "control owns side effects; the router is pure" },
  {
    pattern: /^node:/,
    why: "rule 3: no transport, no filesystem, no timers. An injected clock is a parameter, not an import",
  },
  { pattern: /^bun$/, why: "rule 1 and 3: no runtime, no `Bun.env`, no I/O" },
];

test("no router source file imports anything rules 3 and 9 forbid", () => {
  const { files, violations } = forbiddenImportsIn(SRC, FORBIDDEN);
  // The walk found the router rather than an empty directory: the assertion
  // below is "this list is empty", which is also what a broken harness reports.
  expect(files.length).toBeGreaterThan(5);
  expect(violations).toEqual([]);
});

test("the permitted subpaths really are imported, so the check above is not vacuous", () => {
  // A denylist passes when nothing is scanned at all. These two are the imports
  // rule 9's rewritten justification is *about*, so their presence is what makes
  // the test above mean something — and if they ever go away, the rule needs
  // rewriting rather than this test deleting.
  const { violations } = forbiddenImportsIn(SRC, [
    { pattern: /^@omni\/providers\/descriptors$/, why: "present" },
    { pattern: /^@omni\/providers\/catalog$/, why: "present" },
  ]);
  expect(violations.some((line) => line.includes("@omni/providers/descriptors"))).toBe(true);
  expect(violations.some((line) => line.includes("@omni/providers/catalog"))).toBe(true);
});

test("a type-only import of the package root would be caught", () => {
  // The console's copy of this instrument could not see one: `Bun.Transpiler`
  // erases type-only imports before reporting them, so its guard enforced rule
  // 12 at runtime only. A type import of the barrel is still a build-time
  // dependency on a closed provider set, which is the thing rule 9 prevents.
  //
  // Scanned from a real file rather than asserted against a regex literal: the
  // property under test is what `forbiddenImportsIn` does with a source, and a
  // test that re-implements the match would pass while the scanner ignored it.
  const dir = mkdtempSync(join(tmpdir(), "omni-router-imports-"));
  try {
    writeFileSync(
      join(dir, "leaky.ts"),
      'import type { ProviderDescriptor } from "@omni/providers";\nexport type A = ProviderDescriptor;\n',
    );
    const { violations } = forbiddenImportsIn(dir, FORBIDDEN);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("@omni/providers");

    // And the paired negative, so this is not simply "everything fails": the
    // same type-only shape against `@omni/store` is the arrangement rule 3
    // documents, and must stay silent.
    writeFileSync(
      join(dir, "leaky.ts"),
      'import type { Target } from "@omni/store";\nexport type B = Target;\n',
    );
    expect(forbiddenImportsIn(dir, FORBIDDEN).violations).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
