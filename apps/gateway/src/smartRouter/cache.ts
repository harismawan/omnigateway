import { createHash } from "node:crypto";
import type { VerdictCache } from "../guardrail/cache.ts";
import type { Confidentiality } from "./classifier.ts";

/** The process-local cache of segment verdicts, keyed by `segmentKey`. */
export type ConfidentialityCache = VerdictCache<Confidentiality>;

/**
 * What a segment's verdict is keyed on: everything that, changed, could change
 * the answer. Not the API key — the policy is global, so the verdict on a text
 * is the same for every key. One digest over a JSON array, never a join, so no
 * two different tuples can serialise to the same input; hashed so the cache
 * holds no request text. Editing the policy or the classifier model misses
 * naturally, and nothing ever needs invalidating.
 */
export function segmentKey(classifierModel: string, policy: string, segment: string): string {
  return createHash("sha256")
    .update(JSON.stringify([classifierModel, policy, segment]))
    .digest("hex");
}
