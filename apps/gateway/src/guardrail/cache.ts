import type { Verdict } from "./classifier.ts";

/** How long a verdict is reused. An hour covers an agent's tool loop on one human message. */
export const VERDICT_TTL_MS = 3_600_000;

/**
 * How many verdicts one process keeps. A key is a 64-character digest and a
 * value one word, so the bound is about memory only in the sense that it has
 * one; ten thousand distinct human messages inside an hour is a busy gateway.
 */
export const VERDICT_CACHE_MAX = 10_000;

/** What a verdict is keyed on: everything that, changed, could change the answer. */
export type VerdictKeyParts = {
  apiKeyId: string;
  policy: string;
  model: string;
  /** All of it *after* truncation, which is the text the classifier saw. */
  system: string;
  /** Every judged human message, oldest first, as `JudgedText.human` holds them. */
  human: readonly string[];
};

/**
 * One digest over every part, structured by JSON — the messages as an array,
 * never joined — so no two different tuples, and no two splits of the same
 * text into messages, can serialise to the same input. Editing the policy, the
 * classifier model, or the history-turn setting where it changes which
 * messages are judged therefore misses naturally, and nothing ever needs
 * invalidating. Hashed so the cache holds no request text.
 */
export function verdictKey(parts: VerdictKeyParts): string {
  return Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify([parts.apiKeyId, parts.policy, parts.model, parts.system, parts.human]),
    "hex",
  );
}

/**
 * Process-local, bounded LRU of classifier verdicts.
 *
 * An agent client re-sends the same human messages on every tool turn —
 * dozens of times — and without this each of those turns pays a classifier call.
 * Holds allow **and** deny; never a failure, because a failure retried on the
 * next turn may succeed. Process-local is acceptable in a cluster: a miss costs
 * one call, never a wrong verdict.
 */
export class VerdictCache {
  readonly #entries = new Map<string, { verdict: Verdict; expiresAt: number }>();
  readonly #max: number;
  readonly #ttlMs: number;

  constructor(opts: { max?: number; ttlMs?: number } = {}) {
    this.#max = opts.max ?? VERDICT_CACHE_MAX;
    this.#ttlMs = opts.ttlMs ?? VERDICT_TTL_MS;
  }

  get(key: string, now: number): Verdict | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    // Re-inserted so `Map` order is recency order and the oldest is evicted.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.verdict;
  }

  set(key: string, verdict: Verdict, now: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { verdict, expiresAt: now + this.#ttlMs });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }
}
