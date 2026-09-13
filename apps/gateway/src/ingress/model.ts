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
 * The 1M-context marker an operator types after a model name.
 *
 * Claude Code strips it before sending, so this only fires for a client that
 * passes the string through verbatim. Accepting it here means one rule covers
 * both.
 *
 * Why an operator types it at all is a client-side matter the gateway never
 * sees: for a pool id Claude Code's built-in table does not know, it assumes a
 * 200k window and auto-compacts there, and the suffix is what lifts that.
 * Measured at 2.1.270 — `--model fable` warns and assumes 200k, `--model
 * 'fable[1m]'` does not warn, and `model=fable` reaches the wire either way.
 * That effect is entirely in the client; nothing below produces it.
 *
 * What it folds into is now inert, and the fold is kept anyway. At Claude Code
 * 2.1.226 the suffix also became a `context-1m-2025-08-07` header, which is why
 * this function produces one; current Claude Code documents only the strip, and
 * the beta no longer moves any ceiling. Measured 2026-09-13 against
 * `claude-sonnet-4-5-20250929`: an over-long prompt is refused with
 * `1251325 tokens > 200000 maximum` whether or not the header is sent, while
 * `claude-sonnet-5` reports `> 1000000 maximum` with no header at all. So 1M is
 * a property of the model, and the beta buys nothing on any model in the
 * catalog.
 *
 * Kept because removing it would silently change behaviour for the one case
 * still live — an operator's own model id, which `catalogLimits` knows nothing
 * about and the Anthropic encoder therefore does not strip the beta from — and
 * because a caller that sends the header directly is unaffected by anything
 * here. Delete both this and `CONTEXT_1M_BETA` only once no such target can
 * exist.
 */
const ONE_M_SUFFIX = "[1m]";

/**
 * Resolves a client-supplied model name to the virtual model it names.
 *
 * Called during parsing, which is what puts it before the API-key model
 * allowlist: the allowlist is enforced against `ChatRequest.model`, so anything
 * this rewrites has to be rewritten before the key policy reads it.
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

  // The suffix and the header are the same request. Folding one into the other
  // means the encoders have a single thing to gate on, rather than two spellings
  // of it that can disagree.
  const merged = [...betas];
  if (wantsOneM && !merged.includes(CONTEXT_1M_BETA)) merged.push(CONTEXT_1M_BETA);
  return { model, betas: merged };
}
