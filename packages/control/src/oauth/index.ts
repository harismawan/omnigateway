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

export type { AuthorizeStart, FlowResult, OAuthDeps, OAuthProvider, PendingFlow } from "./types.ts";
export { isAuthorizationPending } from "./types.ts";
