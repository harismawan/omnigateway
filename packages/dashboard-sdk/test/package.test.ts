import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readPackageJson(): PackageJson {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("package.json is not object");
  return parsed as PackageJson;
}

/**
 * The packages the console owns, which this one must therefore peer-depend on.
 *
 * `apps/dashboard/shared/manifest.ts` is the host half of this declaration, and
 * the two lists are no longer identical: the console also externalises
 * `react/jsx-runtime`, `react-dom/client` and `@omnigateway/dashboard-sdk`. The
 * subpaths are not separate packages, so they have no peer entry of their own —
 * and this package cannot peer-depend on itself, which is exactly why the SDK
 * being shared is a rule this file cannot enforce and the README has to state.
 */
const HOST_OWNED = ["react", "react-dom", "styled-components", "@tanstack/react-query"];

test("the host-owned packages are peer dependencies", () => {
  const peers = readPackageJson().peerDependencies ?? {};
  for (const name of HOST_OWNED) {
    expect(Object.keys(peers)).toContain(name);
  }
});

test("no host-owned package is a dependency or a devDependency", () => {
  // This is the failure the whole federation design exists to prevent, and it
  // is one character in a JSON file. A plugin that resolves its own React ends
  // up with two React instances on one page and every hook in it throws
  // "invalid hook call" — an error that points at the plugin's components and
  // never at the duplicated dependency. Moving a name out of `peerDependencies`
  // is what does it, and nothing else in the suite would notice.
  const pkg = readPackageJson();
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  for (const name of HOST_OWNED) {
    expect(deps).not.toContain(name);
    expect(devDeps).not.toContain(name);
  }
});

/**
 * The one module allowed to import React for its value, and why it is one.
 *
 * This package imported React only as types until `live.ts`, on the reasoning
 * that the SDK is every plugin's one dependency and so the worst place to be
 * wrong about which React instance is in use. Holding a context means holding a
 * hook, so that had to give — and what makes it safe is not this list but
 * `apps/dashboard/shared/manifest.ts`, which serves one copy of this package to
 * the console and every panel alike.
 *
 * The list stays at one on purpose. A second module reaching for React is a
 * second reason to be federated, and the moment there are two the first one
 * stops being examined.
 */
const RUNTIME_REACT = new Set(["live.ts"]);

/**
 * Every way a source file can end up holding a runtime binding from a package.
 *
 * Four forms, and the first version of this only saw one of them. `^import …
 * from` missed all of:
 *
 * - `export { useState } from "react"` — a real runtime binding, and one that
 *   `files: ["src"]` publishes to every plugin that installs this package.
 * - `import "react-dom"` — no names, still evaluates the module.
 * - `require("react")` — not ESM, still a resolution.
 * - single quotes, which Biome happens to rewrite but which a regex should not
 *   depend on Biome for.
 *
 * Reported rather than silently skipped: a form this cannot classify is a form
 * whose safety nobody has established.
 */
function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];

  // `import`/`export` with a `from` clause. The leading keyword decides nothing
  // about runtime-ness; `type` does, and only `import type`/`export type` erase.
  for (const match of source.matchAll(
    /^(import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/gm,
  )) {
    found.push({ specifier: match[3] ?? "", typeOnly: (match[2] ?? "").startsWith("type ") });
  }
  // Side-effect imports: no bindings, but the module is evaluated, which for
  // React is exactly the instance question this rule is about.
  for (const match of source.matchAll(/^import\s*["']([^"']+)["']/gm)) {
    found.push({ specifier: match[1] ?? "", typeOnly: false });
  }
  // CommonJS. This package is ESM, so any hit is a mistake worth naming.
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.push({ specifier: match[1] ?? "", typeOnly: false });
  }

  return found;
}

test("only the live module imports a host-owned package for its value", () => {
  // Read off disk rather than from a hard-coded file list, which is what this
  // test used to do: a new module was simply not looked at, so the rule held
  // for exactly the four files someone had thought of. The scan spans lines for
  // the same reason — `live.ts` imports seven names from React across eight
  // lines, and a check that only read the first would see `import {` and pass.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  // `.tsx` as well as `.ts`, and that is not hypothetical tidiness: this rule
  // was written the same afternoon a stray `live.tsx` sat beside `live.ts` for
  // an hour. `"live.tsx".endsWith(".ts")` is false, so a scan for `.ts` alone
  // looked straight past a second module holding a second `createContext` — the
  // exact duplicate this package is federated to prevent — and `files: ["src"]`
  // would have published it.
  const sources = readdirSync(dir).filter((file) => /\.tsx?$/.test(file));
  expect(sources.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const file of sources) {
    for (const { specifier, typeOnly } of importsOf(readFileSync(join(dir, file), "utf8"))) {
      // Exact name or a subpath of it — `react/jsx-runtime` counts, and a
      // future `react-router` does not. A `\b` here would match both, because
      // a word boundary sits between `t` and `-`.
      if (!HOST_OWNED.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
        continue;
      }
      if (typeOnly) continue;
      if (RUNTIME_REACT.has(file)) continue;
      offenders.push(`${file} imports ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the module named as the exception actually is one", () => {
  // The list rots in the other direction too. If `live.ts` stopped importing
  // React — folded into another module, rewritten without a context — the entry
  // would outlive the reason for it, and the next reader could not tell a live
  // decision from a fossil. Same argument as the withheld-React-keys list in
  // the console's federation test.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  // Asserted before the loop, because an empty set makes the loop vacuous and
  // this test green — while the test above *also* goes green, since with no
  // exceptions there is nothing to except. Emptying the set would otherwise
  // remove both halves of the rule at once and look like a passing suite.
  expect(RUNTIME_REACT.size).toBeGreaterThan(0);
  for (const file of RUNTIME_REACT) {
    const imports = importsOf(readFileSync(join(dir, file), "utf8"));
    expect(imports.some((i) => i.specifier === "react" && !i.typeOnly)).toBe(true);
  }
});
