import type { ProviderId } from "@omni/ir";
import { anthropicAdapter } from "./anthropic/index.ts";
import { customAdapter } from "./custom/index.ts";
import { grokAdapter } from "./grok/index.ts";
import { kimiAdapter } from "./kimi/index.ts";
import { openaiAdapter } from "./openai/index.ts";
import type { ProviderAdapter } from "./types.ts";

export const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  kimi: kimiAdapter,
  grok: grokAdapter,
  custom: customAdapter,
};
