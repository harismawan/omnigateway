import type { ProviderDescriptor } from "../descriptor.ts";
import { GROK_MODELS } from "./models.ts";

export const grokDescriptor: ProviderDescriptor = {
  id: "grok",
  // Every current xAI text model is documented `text, image -> text`. Claiming
  // `images: false` would not be the safe direction: the router drops a target
  // whose provider lacks `images` from any request carrying an image block, so
  // an under-claim makes grok targets vanish the moment a client pastes one.
  capabilities: { tools: true, images: true, reasoning: true },
  anthropicNativeTools: false,
  writeOverInput: { fiveMinute: 0, oneHour: 0 },
  catalog: GROK_MODELS,
  modelPrefixes: ["grok-"],
  // xAI binds an ephemeral loopback port in its own client, which nothing here
  // can reproduce, so the port is the fixed one its local-dev path uses. The
  // `/callback` path is not a guess and must not be "tidied" to match OpenAI's
  // `/auth/callback`: xAI's own client redirects to
  // `http://127.0.0.1:PORT/callback` (`auth/oidc/login.rs`), and redirect URIs
  // are matched exactly, so the wrong path fails at the authorize step rather
  // than at the exchange.
  callback: { uri: "http://127.0.0.1:56121/callback", label: "Grok" },
  presentation: {
    label: "Grok",
    order: 5,
    // Not red: that tone is the failure half of the CLI's `state()`, and a
    // provider name wearing it would read as a broken credential in the same
    // table.
    tone: "yellow",
    // xAI's own identity is achromatic, and the neutral slot is already
    // custom's, so grok takes the widest free arc of the wheel instead: 125 is
    // ~70deg from both anthropic and openai and ~145 from kimi, which is what
    // keeps five series apart in the usage charts.
    colour: { light: "oklch(0.52 0.14 125)", dark: "oklch(0.74 0.14 125)" },
    pasteHint: "Authorize in the browser. When it redirects to 127.0.0.1, paste the whole URL.",
  },
};
