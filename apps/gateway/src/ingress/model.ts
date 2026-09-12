/**
 * How long a model name may be.
 *
 * Not a formatting rule: `requested_model` and `resolved_model` are columns on
 * `request_logs`, and both are `ON CONFLICT` key columns of `usage_rollup` and
 * `usage_daily`. An unbounded name therefore persists whatever the client sent
 * — on a *succeeding* request, past `bodyLoggingOptOut`, and into the snapshot,
 * which this repository states is "never a prompt corpus". `resolveModel`
 * splits on `/` and `:` and keeps the remainder as a synthesized target's
 * model, so prose arrives here intact.
 *
 * Two hundred characters is far past every real spelling — pooled, prefixed,
 * dated, `[1m]`-suffixed — and far short of a prompt. Capping the *render* was
 * not enough and is not the fix: the bound has to be at the write, because the
 * same value keys the rollup.
 */
export const MODEL_NAME_MAX = 200;

import { CONTEXT_1M_BETA } from "@omni/ir";

/**
 * The prefix `GET /v1/models` puts on a discovery mirror.
 *
 * Claude Code's model picker lists only ids beginning with `claude` or
 * `anthropic`, so a pool named `opus` or `gpt-5.6-sol` is invisible to it. The
 * listing therefore advertises a mirrored id, and this is where the mirror is
 * unwound again.
 *
 * The separator is a slash rather than a hyphen for a reason that is easy to
 * lose: the client ignores `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for any id starting
 * with `claude-`, so a mirror spelled that way would be visible in the picker
 * and permanently stuck at the 200K default.
 *
 * Unconditional. The mirror was once gated on `OMNI_EXPOSE_CLAUDE_CODE_ALIASES`,
 * and a gate is what made it worth deleting: a listing rule and an ingress rule
 * that must agree, both reachable only when an operator found the variable. On
 * by default they are one rule with one spelling, and `modelSchema` reserving
 * the namespace is what keeps this strip from eating a real pool's name.
 */
const DISCOVERY_PREFIX = "claude/";

/**
 * The 1M-context marker an operator types after a model name.
 *
 * Claude Code strips it before sending and turns it into a header, so this only
 * fires for a client that passes the string through verbatim. Accepting it here
 * means one rule covers both.
 */
const ONE_M_SUFFIX = "[1m]";

/**
 * Resolves a client-supplied model name to the virtual model it names.
 *
 * Called during parsing, which is what puts it *before* the API-key model
 * allowlist: the allowlist is enforced against `ChatRequest.model`, so a key
 * denied `gpt-5.6-sol` is equally denied `claude/gpt-5.6-sol`. Unwinding the
 * mirror any later would turn it into a way around the policy.
 */
export function normalizeClientModel(
  raw: string,
  betas: readonly string[] = [],
): { model: string; betas: string[] } {
  let model = raw.trim();
  let wantsOneM = false;

  if (model.toLowerCase().endsWith(ONE_M_SUFFIX)) {
    const stripped = model.slice(0, -ONE_M_SUFFIX.length).trim();
    // A model named nothing but the suffix is not a model; leave it alone and
    // let resolution fail on the name the caller actually sent.
    if (stripped.length > 0) {
      model = stripped;
      wantsOneM = true;
    }
  }

  if (model.toLowerCase().startsWith(DISCOVERY_PREFIX)) {
    const stripped = model.slice(DISCOVERY_PREFIX.length);
    if (stripped.length > 0) model = stripped;
  }

  // The suffix and the header are the same request. Folding one into the other
  // means the encoders have a single thing to gate on, rather than two spellings
  // of it that can disagree.
  const merged = [...betas];
  if (wantsOneM && !merged.includes(CONTEXT_1M_BETA)) merged.push(CONTEXT_1M_BETA);
  return { model, betas: merged };
}
