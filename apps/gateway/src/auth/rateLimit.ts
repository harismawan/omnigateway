import { GatewayError } from "@omni/ir";

const WINDOW_MS = 60_000;

type Window = { startedAt: number; count: number };

/** In-memory fixed-window limiter. JavaScript run-to-completion makes consume atomic. */
export class ApiKeyRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number) {}

  consume(keyId: string, limit: number | null): void {
    if (limit === null) return;

    const now = this.now();
    this.cleanup(now);
    const startedAt = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const current = this.windows.get(keyId);
    const window =
      current === undefined || current.startedAt !== startedAt ? { startedAt, count: 0 } : current;

    if (window.count >= limit) {
      throw new GatewayError("RATE_LIMIT", "API key rate limit exceeded", {
        retryAfterMs: startedAt + WINDOW_MS - now,
      });
    }

    window.count++;
    this.windows.set(keyId, window);
  }

  private cleanup(now: number): void {
    for (const [keyId, window] of this.windows) {
      if (window.startedAt + WINDOW_MS <= now) this.windows.delete(keyId);
    }
  }
}
