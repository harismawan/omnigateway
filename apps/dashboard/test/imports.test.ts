import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { sourceFiles } from "./helpers/sourceFiles.ts";

type ForbiddenImport = {
  /** Matched against the specifier, or for a relative one its repo-relative target. */
  pattern: RegExp;
  /** Printed on a violation; says what the rule protects, not that it exists. */
  why: string;
};

const REPO = resolve(import.meta.dir, "../../..");

/**
 * Every specifier `file` imports, **type-only ones included**, with relative
 * ones resolved to a repo-relative path.
 *
 * Two passes. `Bun.Transpiler` erases type-only imports before reporting them,
 * so a regex over `from "…"` is unioned in. A specifier appearing in a comment
 * or string is at worst a false positive — a loud failure — never a silent pass.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
  const parsed = transpiler.scanImports(source).map((record) => record.path);
  const textual = [...source.matchAll(/from\s*["']([^"']+)["']/g)].map(([, path]) => path ?? "");
  return [
    ...new Set(
      [...parsed, ...textual]
        .filter((path) => path !== "")
        .map((path) =>
          path.startsWith(".") ? relative(REPO, resolve(dirname(file), path)) : path,
        ),
    ),
  ];
}

/** `dir`'s violations of `rules`, as printable lines, plus what was walked. */
function forbiddenImportsIn(
  dir: string,
  rules: readonly ForbiddenImport[],
): { files: string[]; violations: string[] } {
  const files = sourceFiles(dir);
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of importsOf(file)) {
      for (const rule of rules) {
        if (rule.pattern.test(specifier)) {
          violations.push(`${file.slice(dir.length + 1)} imports ${specifier} — ${rule.why}`);
        }
      }
    }
  }
  return { files, violations };
}

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
 * The console stands alone.
 *
 * It talks to the gateway over `/api/*` and nothing else. The gateway is the
 * Rust one in `crates/`, so there is no TypeScript package left the console
 * could legitimately import: every `@omni/*` and `@omnigateway/*` specifier is
 * forbidden, type-only imports included, because a type import of a deleted
 * package is a build that fails the day it is deleted.
 *
 * Workspace resolution finds a sibling package by name whether or not it is
 * declared, so dropping a dependency from `package.json` does not by itself
 * stop an import from resolving — this walk is the guard.
 *
 * A denylist rather than an allowlist, deliberately. An allowlist over every
 * bare specifier would churn on each new npm dependency and would eventually be
 * relaxed to stop failing, which is how a guard becomes decoration.
 */
const FORBIDDEN: ReadonlyArray<ForbiddenImport> = [
  {
    pattern: /^@omni\//,
    why: "the console reaches the gateway over /api/* only; no @omni package is its to import",
  },
  {
    pattern: /^@omnigateway\//,
    why: "the plugin SDK and plugin API are gone; the console carries its own LIVE switch",
  },
  {
    pattern: /^(packages|apps\/gateway|apps\/cli|scripts)\//,
    why: "a relative reach out of the console into code it must not depend on",
  },
  { pattern: /^node:/, why: "the console runs in a browser" },
];

test("no console source file imports a gateway package", () => {
  const { files, violations } = forbiddenImportsIn(SRC, FORBIDDEN);
  // Proof the walk found the console rather than an empty directory — the
  // assertion below is "this list is empty", which is also what a broken
  // harness reports.
  expect(files.length).toBeGreaterThan(30);
  expect(violations).toEqual([]);
});

test("no console test file imports a gateway package either", () => {
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

test("no console tooling file imports a gateway package either", () => {
  // The build, dev server and watcher run under Bun, so `node:` is theirs; the
  // rest holds, because a tooling import of a deleted package breaks the build.
  const { files, violations } = forbiddenImportsIn(
    resolve(import.meta.dir, "../tooling"),
    FORBIDDEN.filter(({ pattern }) => !pattern.test("node:fs")),
  );
  expect(files.length).toBeGreaterThan(2);
  expect(violations).toEqual([]);
});

test("a reach into the deleted tree is caught, so the rules above are not vacuous", () => {
  // The relative rule matches a *resolved* path, which is easy to get wrong in
  // a way that passes every file: assert each rule bites on the spelling it
  // exists for.
  const hits = (specifier: string) => FORBIDDEN.filter(({ pattern }) => pattern.test(specifier));
  expect(hits("@omni/store/types")).toHaveLength(1);
  expect(hits("@omnigateway/dashboard-sdk")).toHaveLength(1);
  expect(hits(relative(REPO, resolve(SRC, "../../../packages/ir/src/index.ts")))).toHaveLength(1);
  expect(hits(relative(REPO, resolve(SRC, "../../gateway/src/app.ts")))).toHaveLength(1);
  expect(hits(relative(REPO, resolve(SRC, "./api/types.ts")))).toHaveLength(0);
});

test("the permitted imports really are present, so the check above is not vacuous", () => {
  // If the scanner returned nothing at all, the denylist test would pass for the
  // wrong reason. These are imports the console does make.
  const all = new Set(sourceFiles(SRC).flatMap(importsOf));
  expect(all).toContain("react");
  expect(all).toContain("styled-components");
  expect([...all].some((s) => s.startsWith("@tanstack/"))).toBe(true);
});
