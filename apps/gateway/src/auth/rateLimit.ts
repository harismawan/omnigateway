import { GatewayError } from "@omni/ir";
import { evaluate, retryAfterMs, SlidingWindow } from "@omni/ratelimit";
import { type LimitConfig, WINDOW_MS } from "@omni/ratelimit/catalog";

/**
 * In-memory sliding-window limiter. JavaScript run-to-completion makes consume
 * atomic.
 *
 * The arithmetic lives in `@omni/ratelimit`, which holds no state and no clock;
 * the rings live here, because a ring is state. The split is what lets the
 * boundary behaviour be unit-tested without a gateway, a store, or a clock.
 *
 * Enforces `requests` at `1m` only. The remaining dimensions and the long
 * windows need a store read and a debit hook, which is a later stage; a key that
 * configures them is not refused, it is simply not yet limited by them.
 *
 * Process-local, and reset on restart.
 */
export class ApiKeyRateLimiter {
  private readonly rings = new Map<string, SlidingWindow>();

  constructor(private readonly now: () => number) {}

  consume(keyId: string, limits: LimitConfig): void {
    const limit = limits.requests?.["1m"] ?? null;
    // An unlimited key allocates nothing, so an install that sets no limits
    // pays no memory for the mechanism.
    if (limit === null) return;

    const now = this.now();
    this.cleanup(now);

    const ring = this.rings.get(keyId) ?? new SlidingWindow(WINDOW_MS["1m"]);
    const used = ring.count(now);
    const decision = evaluate(
      { requests: { "1m": limit } },
      { requests: { "1m": { used, resetAt: ring.resetAt(now) } } },
      now,
    );

    if (decision.violation !== null) {
      throw new GatewayError("RATE_LIMIT", "API key rate limit exceeded", {
        retryAfterMs: retryAfterMs(decision.violation, now),
      });
    }

    ring.record(now);
    this.rings.set(keyId, ring);
  }

  /**
   * Drops keys whose window has drained, so a key that stopped calling stops
   * costing anything. `count` does the trimming, so this is also what keeps a
   * busy key's ring from growing past its own ceiling.
   */
  private cleanup(now: number): void {
    for (const [keyId, ring] of this.rings) {
      ring.count(now);
      if (ring.empty) this.rings.delete(keyId);
    }
  }
}
