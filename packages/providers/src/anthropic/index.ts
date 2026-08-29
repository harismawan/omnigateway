import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { anthropicCodec } from "./codec.ts";
import { decodeAnthropic } from "./decode.ts";
import { anthropicDescriptor } from "./descriptor.ts";
import { toWire } from "./wire.ts";

/**
 * Anthropic, served by its codec.
 *
 * The third built-in on the codec contract, and the one that decided whether the
 * contract was finished. Kilo and kimi use none of the optional parts; this
 * provider uses all three — `decodeState` for the OAuth tool cloak,
 * `cloakedTools` for its size, `classifyError` for the fingerprint refusal — so
 * converting it was the only way to learn whether those existed in a usable
 * shape or merely a plausible one.
 *
 * **It found one gap, and closing it was the point of doing this before
 * publication.** `CodecErrorInput` carried `body` and not the host's own default
 * error, and what this provider reclassifies is not the body: it is
 * `httpError`'s *parsed* message. Expressing that through the old contract meant
 * re-implementing three extraction rules inside a codec to arrive back at a
 * value the host had already computed. `fallback` is now on that input.
 *
 * **Nothing about the wire changed.** The bytes — header order, the billing
 * block, the `cch` token computed over the finished body, the OAuth system
 * prefix, the cloaked tool names — are pinned against literals in
 * `packages/providers/test/anthropicCodec.test.ts`, captured from the adapter
 * this replaced *before* it was replaced, which is the method kimi's conversion
 * established and kilo's conversion learned the hard way.
 */
export const anthropicAdapter: ProviderAdapter = codecAdapter(
  "anthropic",
  anthropicDescriptor.capabilities,
  anthropicCodec,
);

export { anthropicCodec, decodeAnthropic, toWire };
