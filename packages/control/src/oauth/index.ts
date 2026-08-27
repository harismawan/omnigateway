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
export const OAUTH_PROVIDER_IDS: readonly ProviderId[] = Object.keys(
  OAUTH_PROVIDERS,
) as ProviderId[];

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
