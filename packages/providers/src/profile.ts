import type { ProviderId } from "@omni/ir";
import { anthropicProfile } from "./anthropic/profile.ts";
import { customProfile } from "./custom/profile.ts";
import { grokProfile } from "./grok/profile.ts";
import { type ClientProfile, envOrder } from "./headers.ts";
import { kiloProfile } from "./kilo/profile.ts";
import { kimiProfile } from "./kimi/profile.ts";
import { openaiProfile } from "./openai/profile.ts";

export { ANTHROPIC_CLI_VERSION } from "./anthropic/profile.ts";

/**
 * The type and the header helpers live in `headers.ts` so that each
 * `<id>/profile.ts` can read them without importing this module, which would
 * close a cycle against the assembly below. They are re-exported here because
 * this is the name every caller outside the package already imports.
 */
export {
  type ClientProfile,
  grokHost,
  mergeHeaders,
  orderHeaders,
  stainlessHost,
} from "./headers.ts";

/**
 * Every provider's wire identity, keyed by id.
 *
 * Each profile is defined beside the adapter that wears it; this module only
 * joins them and applies the `OMNI_ORDER_*` overrides. `custom` takes no
 * override because it has no order of its own to override.
 */
export const PROFILES: Readonly<Record<ProviderId, ClientProfile>> = {
  anthropic: {
    ...anthropicProfile,
    order: envOrder("OMNI_ORDER_ANTHROPIC", anthropicProfile.order),
  },
  openai: { ...openaiProfile, order: envOrder("OMNI_ORDER_OPENAI", openaiProfile.order) },
  kimi: { ...kimiProfile, order: envOrder("OMNI_ORDER_KIMI", kimiProfile.order) },
  kilo: { ...kiloProfile, order: envOrder("OMNI_ORDER_KILO", kiloProfile.order) },
  grok: { ...grokProfile, order: envOrder("OMNI_ORDER_GROK", grokProfile.order) },
  custom: customProfile,
};
