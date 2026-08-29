import type { ProviderDescriptor } from "../descriptor.ts";
import { KIMI_MODELS } from "./models.ts";

export const kimiDescriptor: ProviderDescriptor = {
  id: "kimi",
  capabilities: { tools: true, images: false, reasoning: false },
  // Caches automatically and bills no write premium.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: KIMI_MODELS,
  modelPrefixes: ["kimi-", "moonshot"],
  presentation: {
    label: "Kimi",
    order: 3,
    tone: "blue",
    colour: { light: "oklch(0.53 0.17 330)", dark: "oklch(0.72 0.16 330)" },
    pasteHint: "Enter the code on Kimi's device page. This dialog finishes on its own.",
  },
};
