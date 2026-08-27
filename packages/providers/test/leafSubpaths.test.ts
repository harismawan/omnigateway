import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

/**
 * Every module reachable from an entry point, and every bare specifier it names.
 *
 * Walks the source rather than the bundle. An earlier version of this file
 * probed the built output for `node:http`, `nodeHttpClient` and
 * `CONNECT_ATTEMPT_TIMEOUT_MS`, and **could not see an adapter leak at all**:
 * adapters receive `HttpClient` by injection, so exporting one from
 * `descriptors.ts` grew the browser bundle nearly fourfold, pulled in `Bun.env`
 * and every profile header — and left all three markers false and the test
 * green. A guardrail that cannot fail is worse than none, because three
 * documents cited it as enforcement.
 *
 * The import graph is the thing the rule is actually about, so it is what gets
 * asserted. Nothing a module does at runtime can hide an edge from it.
 */
function graphOf(entry: string): { files: string[]; bare: string[] } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    // Type-only imports are erased before anything runs, so they cannot carry a
    // dependency into a bundle. Stripped rather than matched around, because
    // `import type { A } from "x"` and `import { type A } from "x"` both erase
    // and only the first is easy to spot with a single pattern.
    const source = readFileSync(file, "utf8").replace(
      /(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["'];?/g,
      "",
    );
    // Import and re-export specifiers alike: `export … from` reaches a module
    // exactly as `import … from` does, and the leak this guards against is
    // naturally written as a re-export.
    for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
      else bare.add(specifier);
    }
  };
  walk(resolve(SRC, entry));
  return {
    files: [...seen].map((f) => relative(SRC, f)).sort(),
    bare: [...bare].sort(),
  };
}

/**
 * `catalog.ts` and `descriptors.ts` are leaf subpaths: the console imports the
 * first, the pure router imports both. Neither may reach an adapter, the HTTP
 * client, or `Bun.env`.
 */
test("the descriptors subpath reaches only descriptors and model lists", () => {
  const { files, bare } = graphOf("descriptors.ts");

  // Type-only imports are erased, so a bare specifier here is a real runtime
  // dependency. The leaf is allowed none at all.
  expect(bare).toEqual([]);

  // Every reachable module is a descriptor or a model list. An adapter is
  // `<id>/index.ts` and would appear here immediately.
  const unexpected = files.filter(
    (f) =>
      !/^(descriptors\.ts|descriptor\.ts|catalog-types\.ts|[a-z]+\/(descriptor|models)\.ts)$/.test(
        f,
      ),
  );
  expect(unexpected).toEqual([]);

  // Proof the walk found the graph rather than stopping at the entry: the entry
  // plus six providers, each contributing a descriptor and a model list.
  // `descriptor.ts` and `catalog-types.ts` are absent because they hold only
  // types and are erased — which is the walker demonstrating it models runtime
  // reachability rather than text.
  expect(files.length).toBe(13);
});

test("the catalog subpath reaches only model lists", () => {
  const { files, bare } = graphOf("catalog.ts");

  expect(bare).toEqual([]);
  const unexpected = files.filter(
    (f) => !/^(catalog\.ts|catalog-types\.ts|[a-z]+\/models\.ts)$/.test(f),
  );
  expect(unexpected).toEqual([]);
  // The entry plus one model list per provider; the types module is erased.
  expect(files.length).toBe(7);
});

/**
 * The control. Both assertions above are "this set is empty", which is also what
 * a broken walker returns — so one entry point that genuinely does reach the
 * transport has to prove the walker sees it.
 */
test("the package root does reach the transport, so the checks above mean something", () => {
  const { files, bare } = graphOf("index.ts");

  expect(files).toContain("http-client.ts");
  expect(files.some((f) => /^[a-z]+\/index\.ts$/.test(f))).toBe(true);
  expect(bare).toContain("node:http");
});
