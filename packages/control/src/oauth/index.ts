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
