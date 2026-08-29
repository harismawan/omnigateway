import { codecAdapter } from "../codecAdapter.ts";
import type { ProviderAdapter } from "../types.ts";
import { kiloCodec } from "./codec.ts";
import { decodeKiloChat } from "./decode.ts";
import { kiloDescriptor } from "./descriptor.ts";
import { toKiloWire } from "./wire.ts";

/**
 * Kilo, served by its codec.
 *
 * The first built-in on the codec contract, and the conversion the design that
 * introduced that contract said it was for: "the contract below is intended to
 * become the shape of every adapter, built-in and plugin alike"
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`).
 * Until this landed the repository carried two provider shapes at once, which is
 * the drift that effort exists to remove — a rule that holds for a plugin and
 * not for a built-in is one a contributor is entitled to read as optional.
 *
 * **Nothing about the wire changed**, and that is the property to preserve. The
 * hand-written `send()` this replaces read the credential, built a body, built
 * headers, picked a URL, called `http` once, checked the status and decoded the
 * stream. `kiloCodec` is the first four of those and `codecAdapter` is the last
 * three — the same steps in the same order, with the middle ones now written
 * once for every provider instead of once per provider.
 *
 * The parity that made this safe was asserted while both existed:
 * `kiloCodec.test.ts` compared the two byte for byte, across both credential
 * shapes and both streaming shapes. That comparison went with the adapter it
 * compared against — two implementations are what made it meaningful — so the
 * wire is pinned there against literals instead. Read those before changing
 * anything in `codec.ts`: this provider's upstream fingerprints its clients, so
 * header *order* is behaviour rather than style.
 */
export const kiloAdapter: ProviderAdapter = codecAdapter(
  "kilo",
  kiloDescriptor.capabilities,
  kiloCodec,
);

export { decodeKiloChat, kiloCodec, toKiloWire };
