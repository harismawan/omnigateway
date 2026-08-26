import type { ProviderDescriptor } from "../descriptor.ts";
import { ANTHROPIC_MODELS } from "./models.ts";

export const anthropicDescriptor: ProviderDescriptor = {
  id: "anthropic",
  capabilities: { tools: true, images: true, reasoning: true },
  anthropicNativeTools: true,
  // Anthropic bills a 5m write at 1.25x fresh input and a 1h write at 2x. It is
  // the only provider that charges a write premium at all, which is why this
  // figure has to be per provider rather than one constant: guessing this rate
  // for a Kimi target overcharges exactly the tokens its decoder now reports.
  writeOverInput: { fiveMinute: 1.25, oneHour: 2 },
  catalog: ANTHROPIC_MODELS,
};
