import type { ProviderDescriptor } from "../descriptor.ts";
import { ANTIGRAVITY_MODELS } from "./models.ts";

export const antigravityDescriptor: ProviderDescriptor = {
  id: "antigravity",
  // Gemini is multimodal on every row in the catalog, and the reasoning tiers
  // are what the model ids are named after. Claiming `images: false` would not
  // be the safe direction — the router drops a target whose provider lacks
  // `images` from any request carrying an image block, so an under-claim makes
  // antigravity targets vanish the moment a client pastes a screenshot.
  capabilities: { tools: true, images: true, reasoning: true },
  // The client cannot ask for a cache write on this surface: Cloud Code caches
  // whatever it caches and reports the read back in `cachedContentTokenCount`.
  // Zero is therefore a real price rather than a missing one.
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: ANTIGRAVITY_MODELS,
  // Only `gemini-`. The same backend serves Claude and GPT-OSS models, which the
  // catalog deliberately omits — `claude-` belongs to anthropic here, and a bare
  // name cannot say which of two providers should answer for it.
  modelPrefixes: ["gemini-"],
  // Antigravity's own hosted callback, which its CLI (`agy` 1.1.27) uses against
  // this same client id. A loopback redirect was here first and worked, but it
  // assumes a browser on the gateway's own machine — which a container or a
  // remote install does not have, and where the consent screen was observed to
  // hang with nothing in the address bar to paste. This page loads wherever the
  // operator approves, so the URL is always there to copy.
  //
  // **Not swappable on its own: the hosted callback requires PKCE**, measured
  // both ways in `antigravity/oauth.ts`'s header. Reverting this line without
  // reverting the code challenge fails at the authorize step.
  callback: { uri: "https://antigravity.google/oauth-callback", label: "Antigravity" },
  presentation: {
    label: "Antigravity",
    // Before `custom`, which stays last: it is the "none of the above" row
    // rather than a vendor, so a new vendor takes the rank it was holding.
    order: 6,
    // The seventh provider needs a seventh tone, and the basic eight-colour set
    // ran out at six once red was reserved for failure. `output.ts` already grew
    // by one 256-colour entry for that reason; this is the second, and it is
    // named for the hue below so the console and the terminal agree.
    tone: "violet",
    // 277 is the middle of the widest arc left between the *saturated* provider
    // hues — anthropic 45, grok 125, openai 190, kilo 224, kimi 330 — which
    // leaves 224→330 as the only gap wider than 80 degrees. Custom sits at 258
    // and is not a competitor for it: at chroma 0.03 against 0.14 it reads as
    // the grey it is meant to be, and the two are told apart by saturation
    // rather than by hue.
    colour: { light: "oklch(0.52 0.14 277)", dark: "oklch(0.74 0.14 277)" },
    // The ordinary "paste the whole URL" hint, which this provider could not
    // give while it redirected to a loopback: the consent screen was observed to
    // hang on a LAN origin when the loopback was unreachable from the approving
    // browser, leaving nothing in the address bar. The hosted callback removes
    // that failure — the page loads for any browser — so no machine is named
    // here any more and no port needs forwarding.
    pasteHint:
      "Approve in any browser, then paste the whole URL it lands on. A code shown on its own works too.",
  },
};
