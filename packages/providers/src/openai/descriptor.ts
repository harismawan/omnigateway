import type { ProviderDescriptor } from "../descriptor.ts";
import { OPENAI_MODELS } from "./models.ts";

export const openaiDescriptor: ProviderDescriptor = {
  id: "openai",
  capabilities: { tools: true, images: true, reasoning: true },
  // Caches automatically and bills no write premium.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: OPENAI_MODELS,
  modelPrefixes: ["gpt-", "o1", "o3", "o4"],
  callback: { uri: "http://localhost:1455/auth/callback", label: "OpenAI" },
  presentation: {
    label: "OpenAI",
    order: 2,
    tone: "green",
    colour: { light: "oklch(0.5 0.09 190)", dark: "oklch(0.76 0.1 190)" },
    pasteHint: "Authorize in the browser. When it redirects to localhost, paste the whole URL.",
  },
};
