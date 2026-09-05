import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { antigravityCodec } from "./codec.ts";
import { decodeAntigravityStream } from "./decode.ts";
import { antigravityDescriptor } from "./descriptor.ts";
import { toAntigravityWire } from "./wire.ts";

/** Antigravity, served by its codec. */
export const antigravityAdapter: ProviderAdapter = codecAdapter(
  "antigravity",
  antigravityDescriptor.capabilities,
  antigravityCodec,
);

export { antigravityCodec, decodeAntigravityStream, toAntigravityWire };
