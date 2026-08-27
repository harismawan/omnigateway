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
  // None, and not an oversight: Kilo fronts other vendors' models under their
  // own names, so a bare `claude-…` or `gpt-…` names the vendor rather than
  // Kilo. Reaching Kilo means configuring a target that says so.
  modelPrefixes: [],
  presentation: {
    label: "Kilo",
    order: 4,
    // Deliberately nowhere near kimi's blue: the two names are one letter apart
    // and print next to each other, so hue is the only thing separating them at
    // a glance.
    tone: "orange",
    // Kilo takes the arc between openai and the accent: 224 is ~34deg from
    // openai and ~38 from the accent blue, and — the point — 106 from kimi.
    // Kimi and kilo are one letter apart and sit next to each other in every
    // list the console draws, so they are the one pair that must not also be
    // neighbours in hue. The other free arc, ~296, is 34 from kimi and would
    // have done the opposite.
    colour: { light: "oklch(0.52 0.14 224)", dark: "oklch(0.74 0.14 224)" },
    pasteHint: "Approve the code on Kilo's device page. This dialog finishes on its own.",
  },
};
