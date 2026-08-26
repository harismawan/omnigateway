import type { ProviderDescriptor } from "../descriptor.ts";
import { CUSTOM_MODELS } from "./models.ts";

export const customDescriptor: ProviderDescriptor = {
  id: "custom",
  capabilities: { tools: true, images: true, reasoning: true },
  anthropicNativeTools: false,
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: CUSTOM_MODELS,
};
