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
  // Google accepts **any** loopback port for an installed-app client, so unlike
  // grok's — which reproduces a port xAI's own binary hardcodes — this number is
  // arbitrary and nothing binds it. What matters is only that the same value
  // reaches both the authorize call and the token exchange.
  callback: { uri: "http://127.0.0.1:51121/callback", label: "Antigravity" },
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
    // **Not the usual "paste the whole URL" hint, and the difference is
    // load-bearing.** For every other redirect provider here the browser is
    // expected to fail to reach the loopback, leaving the code in the address
    // bar for the operator to copy. Google's consent for this client has been
    // observed to behave differently on a LAN origin: when the loopback is not
    // reachable from the approving browser, the screen can hang without ever
    // redirecting, so there is nothing in the address bar to paste. omniroute
    // 3.8.49 records both that failure and that dropping `openid` and PKCE is
    // what stopped it happening — its two comments do not fully agree on
    // whether any case remains. The hint therefore names the remedy that works
    // in either reading: approve from a browser that can reach the gateway's
    // own loopback, forwarding the port if the gateway is remote.
    pasteHint:
      "Approve in a browser on the gateway's own machine — or SSH-forward port 51121 first. When it redirects to 127.0.0.1, paste the whole URL.",
  },
};
