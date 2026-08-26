import type { ProviderDescriptor } from "../descriptor.ts";
import { OPENAI_MODELS } from "./models.ts";

export const openaiDescriptor: ProviderDescriptor = {
  id: "openai",
  capabilities: { tools: true, images: true, reasoning: true },
  anthropicNativeTools: false,
  // Caches automatically and bills no write premium.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: OPENAI_MODELS,
};
