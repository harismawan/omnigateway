import { OAUTH_PROVIDERS, seedBuiltinOAuth } from "../../src/oauth/index.ts";
import type { DeviceOAuthProvider, OAuthProvider } from "../../src/oauth/types.ts";

/**
 * The built-in flows, adapted the way a running host adapts them.
 *
 * The vendor modules moved to `@omni/providers` and now export a
 * `PluginOAuthFlow`; `oauthAdapter` is the host's and stayed here. So the tests
 * that drive these providers reach them through the **seed**, rather than
 * calling the adapter themselves — which is stronger than the arrangement it
 * replaced, and deliberately so — though not equally in all three directions,
 * which is worth stating rather than rounding up. Measured: a seed that **drops**
 * a provider fails 11 tests across **six** files (`connect`, `install`,
 * `refresh`, `anthropic`, `grok`, `pluginFlow`); one that installs the **wrong
 * flow** fails 5, all in that provider's own suite; one that forgets
 * `trusted` fails 3, in `logging.test.ts` and `pluginFlow.test.ts` rather than
 * here. So the arrangement is strong on membership, narrow on the other two,
 * and each is pinned somewhere. Re-measure these before editing them — the
 * first version of this note said "four files", counted before the round that
 * added two more.
 *
 * **Importing this file seeds the process-wide registry**, as a side effect, for
 * every test file that runs after it in the same Bun process. That is deliberate
 * — a host does the same thing at boot — but it is why no other test may treat a
 * populated registry as given: `seedBuiltinOAuth()` is idempotent, so a file
 * that reads the registry should call it rather than inherit it.
 *
 * Every assertion in the five files below is otherwise unchanged from before the
 * move, which is the whole proof: the mutants they kill — dropped `client_id`,
 * dropped beta header, state check off, kilo's second request unauthenticated,
 * kilo's org read skipped, grok's host check off, kimi's device headers
 * dropped, openai's content type changed — must still die from the new location.
 */
seedBuiltinOAuth();

function builtin(id: string): OAuthProvider {
  const provider = OAUTH_PROVIDERS[id];
  if (provider === undefined) throw new Error(`the built-in seed installed no flow for ${id}`);
  return provider;
}

/**
 * The device arm, narrowed once here rather than at each reader.
 *
 * These tests read `begin` and `needsDeviceId`, neither of which exists on the
 * pkce arm — the same narrowing `oauthAdapter`'s overload used to hand the
 * named export directly.
 */
function deviceBuiltin(id: string): DeviceOAuthProvider {
  const provider = builtin(id);
  if (provider.kind !== "device") throw new Error(`${id} is not a device flow`);
  return provider;
}

export const anthropicOAuth = builtin("anthropic");
export const grokOAuth = builtin("grok");
export const openaiOAuth = builtin("openai");
export const kiloOAuth = deviceBuiltin("kilo");
export const kimiOAuth = deviceBuiltin("kimi");
export const museOAuth = deviceBuiltin("muse");
