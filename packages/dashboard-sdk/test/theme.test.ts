import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CSS_VARIABLES } from "../src/index.ts";

const globalStylePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "dashboard",
  "src",
  "theme",
  "GlobalStyle.ts",
);

/**
 * The custom properties declared inside one selector block of `GlobalStyle.ts`.
 *
 * Read from the source rather than from a rendered document because the point
 * is the contract, not the computed value: this test has to fail when the
 * palette changes, in the core suite, without a DOM.
 */
function declaredIn(selector: string): string[] {
  const source = readFileSync(globalStylePath, "utf8");
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  }", start);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string).sort();
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
