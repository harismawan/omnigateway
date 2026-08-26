import { CONTEXT_1M_BETA } from "@omni/ir";

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
