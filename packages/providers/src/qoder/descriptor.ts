import type { ProviderDescriptor } from "../descriptor.ts";
import { QODER_MODELS } from "./models.ts";
export const qoderDescriptor: ProviderDescriptor = {
  id: "qoder",
  capabilities: { tools: true, images: true, reasoning: true },
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: QODER_MODELS,
  modelPrefixes: [],
  presentation: {
    label: "Qoder",
    order: 8,
    tone: "violet",
    colour: { light: "oklch(0.52 0.18 300)", dark: "oklch(0.74 0.16 300)" },
    pasteHint: "Approve Qoder in the browser. This dialog finishes on its own.",
  },
};
