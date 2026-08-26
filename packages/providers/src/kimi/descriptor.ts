import type { ProviderDescriptor } from "../descriptor.ts";
import { KIMI_MODELS } from "./models.ts";

export const kimiDescriptor: ProviderDescriptor = {
  id: "kimi",
  capabilities: { tools: true, images: false, reasoning: false },
  anthropicNativeTools: false,
  // Caches automatically and bills no write premium.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: KIMI_MODELS,
};
