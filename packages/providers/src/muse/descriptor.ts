import type { ProviderDescriptor } from "../descriptor.ts";
import { MUSE_MODELS } from "./models.ts";

export const museDescriptor: ProviderDescriptor = {
  id: "muse",
  capabilities: { tools: true, images: true, reasoning: true },
  // Caches automatically and bills no write premium; the catalog prices cache
  // reads at the published rate rather than a fraction of input.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: MUSE_MODELS,
  modelPrefixes: ["muse-", "muse-spark"],
  presentation: {
    label: "Muse",
    order: 7,
    tone: "azure",
    // Meta blue, #0866FF.
    colour: { light: "oklch(0.55 0.23 262)", dark: "oklch(0.72 0.17 262)" },
    pasteHint: "Enter the code on Meta's device page. This dialog finishes on its own.",
  },
};
