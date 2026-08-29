import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { openaiCodec } from "./codec.ts";
import { decodeResponses } from "./decode.ts";
import { openaiDescriptor } from "./descriptor.ts";
import { toResponsesWire } from "./wire.ts";

/**
 * OpenAI, served by its codec.
 *
 * Bytes pinned in `packages/providers/test/openaiCodec.test.ts` against a
 * capture taken from the hand-written adapter before it was replaced.
 */
export const openaiAdapter: ProviderAdapter = codecAdapter(
  "openai",
  openaiDescriptor.capabilities,
  openaiCodec,
);

export { decodeResponses, openaiCodec, toResponsesWire };
