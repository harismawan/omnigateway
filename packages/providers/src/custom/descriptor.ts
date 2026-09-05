import type { ProviderDescriptor } from "../descriptor.ts";
import { CUSTOM_MODELS } from "./models.ts";

export const customDescriptor: ProviderDescriptor = {
  id: "custom",
  capabilities: { tools: true, images: true, reasoning: true },
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: CUSTOM_MODELS,
  // None, and it could not have any: a custom target is identified by its
  // endpoint id as well as its provider, and a bare model name carries no way
  // to say which endpoint it means.
  modelPrefixes: [],
  presentation: {
    label: "OpenAI Compatible",
    // Last, and it moves down whenever a vendor is added: this row is "none of
    // the above" rather than a provider, so it belongs after every named one.
    order: 8,
    tone: "cyan",
    colour: { light: "oklch(0.5 0.03 258)", dark: "oklch(0.72 0.03 258)" },
    pasteHint: "Enter endpoint metadata and API key.",
  },
};
