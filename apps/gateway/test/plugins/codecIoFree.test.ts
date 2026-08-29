/**
 * The codec contract has nowhere to put a request, and that is asserted rather
 * than described.
 *
 * Boundary rule 15 says a plugin never receives the `HttpClient`, and the
 * `provider` capability is the one place that rule came under real pressure: a
 * provider's whole job is talking upstream. The answer was to move the split —
 * the plugin describes a request and reads a stream, the host performs it — and
 * the design's claim about that answer is stronger than a rule. It is that
 * "there is no seam where a plugin could hold a client, which is why this file
 * contains no rule saying it must not"
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`).
 *
 * A claim of that form decays silently: nothing fails on the day a transport
 * arrives inside a plugin's reach, the suite stays green, and the sentence goes
 * on being quoted. So this file measures it, the way `leafSubpaths.test.ts`
 * measures a leaf, and with two instruments for the reason that file gives — an
 * import walk cannot see a global, and a token scan cannot see an edge the
 * importer renamed.
 *
 * It lives in `apps/gateway` because it asserts something about
 * `@omnigateway/plugin-api` *and* about `@omni/providers`, and this is the only
 * place that may import both.
 *
 * **No bundler here, and the reason is about what a bundle can show rather than
 * about what Bun can resolve.** An earlier version of this paragraph claimed, as
 * a measurement, that `Bun.build` could not resolve a workspace dependency of a
 * package given an absolute entry path. **That was false** — review re-ran it and
 * so did its author: `packages/plugin-api/src/manifest.ts` builds under
 * `bun test` with `zod` present in the output. The claim came from a different
 * failing shape — a scratch entry re-exporting a bare specifier — generalised
 * into one that was never measured, in a file whose whole premise is measuring a
 * claim rather than restating it. It is recorded rather than quietly deleted,
 * because that mistake is the kind this file exists to catch.
 *
 * The real reason is the *control*. Bundle a `target: "bun"` build of
 * `packages/providers/src/index.ts` — a package that genuinely does reach the
 * transport — and `node:http` does **not** appear in the output: it is external
 * to that target, and tree-shaking moves what survives besides. A probe for
 * transport markers therefore reports "absent" for a package that has one, which
 * makes absence uninformative — failure mode 1 that `leafSubpaths.test.ts`
 * records at length. The import walk answers that question exactly.
 * `bundleWeight.test.ts` keeps the bundler for the question a bundle *can*
 * answer: how many bytes a plugin pays.
 *
 * What the walk cannot see is a global, which is why the token scan below sits
 * beside it rather than instead of it.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../../..");
const PROVIDERS_SRC = join(REPO, "packages/providers/src");
const PLUGIN_API_SRC = join(REPO, "packages/plugin-api/src");

/** Every entry point a plugin may import, as this package's `exports` names them. */
const PLUGIN_ENTRIES = [
  "index.ts",
  "context.ts",
  "events.ts",
  "manifest.ts",
  "version.ts",
] as const;

/**
 * Specifiers that mean "this code can reach the network or the filesystem".
 *
 * A prefix match on `node:`, because the builtin a leak arrives through is not
 * predictable and the correct number of them here is zero: nothing a plugin
 * imports has any business reaching a runtime builtin. Named packages are listed
 * beside it for the same reason in the other direction — an edge to `undici` or
 * `ws` is a transport whatever the platform.
 */
function isTransportSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    ["undici", "ws", "axios", "got", "node-fetch"].includes(specifier)
  );
}

/**
 * Globals that need no import edge, so the walk below is blind to them.
 *
 * `fetch(` and `new Request(` are the two a plugin author would reach for
 * without thinking, and neither shows up as a dependency of anything.
 */
const TRANSPORT_TOKENS = ["fetch(", "new Request(", "XMLHttpRequest", "WebSocket", "import("];

/**
 * Comments removed, so a mention in prose never counts as a use.
 *
 * The same rule `scripts/dead-exports.ts` records as a finding rather than a
 * detail: three instruments in this repository have read comment text as
 * evidence about code, and this file's docblocks name every token in the list
 * above.
 */
function code(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1 ");
}

/**
 * Every module reachable from an entry point, and every bare specifier it names.
 *
 * `Bun.Transpiler.scanImports` rather than a regex, for the reason
 * `leafSubpaths.test.ts` records at length: two hand-written versions of that
 * walk each failed to see the leak they existed to catch. Type-only imports are
 * dropped by the parser, so a bare specifier here is a real runtime dependency —
 * which is the point, since `PluginProvider` types both halves of a registration
 * as `unknown` and a codec's types are erased entirely.
 */
