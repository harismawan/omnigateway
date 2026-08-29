import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { grokCodec } from "./codec.ts";
import { decodeGrokResponses } from "./decode.ts";
import { grokDescriptor } from "./descriptor.ts";
import { toGrokWire } from "./wire.ts";

/**
 * Grok, served by its codec.
 *
 * Bytes pinned in `packages/providers/test/grokCodec.test.ts` against a capture
 * taken from the hand-written adapter before it was replaced.
 */
export const grokAdapter: ProviderAdapter = codecAdapter(
  "grok",
  grokDescriptor.capabilities,
  grokCodec,
);

export { decodeGrokResponses, grokCodec, toGrokWire };
