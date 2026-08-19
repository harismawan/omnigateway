import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_IMPORTS, sharedEntryName } from "../shared/manifest.ts";

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

test("the map covers exactly the packages a plugin may not bundle its own copy of", () => {
  // React and react-dom must be one instance across the console and every
  // plugin or hooks throw "invalid hook call". styled-components must be one or
  // the two halves render with different stylesheets. Adding a package here is
  // a deliberate widening of the federation contract.
  expect(Object.keys(SHARED_IMPORTS).sort()).toEqual([
    "@tanstack/react-query",
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "styled-components",
  ]);
});
