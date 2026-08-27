import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { PROVIDER_IDS } from "../src/descriptors.ts";

const SRC = resolve(import.meta.dir, "../src");

/**
 * Every module reachable from an entry point, and every bare specifier it names.
 *
 * Uses `Bun.Transpiler.scanImports` — the same parser that builds the code. Two
 * earlier versions of this file were hand-written and both failed to see the
 * leak they existed to catch:
 *
 * 1. Searching the built bundle for `node:http` / `nodeHttpClient` /
 *    `CONNECT_ATTEMPT_TIMEOUT_MS` saw nothing when an adapter was re-exported.
 *    Adapters take `HttpClient` by injection, so the bundle grew fourfold with
 *    every marker still false.
 * 2. A regex over source text was defeated three ways: a doc comment containing
 *    the words `import type` swallowed the real import after it, because the
 *    type-stripping pattern crossed newlines; `import()` was never matched; and
 *    neither was `require()`.
 *
 * Both were mutation-tested by their author against mutants exercising only the
 * case the implementation already handled. A real parser has no such blind spot,
 * and is not a thing this repository then has to maintain.
 */
function graphOf(entry: string): { files: string[]; bare: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const record of transpiler.scanImports(readFileSync(file, "utf8"))) {
      // `scanImports` drops type-only imports already, and reports dynamic ones
      // with `kind` saying so. Both are runtime edges as far as this rule cares.
      const specifier = record.path;
      if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
      else bare.add(specifier);
    }
  };
  walk(resolve(SRC, entry));
  return { files: [...seen].map((f) => relative(SRC, f)).sort(), bare: [...bare].sort() };
}

/** Markers in the built browser bundle. A global needs no import edge to appear. */
async function bundleMarkers(
  entry: string,
  probes: readonly string[],
): Promise<Record<string, boolean>> {
  const built = await Bun.build({ entrypoints: [resolve(SRC, entry)], target: "browser" });
  expect(built.success).toBe(true);
  const code = (await Promise.all(built.outputs.map((a) => a.text()))).join("\n");
  return Object.fromEntries(probes.map((p) => [p, code.includes(p)]));
}

/**
 * `catalog.ts` and `descriptors.ts` are leaf subpaths: the console imports the
 * first, the pure router imports both. Neither may reach an adapter, the HTTP
 * client, or `Bun.env`.
 */
test("the descriptors subpath reaches only descriptors and model lists", () => {
  const { files, bare } = graphOf("descriptors.ts");

  // Type-only imports are erased, so a bare specifier here is a real runtime
  // dependency. The leaf is allowed none.
  expect(bare).toEqual([]);

  const unexpected = files.filter(
    (f) => !/^(descriptors\.ts|[a-z]+\/(descriptor|models)\.ts)$/.test(f),
  );
  expect(unexpected).toEqual([]);

  // Derived, not a constant. A seventh provider is a correct change and must not
  // fail this with an opaque "expected 13, received 15"; what is asserted is that
  // the walk reached every provider, not that there are six of them.
  expect(files.length).toBe(1 + PROVIDER_IDS.length * 2);
});

test("the catalog subpath reaches only model lists", () => {
  const { files, bare } = graphOf("catalog.ts");

  expect(bare).toEqual([]);
  const unexpected = files.filter((f) => !/^(catalog\.ts|[a-z]+\/models\.ts)$/.test(f));
  expect(unexpected).toEqual([]);
  expect(files.length).toBe(1 + PROVIDER_IDS.length);
});

/**
 * The import graph cannot see a global. `Bun.env` needs no edge, so reading it
 * directly inside a leaf is invisible to the walk above — which is why the
 * bundle check survives rather than being replaced by it. The two instruments
 * cover different things and neither is sufficient alone.
 */
test("neither leaf reaches Bun.env or the transport in the built bundle", async () => {
  for (const entry of ["descriptors.ts", "catalog.ts"]) {
    expect(await bundleMarkers(entry, ["Bun.env", "process.env", "node:http"])).toEqual({
      "Bun.env": false,
      "process.env": false,
      "node:http": false,
    });
  }
});

/**
 * The control. Every assertion above is "this set is empty" or "this marker is
 * absent", which is also what a broken harness reports — so one entry point that
 * genuinely does reach the transport has to prove both instruments see it.
 */
test("the package root does reach the transport, so the checks above mean something", async () => {
  const { files, bare } = graphOf("index.ts");
  expect(files).toContain("http-client.ts");
  expect(files.some((f) => /^[a-z]+\/index\.ts$/.test(f))).toBe(true);
  expect(bare).toContain("node:http");

  expect(await bundleMarkers("index.ts", ["Bun.env"])).toEqual({ "Bun.env": true });
});
