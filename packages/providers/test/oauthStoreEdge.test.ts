import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

/**
 * This package may reach `@omni/store` for **types and nothing else**.
 *
 * The OAuth migration put the flow contract here — `oauthFlow.ts` names
 * `CredentialSecrets`, `UsageSecrets` and `WindowType` — which is what made
 * `@omni/store` a dependency of a package that previously had only
 * `@omni/ir`. A type-only edge is erased at compile time and costs nothing;
 * a value import would make every consumer of `@omni/providers` pull the store,
 * and with it `bun:sqlite`.
 *
 * **`leafSubpaths.test.ts` cannot see this**, and a comment in `CLAUDE.md`
 * claimed otherwise until it was measured: turning one of the three into a value
 * import leaves that file's four tests — and the whole suite — green, because
 * `oauthFlow.ts` is not reachable from `catalog.ts` or `descriptors.ts` at all,
 * so it is outside both leaf graphs regardless of import kind. The rule needed
 * an instrument rather than a sentence.
 *
 * Same parser the bundler uses, for the reason `leafSubpaths.test.ts` gives:
 * `scanImports` drops type-only imports and reports dynamic ones, and two
 * hand-written versions of that file were each defeated by a case a regex could
 * not see.
 */
function runtimeSpecifiers(entry: string): { files: string[]; bare: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const record of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (record.path.startsWith(".")) walk(resolve(dirname(file), record.path));
      else bare.add(record.path);
    }
  };
  walk(resolve(SRC, entry));
  return { files: [...seen].map((f) => relative(SRC, f)).sort(), bare: [...bare].sort() };
}

test("the package entry point has no runtime edge to the store", () => {
  const graph = runtimeSpecifiers("index.ts");

  // Assert the walk actually reached the OAuth modules before asserting what it
  // did not find. A walk that stopped early would satisfy the negative below
  // while proving nothing — the "assert the walk found something" instrument
  // `providerTables.test.ts` uses, for the same reason.
  expect(graph.files).toContain("oauthFlow.ts");
  expect(graph.files).toContain("oauthUsage.ts");
  expect(graph.files).toContain("openai/oauth.ts");

  expect(graph.bare).not.toContain("@omni/store");
  expect(graph.bare).not.toContain("@omni/store/types");
  // The whole set, not just the negative. `not.toContain` alone would pass
  // against a package that had quietly grown an edge to something else; this is
  // the entry point every consumer imports, so what it drags in is worth
  // stating. `node:*` is the HTTP client, which is why `descriptors.ts` and
  // `catalog.ts` are separate leaf subpaths in the first place.
  expect(graph.bare).toEqual(["@omni/ir", "node:crypto", "node:http", "node:https", "node:stream"]);
});

test("every store import in this package is type-only, in source", () => {
  // The graph walk above answers "no runtime edge today". This answers the
  // narrower question a reviewer actually asks of a diff — is the `type` keyword
  // still on every one of them — and names the file when it is not.
  const offenders: string[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true })) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trimStart();
      // Import statements only. Prose naming the package — this rule is
      // documented in two of these files — is not an edge.
      if (!trimmed.startsWith("import")) continue;
      if (!/from "@omni\/store(?:\/[\w-]+)?"/.test(trimmed)) continue;
      if (!trimmed.startsWith("import type ")) offenders.push(`${relative(SRC, path)}: ${trimmed}`);
    }
  }
  expect(offenders).toEqual([]);
});
