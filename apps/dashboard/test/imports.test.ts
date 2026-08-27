import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

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
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^@omni\/providers(\/|$)/,
    why: "provider data must come from /api/catalog; a build-time import cannot see a provider loaded from disk at boot",
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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Bare specifiers only; a relative path cannot leave the package. */
function bareImportsOf(file: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .map((record) => record.path)
    .filter((path) => !path.startsWith("."));
}

test("no console source file imports anything boundary 12 forbids", () => {
  const files = sourceFiles(SRC);
  // Proof the walk found the console rather than an empty directory — the
  // assertion below is "this list is empty", which is also what a broken
  // harness reports.
  expect(files.length).toBeGreaterThan(30);

  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of bareImportsOf(file)) {
      const rule = FORBIDDEN.find(({ pattern }) => pattern.test(specifier));
      if (rule !== undefined) {
        violations.push(`${relative(SRC, file)} imports ${specifier} — ${rule.why}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test("the permitted imports really are present, so the check above is not vacuous", () => {
  // If the scanner returned nothing at all, the denylist test would pass for the
  // wrong reason. These three are what rule 12 explicitly allows, and the console
  // does use them.
  const all = new Set(sourceFiles(SRC).flatMap(bareImportsOf));
  expect(all).toContain("@omni/store/types");
  expect(all).toContain("react");
  expect([...all].some((s) => s.startsWith("@tanstack/"))).toBe(true);
});
