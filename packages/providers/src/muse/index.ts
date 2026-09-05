import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { museCodec } from "./codec.ts";
import { decodeMuseResponses } from "./decode.ts";
import { museDescriptor } from "./descriptor.ts";
import { toMuseWire } from "./wire.ts";

/**
 * Muse, served by its codec.
 *
 * Built on the codec contract from the start, so unlike the providers ported
 * onto it there is no earlier hand-written `send()` whose bytes this has to
 * match. The wire is pinned against literals in
 * `packages/providers/test/museCodec.test.ts` instead — written from the
 * dialect the Responses API documents, not captured from a live account.
 */
export const museAdapter: ProviderAdapter = codecAdapter(
  "muse",
  museDescriptor.capabilities,
  museCodec,
);

export { decodeMuseResponses, museCodec, toMuseWire };
