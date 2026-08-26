import type { ProviderDescriptor } from "../descriptor.ts";
import { GROK_MODELS } from "./models.ts";

export const grokDescriptor: ProviderDescriptor = {
  id: "grok",
  // Every current xAI text model is documented `text, image -> text`. Claiming
  // `images: false` would not be the safe direction: the router drops a target
  // whose provider lacks `images` from any request carrying an image block, so
  // an under-claim makes grok targets vanish the moment a client pastes one.
  capabilities: { tools: true, images: true, reasoning: true },
  anthropicNativeTools: false,
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: GROK_MODELS,
};
