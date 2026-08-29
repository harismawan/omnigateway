import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { kimiCodec } from "./codec.ts";
import { decodeChat } from "./decode.ts";
import { kimiDescriptor } from "./descriptor.ts";
import { toChatWire } from "./wire.ts";

/**
 * Kimi, served by its codec.
 *
 * The second built-in on the codec contract, after kilo. Four hand-written
 * `send()` implementations remain; each one that stays is a second provider
 * shape in a repository whose plugin capability can only offer the first, and a
 * rule that holds for a plugin and not a built-in is one a contributor is
 * entitled to read as optional.
 *
 * **Nothing about the wire changed.** The bytes this provider puts on the socket
 * — including the device identity read off the credential, and the position it
 * takes in the header order — are pinned against literals in
 * `packages/providers/test/kimiCodec.test.ts`, captured from the adapter this
 * replaced *before* it was replaced. That ordering is the point: parity asserted
 * against an implementation that still exists is evidence, and the same
 * assertion after the conversion would compare the codec with itself.
 */
export const kimiAdapter: ProviderAdapter = codecAdapter(
  "kimi",
  kimiDescriptor.capabilities,
  kimiCodec,
);

export { decodeChat, kimiCodec, toChatWire };
