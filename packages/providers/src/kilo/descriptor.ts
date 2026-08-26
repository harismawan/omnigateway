import type { ProviderDescriptor } from "../descriptor.ts";
import { KILO_MODELS } from "./models.ts";

export const kiloDescriptor: ProviderDescriptor = {
  id: "kilo",
  // Kilo fronts Claude, GPT and Gemini, all of which accept images and emit
  // reasoning. Under-claiming is not the safe direction: the router drops a
  // target whose provider lacks `images` from any request carrying an image
  // block, so an under-claim makes kilo targets vanish the moment a client
  // pastes a screenshot.
  capabilities: { tools: true, images: true, reasoning: true },
  // Kilo speaks the OpenAI chat completions wire even for the Anthropic models
  // it fronts, so an Anthropic-defined tool or native block excludes it.
  anthropicNativeTools: false,
  // Kilo fronts several vendors at once, so no single multiple is right for it.
  // Zero is the safe fallback rather than the accurate one: the chat wire it
  // speaks cannot express a cache breakpoint at all, so a Kilo request never
  // buys a cache entry to be charged for.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: KILO_MODELS,
};
