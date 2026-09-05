import { afterEach, expect, test } from "bun:test";
import {
  OAUTH_PROVIDERS,
  type OAuthProvider,
  registerOAuthProvider,
  validateRegistration,
} from "@omni/control";
import { ADAPTERS, PROVIDER_DESCRIPTORS } from "@omni/providers";
import { captureLogger, entryOf } from "@omni/testkit";
import { installPluginProviders } from "../../src/plugins/install.ts";

/**
 * What boot does with the providers plugins supplied.
 *
 * This loop lived inline in `main()` until it was extracted, which meant no
 * harness could reach it — and the thing it does is the last guard between a
 * plugin directory name and a refusal to boot. `registerProvider` throws on a
 * duplicate id, and a throw here escapes to the top-level `catch`, which
 * `process.exit(1)`s. So deleting the collision check would not have let a
 * plugin shadow `anthropic`; it would have made one plugin stop the gateway,
 * which is precisely what boundary rule 15 says a plugin must never be able to
 * do. An untested `if` was standing between the two.
 */

const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");

const codec = {
  buildRequest: () => ({ request: { url: "https://x", method: "POST", headers: [], body: "{}" } }),
  decode: async function* () {},
};

function registered(id: string) {
  return validateRegistration(id, {
    descriptor: { ...anthropic, id },
    codec,
  });
}

// The registry is module state, so anything installed here outlives the test.
const installed: string[] = [];
afterEach(() => {
  for (const id of installed.splice(0)) {
    delete (PROVIDER_DESCRIPTORS as Record<string, unknown>)[id];
    delete (ADAPTERS as Record<string, unknown>)[id];
    // The OAuth registry too. Nothing here declares a flow today, so nothing
    // leaks — but adding one is a single field on a fixture, and the failure
    // would land in `packages/control/test/oauth/kimi.test.ts` and
    // `providerCoverage.test.ts`, neither of which mentions plugins. The second
    // is newly exposed: it reads `oauthProviderIds()` at call time now rather
    // than a frozen constant.
    delete (OAUTH_PROVIDERS as Record<string, unknown>)[id];
  }
});

/**
/**
 * The built-in OAuth flows reach a booted gateway, and this is the only test
 * that says so.
 *
 * **Driven against a fresh registry, not the process-wide one**, and that is
 * the whole load-bearing part. The first version of this test read
 * `OAUTH_PROVIDERS` — which is module state Bun shares across every file in one
 * process — so `logging.test.ts` and `apps/cli/test/connect.test.ts` seeded it
 * first and the assertion passed on someone else's work. Measured: deleting
 * `seedBuiltinOAuth()` from `installPluginProviders` left `bun test`,
 * `bun test apps/gateway` and `bun test packages/control` all green — every
 * invocation CI runs. That is the defect this seed was relocated to fix,
 * reproduced inside its own fix, and only an injected registry makes the
 * assertion about *this call*.
 *
 * The empty array is the case asserted because `main()` passes one on any
 * installation with no plugin providers, which is most of them.
 *
 * The literal, not `builtinOAuthFlows()`. Comparing the registry against the
 * same list a mutation would edit is a self-comparison — dropping a provider
 * from the seed satisfies it — and the **order** is operator-facing: it is the
 * sentence `omni connect` refuses an unknown provider with.
 */
test("boot seeds the five built-in oauth flows, in the order operators are offered them", () => {
  const registry: Record<string, OAuthProvider> = Object.create(null);

  installPluginProviders([], captureLogger(), registry);

  expect(Object.keys(registry)).toEqual([
    "anthropic",
    "openai",
    "kimi",
    "kilo",
    "grok",
    "antigravity",
  ]);
  expect(registry.anthropic?.kind).toBe("pkce");
  expect(registry.kilo?.kind).toBe("device");
});

test("a flow may not take an id the seed already installed", () => {
  const registry: Record<string, OAuthProvider> = Object.create(null);
  installPluginProviders([], captureLogger(), registry);
  const anthropic = registry.anthropic as OAuthProvider;

  // The refusal that replaced a silent `continue`. Round 1 found the skip; the
  // guard that replaced it was then itself unpinned — reverting it to
  // `if (Object.hasOwn(...)) continue` left the whole suite green.
  expect(() => {
    registerOAuthProvider("anthropic", anthropic, registry);
  }).toThrow(/already installed/);

  // And a fresh id still installs, so the refusal is about collision rather
  // than about the registry being closed.
  registerOAuthProvider("acme-ai", anthropic, registry);
  expect(Object.keys(registry)).toContain("acme-ai");
});

test("a plugin provider is installed and said so", () => {
  const logger = captureLogger();
  installed.push("acme-ai");

  installPluginProviders([registered("acme-ai")], logger);

  expect(Object.hasOwn(PROVIDER_DESCRIPTORS, "acme-ai")).toBe(true);
  expect(Object.hasOwn(ADAPTERS, "acme-ai")).toBe(true);
  expect(logger.records.map((line) => line.msg)).toContain("plugin provider registered");
});

test("a plugin colliding with a built-in is refused, and the gateway keeps booting", () => {
  const logger = captureLogger();
  const before = anthropic.presentation.label;

  // The assertion that matters is that this does not throw: `registerProvider`
  // does, and boot has no catch of its own around this call.
  expect(() => installPluginProviders([registered("anthropic")], logger)).not.toThrow();

  // The built-in is untouched — its descriptor, not the plugin's copy.
  expect(entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS")).toBe(anthropic);
  expect(
    entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS").presentation.label,
  ).toBe(before);

  // Reported, not silent. A plugin whose provider was dropped is a plugin whose
  // operator needs to rename it, and the only signal is this line.
  const ignored = logger.records.filter((line) => line.msg === "plugin provider ignored");
  expect(ignored).toHaveLength(1);
  expect(ignored[0]?.level).toBe("warn");
  expect(ignored[0]?.fields.plugin).toBe("anthropic");
  expect(ignored[0]?.fields.reason).toContain("already installed");
});

test("a collision does not stop the providers after it from installing", () => {
  // Order matters here and would not be noticed otherwise: a `throw` where the
  // `continue` is would drop every later plugin as well as the gateway.
  const logger = captureLogger();
  installed.push("acme-ai");

  installPluginProviders([registered("anthropic"), registered("acme-ai")], logger);

  expect(Object.hasOwn(PROVIDER_DESCRIPTORS, "acme-ai")).toBe(true);
});
