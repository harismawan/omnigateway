import { OAUTH_PROVIDERS, type RegisteredProvider, registerOAuthProvider } from "@omni/control";
import type { Logger } from "@omni/ir";
import { PROVIDER_DESCRIPTORS, registerProvider } from "@omni/providers";

/**
 * Installs the providers plugins supplied.
 *
 * Called from boot and nowhere else, because boot is the one place that knows
 * the ordering constraint: every registry read is a call-time read, so a
 * provider added after `createApp` would exist for later requests and not
 * earlier ones. Registering before the app is built makes "installed" a property
 * of boot rather than a race.
 *
 * **The collision check below is no longer the rule, and this docblock said it
 * was for one release.** A plugin shadowing `anthropic` would take its traffic,
 * its stored credentials and its `--p-anthropic` colour — and that is refused in
 * `readProviders`, which the loader and the CLI both go through, because it was
 * being enforced *here* and nowhere on the CLI's path: the CLI's merge applied
 * the plugin's descriptor over the built-in, so `omni setup` wrote a plugin's
 * context window into an agent's config while the gateway served the real
 * adapter. Two copies of one rule, disagreeing on their first day.
 *
 * What remains here is the guard on `registerProvider`'s throw, and it is
 * unreachable from the loader today. It stays because a throw at this point
 * escapes to the top-level catch and `process.exit(1)`s — a plugin turning into
 * a boot outage, which rule 15 forbids — so the cost of keeping it is one branch
 * and the cost of removing it is that failure mode returning silently. Read it
 * as defence, not as the place the decision is made.
 *
 * Extracted from `index.ts` so it can be tested at all, and that is the whole
 * reason it exists as a function. It sat inline in `main()`, outside anything a
 * harness reaches, and `registerProvider` throws on a duplicate — so deleting
 * the guard would not have made a plugin win, it would have made the throw
 * escape to the top-level `catch`, which `process.exit(1)`s. One plugin
 * directory name would have turned into a refusal to boot, which is exactly
 * what boundary rule 15 says a plugin must never be able to do. An untested
 * `if` was the only thing standing between the two.
 *
 * Reports and continues, never throws: rule 15 again. A plugin that cannot be
 * installed is one plugin missing, and the proxy path depends on none of them.
 */
export function installPluginProviders(
  providers: readonly RegisteredProvider[],
  logger: Logger,
): void {
  for (const provider of providers) {
    const id = provider.descriptor.id;
    // `Object.hasOwn`, not an index check: `PROVIDER_DESCRIPTORS` is
    // null-prototype so both answer alike today, and the explicit form is what
    // keeps that true if it is ever handed an ordinary literal.
    // Both tables, not one as a proxy for the other. `registerOAuthProvider`
    // throws on a duplicate too, and this loop is documented as never throwing —
    // a throw here escapes to the top-level catch and `process.exit(1)`s, which
    // is a plugin turning into a boot outage and is what rule 15 forbids. The
    // descriptor check alone relied on an unstated invariant that the two key
    // sets agree.
    if (Object.hasOwn(PROVIDER_DESCRIPTORS, id) || Object.hasOwn(OAUTH_PROVIDERS, id)) {
      logger.warn("plugin provider ignored", {
        plugin: id,
        reason: `a provider named ${id} is already installed`,
      });
      continue;
    }
    registerProvider(provider.descriptor, provider.adapter);
    // The flow, when the plugin declared one. Registered here rather than at a
    // second call site because the ordering constraint is the same and having
    // one place obey it is what keeps a provider from being routable while its
    // authorization is not installed.
    if (provider.oauth !== undefined) {
      registerOAuthProvider(provider.descriptor.id, provider.oauth);
    }
    logger.info("plugin provider registered", { plugin: id });
    // A separate line rather than a field on the one above. `LogFields` is a
    // closed allowlist and has no member for this — and a conditional spread
    // would have added one without the compiler objecting, because excess
    // property checking does not see through a spread. Measured.
    if (provider.oauth !== undefined) {
      logger.info("plugin oauth flow registered", { plugin: id });
    }
  }
}
