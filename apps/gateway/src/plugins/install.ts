import {
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type RegisteredProvider,
  registerOAuthProvider,
  seedBuiltinOAuth,
} from "@omni/control";
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
 * **The built-in OAuth flows are seeded here**, before the loop, and that is
 * this function's second reason to exist. `OAUTH_PROVIDERS` is empty until a
 * host fills it, and the seed used to sit inline in `main()` — which no test
 * calls, so the only guard was a test grepping the source, and a `//` defeats
 * a substring match. Here it is on the same unconditional boot path and
 * reachable from a harness.
 *
 * **This function must stay unconditional.** `main()` calls it with an empty
 * array when there are no plugins, and that call is what installs OAuth on
 * such an installation — which is most of them. Wrapping it in
 * `if (providers.length > 0)` reads as an obvious tidy-up and kills OAuth on
 * every plugin-less host; the name says "plugin providers" and the seed is the
 * part that is not about plugins at all.
 *
 * Safe this late in boot because every consumer takes the registry **by
 * reference and reads it at call time**: `createRefresher` is constructed
 * earlier in `main()` and resolves a provider per refresh. It runs *after*
 * `loadPlugins`, which is only safe because the loader registers no flow —
 * `readProviders`' shadow refusal consults `PROVIDER_DESCRIPTORS`, and the
 * only `registerOAuthProvider` call on this host is in the loop below, after
 * the seed. If the loader ever registers a flow, the seed must move ahead of
 * it or a plugin will take a built-in's id.
 *
 * Extracted from `index.ts` so it can be tested at all, and that is the whole
 * reason it exists as a function.
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
  // Injected so a test can hand this a fresh table and observe *this call's*
  // effect. Reading the process-wide one made the guard below assert whatever
  // an earlier test file had seeded, which is how the round-1 defect survived
  // its own fix.
  registry: Record<string, OAuthProvider> = OAUTH_PROVIDERS,
): void {
  // First, and unconditionally — an empty `providers` must still leave a host
  // with its own built-in flows.
  seedBuiltinOAuth(registry);

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
    if (Object.hasOwn(PROVIDER_DESCRIPTORS, id) || Object.hasOwn(registry, id)) {
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
      registerOAuthProvider(provider.descriptor.id, provider.oauth, registry);
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
