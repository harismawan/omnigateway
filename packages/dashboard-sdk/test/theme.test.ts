import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_VARIABLES } from "../src/index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const globalStylePath = join(repoRoot, "apps", "dashboard", "src", "theme", "GlobalStyle.ts");
const descriptorsPath = join(repoRoot, "packages", "providers", "src", "descriptors.ts");

/**
 * The provider ids, read out of the descriptor registry's source.
 *
 * Read rather than imported on purpose. `@omni/providers` is a core package and
 * this one is published, so an ordinary `import` here would put an unresolvable
 * `workspace:*` into a stranger's dependency tree — it would typecheck and pass
 * inside this repo, which is exactly how that mistake goes unnoticed. Reading
 * the file also matches what the rest of this test does: it asserts about the
 * source of the contract, never about a computed value.
 */
function providerIds(): string[] {
  const source = readFileSync(descriptorsPath, "utf8");
  const start = source.indexOf("export const PROVIDER_DESCRIPTORS");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  expect(end).toBeGreaterThan(start);
  const ids = [...source.slice(start, end).matchAll(/^ {2}([a-z0-9]+):/gm)].map(
    (m) => m[1] as string,
  );
  // A registry that parsed to nothing would make every `--p-*` expectation
  // below vacuously satisfied, which is the same shape as a passing run.
  expect(ids.length).toBeGreaterThan(0);
  return ids;
}

/**
 * The custom properties declared inside one selector block of `GlobalStyle.ts`.
 *
 * Read from the source rather than from a rendered document because the point
 * is the contract, not the computed value: this test has to fail when the
 * palette changes, in the core suite, without a DOM.
 *
 * The `--p-<id>` half of each block is written by `providerPalette(…)` from the
 * provider registry, so it is expanded here rather than matched literally. That
 * is what keeps this test's job intact after the console stopped hand-writing
 * those lines: adding a provider still has to add a name to `CSS_VARIABLES`.
 */
function declaredIn(selector: string): string[] {
  const source = readFileSync(globalStylePath, "utf8");
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const literal = [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string);
  const generated = block.includes("providerPalette(")
    ? providerIds().map((id) => `--p-${id}`)
    : [];
  return [...literal, ...generated].sort();
}

test("every exported name is a CSS custom property", () => {
  for (const name of CSS_VARIABLES) {
    expect(name.startsWith("--")).toBe(true);
  }
});

test("the exported list is exactly the console's palette", () => {
  // Both directions, because both drifts are silent. A name listed here that
  // the console does not define hands a plugin author a `var()` resolving to
  // nothing; a name the console defines and this omits leaves them guessing at
  // a variable that exists. Neither shows up until someone loads the page.
  //
  // If this fails after a palette change, the fix is to update CSS_VARIABLES in
  // the same commit — that is what the test is for.
  const exported: string[] = [...CSS_VARIABLES];
  expect(exported.sort()).toEqual(declaredIn(":root"));
});

test("the dark mode block redefines every palette variable", () => {
  // `.dark` on <html> is the single switch. A palette variable defined only in
  // `:root` keeps its light value in dark mode, which is invisible to every
  // test that renders in one mode and is exactly the bug a plugin author cannot
  // debug from inside their own bundle.
  expect(declaredIn(".dark")).toEqual(declaredIn(":root"));
});

test("the list has no duplicates", () => {
  expect(new Set(CSS_VARIABLES).size).toBe(CSS_VARIABLES.length);
});
