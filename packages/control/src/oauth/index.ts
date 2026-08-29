import type { ProviderId } from "@omni/ir";
import { anthropicOAuth } from "./anthropic.ts";
import { grokOAuth } from "./grok.ts";
import { kiloOAuth } from "./kilo.ts";
import { kimiOAuth } from "./kimi.ts";
import { openaiOAuth } from "./openai.ts";
import type { OAuthProvider } from "./types.ts";

export const OAUTH_PROVIDERS = {
  anthropic: anthropicOAuth,
  openai: openaiOAuth,
  kimi: kimiOAuth,
  kilo: kiloOAuth,
  grok: grokOAuth,
} as const satisfies Readonly<Partial<Record<ProviderId, OAuthProvider>>>;

// Nothing to inherit, for the reason given on `PROVIDER_DESCRIPTORS` — and this
// table is the one where it bites hardest. `refresh.ts` reads it by a *stored*
// `credential.provider` and relies on `undefined` to raise a clean
// `BAD_REQUEST`; on an ordinary literal, `OAUTH_PROVIDERS["constructor"]`
// answers the `Object` constructor, so the guard passes and `provider.refresh`
// throws a raw `TypeError` that `classify` turns into `INTERNAL`. That is the
// same failure, with the same signature, as the one `resolveModel` shipped.
//
// `PROVIDER_ID_PATTERN` accepts `constructor`, so nothing upstream stops such
// an id being stored.
Object.setPrototypeOf(OAUTH_PROVIDERS, null);

/**
 * Which providers there is an authorization to start, in the order an operator
 * is offered them.
 *
 * Derived from the table above rather than written beside it, because the two
 * lists that used to name these by hand — one in `start`'s error, one in the
 * CLI's usage — were free to disagree with it and with each other, and did:
 * both enumerated five providers while the guard in front of them accepted six.
 */
export function oauthProviderIds(
  providers: Readonly<Record<string, OAuthProvider>> = OAUTH_PROVIDERS,
): readonly ProviderId[] {
  return Object.keys(providers) as ProviderId[];
}

/**
 * Installs an OAuth flow a plugin supplied.
 *
 * The parallel of `registerProvider`, and it obeys the same ordering rule for
 * the same reason: every consumer reads its providers at call time from a map
 * it was handed, so a flow added before `createApp` is visible to connect,
 * refresh and the usage poller with no further wiring — and one added after
 * would exist for some requests and not others, which is a race rather than a
 * feature.
 *
 * **Not for the CLI.** It never calls `loadPlugins` and must not; it merges what
 * `readPluginProviders` read instead, which is the same declaration without
 * running the plugin's `setup`.
 *
 * Refuses to replace an existing id. A plugin shadowing `anthropic` would take
 * its authorization flow and its stored credentials, and the failure would be
 * silent.
 */
export function registerOAuthProvider(id: ProviderId, provider: OAuthProvider): void {
  if (Object.hasOwn(OAUTH_PROVIDERS, id)) {
    throw new Error(`an oauth flow for ${id} is already installed`);
  }
  (OAUTH_PROVIDERS as Record<string, OAuthProvider>)[id] = provider;
}

export type {
  AuthorizeStart,
  DeviceOAuthProvider,
  FlowResult,
  OAuthDeps,
  OAuthProvider,
  PendingFlow,
  PkceOAuthProvider,
} from "./types.ts";
export { isAuthorizationPending } from "./types.ts";