function graphOf(root: string, entry: string): { files: string[]; bare: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const bare = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const record of transpiler.scanImports(readFileSync(file, "utf8"))) {
      const specifier = record.path;
      if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
      else bare.add(specifier);
    }
  };
  walk(resolve(root, entry));
  return { files: [...seen].map((f) => relative(root, f)).sort(), bare: [...bare].sort() };
}

/** Which transport tokens appear in the source of every file the walk reached. */
function tokensIn(root: string, files: readonly string[]): string[] {
  const text = files.map((f) => code(readFileSync(resolve(root, f), "utf8"))).join("\n");
  return TRANSPORT_TOKENS.filter((token) => text.includes(token));
}

test("the codec contract is types and nothing else", () => {
  // The shape claim at its source. `codec.ts` declares what a provider supplies;
  // the day it acquires a runtime import, "a codec has nowhere to put I/O" stops
  // being a property of the contract and becomes a thing reviewers must notice.
  const { files, bare } = graphOf(PROVIDERS_SRC, "codec.ts");

  expect(bare).toEqual([]);
  expect(files).toEqual(["codec.ts"]);
});

test("nothing a plugin imports names a transport", () => {
  for (const entry of PLUGIN_ENTRIES) {
    const { bare } = graphOf(PLUGIN_API_SRC, entry);
    // The specifiers, not a boolean, so a failure names what arrived.
    expect([entry, bare.filter(isTransportSpecifier)]).toEqual([entry, []]);
  }
});

test("nor reaches one through a global", () => {
  for (const entry of PLUGIN_ENTRIES) {
    const { files } = graphOf(PLUGIN_API_SRC, entry);
    expect([entry, tokensIn(PLUGIN_API_SRC, files)]).toEqual([entry, []]);
  }
});

/**
 * The controls, and they are the load-bearing half.
 *
 * Every assertion above is "this set is empty", which is also what a walk that
 * scanned nothing and a scanner that read nothing report. `@omni/providers` is
 * the honest positive: it is the package that genuinely does reach the transport,
 * so both instruments have to see it there.
 */
test("the walk sees a real edge, so an empty one is a fact", () => {
  // A bare specifier the walk must report, from inside the package under test —
  // so this control fails if the walk stops resolving plugin-api's own files.
  expect(graphOf(PLUGIN_API_SRC, "manifest.ts").bare).toContain("zod");

  // And a transport edge, which is what `isTransportSpecifier` is asked about.
  const providers = graphOf(PROVIDERS_SRC, "index.ts");
  expect(providers.bare).toContain("node:http");
  expect(providers.bare.filter(isTransportSpecifier).length).toBeGreaterThan(0);
});

test("the scanner sees every global it looks for, so an empty list is a fact", () => {
  // `fetch(` appears nowhere in production here — rule 8 sends every outbound
  // request through `HttpClient` — so the control cannot come from this
  // repository's own source and needs a fixture that deliberately contains one.
  // Without it, "no plugin entry reaches a global" would pass against a scanner
  // that never fires.
  //
  // Every token, not one of them. Proving `import(` and arguing the rest share
  // a loop is a claim about the implementation rather than a measurement of it,
  // and it leaves `fetch(` and `new Request(` — the two the list above exists
  // for — resting on that argument.
  const fixture = join(import.meta.dir, "fixtures/transportProbe.ts");
  expect(tokensIn("/", [fixture]).sort()).toEqual([...TRANSPORT_TOKENS].sort());
});

test("and it does not count a token that only appears in prose", () => {
  // The other half of the control, and it needs its own fixture rather than this
  // file: the token list above is *code* here, so scanning this file can never
  // come back empty however correct the stripping is. Measured — the first
  // version of this test asserted exactly that and failed.
  //
  // The direction it guards is the quiet one. A scanner that never matched shows
  // up as a green suite over an empty set; a scanner that matched prose would
  // report the repository's own docblocks as leaks, which is loud. What is left
  // is a *reader* believing the stripping claim without it being measured.
  const fixture = join(import.meta.dir, "fixtures/commentProbe.ts");
  expect(tokensIn("/", [fixture])).toEqual([]);
});
