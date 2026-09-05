import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OAUTH_PROVIDERS,
  type OAuthProvider,
  oauthProviderIds,
  registerOAuthProvider,
  seedBuiltinOAuth,
} from "@omni/control";
import { builtinOAuthFlows } from "@omni/providers";

/**
 * The seed itself: idempotence, and the arms surviving the adapter.
 *
 * What this file does **not** do any more is stand in for a behavioural test.
 * `OAUTH_PROVIDERS` starts empty and a host fills it, so the question that
 * matters is whether a booted host actually calls the seed — and that is now
 * asserted where it can be: `install.test.ts` drives
 * `installPluginProviders`, the boot function `main()` calls unconditionally,
 * and `apps/cli/test/connect.test.ts` drives the CLI's own `run()`. Deleting
 * either seed fails those, not a grep.
 *
 * The one thing left that no behavioural test can see is whether `main()` still
 * calls `installPluginProviders` **before** `createApp` — the ordering
 * constraint that function's docblock owns. That is checked below on source
 * text, with comments stripped first, because a substring match against raw
 * source passes on a commented-out call: that is exactly how the previous
 * version of this file was defeated.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Source with comments removed, so a commented-out call is not a match.
 *
 * **Every** `//` to end of line, not just line-leading ones: the first version
 * anchored with `^\s*`, and `const x = 1; // seedBuiltinOAuth();` sailed
 * through it — the exact spelling the docblock claimed was prevented.
 *
 * This over-strips: a `//` inside a string literal or a URL takes the rest of
 * its line with it. That is the safe direction here — it can only make a real
 * call invisible and fail the test, never make a dead one look live — but it
 * means this helper is fit for "does this call exist" and nothing else.
 */
function activeSource(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");
}

test("a reseed reinstalls a built-in that was removed, rather than leaving a hole", () => {
  const registry: Record<string, OAuthProvider> = Object.create(null);
  seedBuiltinOAuth(registry);
  delete registry.anthropic;

  seedBuiltinOAuth(registry);

  // Measured before this was fixed: marking the whole registry "seeded" made a
  // second call an early return, so the registry stayed at four providers
  // permanently and the invariant "nothing ever deletes a built-in" was
  // load-bearing, unstated and unenforced. Two test files delete from the
  // shared registry in `afterEach`.
  //
  // **Membership, not order.** A repaired id is re-inserted, and JavaScript
  // object key order is insertion order, so it lands last — `anthropic` comes
  // back at the end rather than the front. That is a real limitation of this
  // recovery and it is asserted the honest way rather than hidden by a sort in
  // the production code: nothing in production deletes a built-in, so the
  // ordering the operator sees is the seed's own; a recovery restores what is
  // *reachable*, which is what a caller with a hole in its registry needs.
  expect(Object.keys(registry).sort()).toEqual(
    ["anthropic", "openai", "kimi", "kilo", "grok", "antigravity", "muse"].sort(),
  );
});

test("a flow another caller installed is a collision, not a thing the seed skips", () => {
  const registry: Record<string, OAuthProvider> = Object.create(null);
  seedBuiltinOAuth(registry);
  const anthropic = registry.anthropic as OAuthProvider;

  // The distinction the id-set exists for: "we installed this and it is still
  // here" is a skip, "somebody else holds this id" is a throw. A bare
  // `Object.hasOwn` collapses the two and silently hands a built-in's
  // authorize flow — and its stored credentials — to whoever got there first.
  const fresh: Record<string, OAuthProvider> = Object.create(null);
  registerOAuthProvider("anthropic", anthropic, fresh);
  expect(() => {
    seedBuiltinOAuth(fresh);
  }).toThrow(/already installed/);
});

test("a second seed is a no-op rather than a duplicate-registration crash", () => {
  seedBuiltinOAuth();
  const first = oauthProviderIds();
  // The CLI constructs a context per invocation and a harness may run several
  // in one process. Idempotence is a module-private flag, not a per-id key
  // check: the key check also silently accepted "a plugin got here first",
  // which is the case that must reach `registerOAuthProvider`'s throw.
  expect(() => {
    seedBuiltinOAuth();
  }).not.toThrow();
  expect(oauthProviderIds()).toEqual(first);
});

test("the seed installs a real flow under each id, not a placeholder", () => {
  seedBuiltinOAuth();
  for (const [id, flow] of builtinOAuthFlows()) {
    const provider = OAUTH_PROVIDERS[id];
    expect(provider?.id).toBe(id);
    // The arm survives the adapter: `oauthAdapter` is overloaded on `kind`, and
    // a device provider that lost it would take the pkce path in `connect.ts`
    // and never call `begin`.
    expect(provider?.kind).toBe(flow.kind);
    expect(provider?.supportsManualPaste).toBe(flow.supportsManualPaste);
  }
});

test("boot registers providers before the app is built", () => {
  const gateway = activeSource("apps/gateway/src/index.ts");

  // Both present in code rather than in a comment, and in this order. A
  // provider registered after `createApp` exists for later requests and not
  // earlier ones, which is the race `installPluginProviders` is called early to
  // avoid — and the built-in OAuth seed now rides that same call.
  expect(gateway).toContain("installPluginProviders(");
  expect(gateway).toContain("createApp(");
  expect(gateway.indexOf("installPluginProviders(")).toBeLessThan(gateway.indexOf("createApp("));

  // **Unconditional**, checked by indentation: exactly two spaces is a
  // top-level statement of `main()`, and anything nested in an `if` block is
  // indented four. Measured — `if (loadedPlugins.providers.length > 0)` around
  // this call leaves the rest of the suite green while killing OAuth on every
  // installation with no plugin providers, which is most of them. It is a
  // plausible tidy-up precisely because the function is named for plugins and
  // the seed is the part of it that is not about plugins.
  //
  // An indentation heuristic, and worth naming as one: biome fixes the indent
  // at two spaces so it holds today, and a nested call written across lines
  // would still be caught by the depth, but a contributor who reformats this
  // file gets a failure to think about rather than a silent pass. That is the
  // safe direction for a check standing in for a behavioural test that would
  // need a booted gateway with a database, a key and a port.
  expect(gateway).toMatch(/\n {2}installPluginProviders\(/);
});

test("the CLI seeds too, because omni connect runs without a gateway", () => {
  // Behaviourally covered by `apps/cli/test/connect.test.ts` — deleting this
  // call fails six of its tests. Kept here as the statement of *why* there are
  // two hosts at all, and comment-stripped so it cannot pass on a dead line.
  expect(activeSource("apps/cli/src/run.ts")).toContain("seedBuiltinOAuth()");
});
