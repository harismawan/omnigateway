import { afterEach, expect, test } from "bun:test";
import { OAUTH_PROVIDERS, validateRegistration } from "@omni/control";
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
