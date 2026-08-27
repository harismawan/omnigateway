import { anthropicProfile } from "./anthropic/profile.ts";
import { customProfile } from "./custom/profile.ts";
import { grokProfile } from "./grok/profile.ts";
import type { ClientProfile } from "./headers.ts";
import { kiloProfile } from "./kilo/profile.ts";
import { kimiProfile } from "./kimi/profile.ts";
import { openaiProfile } from "./openai/profile.ts";

// Each profile is also re-exported under its own name, for callers that already
// know which provider they are. An OAuth flow for one provider is not a lookup —
// it is that provider's code, and naming the profile it wears is more honest
// than indexing a table with a constant. It is also the only reading that
// survives the widened `ProviderId` without an assertion: `PROFILES.kilo` is
// `ClientProfile | undefined`, and no check at such a call site could ever fail.
//
// The type and the header helpers live in `headers.ts` so that each
// `<id>/profile.ts` can read them without importing this module, which would
// close a cycle against the assembly below. They are re-exported here because
// this is the name every caller outside the package already imports.
export { ANTHROPIC_CLI_VERSION, anthropicProfile } from "./anthropic/profile.ts";
export { customProfile } from "./custom/profile.ts";
export { grokProfile } from "./grok/profile.ts";
export {
  type ClientProfile,
  grokHost,
  mergeHeaders,
  orderHeaders,
  stainlessHost,
} from "./headers.ts";
export { kiloProfile } from "./kilo/profile.ts";
export { kimiProfile } from "./kimi/profile.ts";
export { openaiProfile } from "./openai/profile.ts";

/**
 * Every provider's wire identity, keyed by id.
 *
 * Each profile is defined beside the adapter that wears it, and applies its own
 * `OMNI_ORDER_*` override there rather than here. An adapter reads its profile
 * directly, so an override applied at this join would be missing from the
 * direct read — differing only on installations that set the variable, which is
 * the shape of bug this repository keeps finding.
 *
 * Nothing keyed on a provider id is exhaustive any more, so this table is a
 * plain `Record<string, …>` and is total by construction rather than by type:
 * it carries exactly the ids assembled below. Callers indexing it get
 * `| undefined` from `noUncheckedIndexedAccess`, which is the point — a stored
 * id can name a provider this installation does not have.
 */
export const PROFILES: Readonly<Record<string, ClientProfile>> = {
  anthropic: anthropicProfile,
  openai: openaiProfile,
  kimi: kimiProfile,
  kilo: kiloProfile,
  grok: grokProfile,
  custom: customProfile,
};
