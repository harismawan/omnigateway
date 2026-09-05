import type { ProviderId } from "@omni/ir";
import { anthropicOAuthFlow } from "./anthropic/oauth.ts";
import { antigravityOAuthFlow } from "./antigravity/oauth.ts";
import { grokOAuthFlow } from "./grok/oauth.ts";
import { kiloOAuthFlow } from "./kilo/oauth.ts";
import { kimiOAuthFlow } from "./kimi/oauth.ts";
import type { PluginOAuthFlow } from "./oauthFlow.ts";
import { openaiOAuthFlow } from "./openai/oauth.ts";

/**
 * The five flows this repository ships, for a host to register at boot.
 *
 * One seed, two callers — the gateway from `installPluginProviders`, the CLI
 * from `run()`, because `omni connect` runs without a gateway — and zero copies
 * of the list. `OAUTH_PROVIDERS` in `@omni/control` starts empty and is
 * filled through `registerOAuthProvider`, the same door a plugin's flow comes
 * through, so a built-in is no longer privileged by being compiled into a
 * literal.
 *
 * **A function, not a constant.** Six sites in this repository have now been
 * wrong by reading a provider table at module scope, and the failure is always
 * the same shape: the snapshot is taken before the thing it describes exists.
 * Nothing here may become an `Object.keys` or a frozen array evaluated on
 * import, including in a caller's seed path.
 *
 * Flows rather than adapted `OAuthProvider`s, because `oauthAdapter` is the
 * host's — it performs the requests a flow yields, enforces the origin check,
 * the yield cap and the return-shape validation, and stamps `gatewayAuthored`
 * on the errors of a flow the host trusts. A package that adapted its own flows
 * would need the transport it exists not to hold.
 *
 * **The order is the order an operator is offered them**, and it is load-bearing
 * rather than incidental: `oauthProviderIds` derives the list `omni connect`
 * refuses an unknown provider with from `Object.keys` of the registry, and
 * insertion order is what that reports. Sorting these alphabetically reorders a
 * sentence an operator reads, which is why the connect suite matches that line
 * by equality rather than by `toContain`.
 */
export function builtinOAuthFlows(): ReadonlyArray<readonly [ProviderId, PluginOAuthFlow]> {
  return [
    ["anthropic", anthropicOAuthFlow],
    ["openai", openaiOAuthFlow],
    ["kimi", kimiOAuthFlow],
    ["kilo", kiloOAuthFlow],
    ["grok", grokOAuthFlow],
    ["antigravity", antigravityOAuthFlow],
  ];
}
