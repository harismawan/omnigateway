import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { customCodec } from "./codec.ts";
import { customDescriptor } from "./descriptor.ts";

/**
 * A custom OpenAI-compatible endpoint, served by its codec.
 *
 * The last of the six, so `ProviderAdapter` is now one shape with one
 * implementation — `codecAdapter` — rather than a hand-written `send()` per
 * provider plus a bridge for plugins. Bytes pinned in
 * `packages/providers/test/customCodec.test.ts`.
 */
export const customAdapter: ProviderAdapter = codecAdapter(
  "custom",
  customDescriptor.capabilities,
  customCodec,
);

export { customCodec };
