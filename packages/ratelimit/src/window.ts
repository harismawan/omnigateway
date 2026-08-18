/**
 * An exact sliding count of event timestamps.
 *
 * Exact rather than approximated because at the size this is used for — sixty
 * requests in a minute is sixty numbers — precision is free, so it is not
 * traded away. It is also bounded by the limit it serves: a caller that counts
 * before it records never records past the ceiling.
 *
 * `now` is a parameter on every method. This package holds no clock, and a
 * window that read one would be untestable without scaffolding.
 */
export class SlidingWindow {
  /** Ascending, because every event is appended at the newest end. */
  private stamps: number[] = [];

  constructor(readonly windowMs: number) {}

  /**
   * Drops what has aged out, then reports what is left.
   *
   * An event exactly `windowMs` old is out: the window is the half-open
   * interval `(now - windowMs, now]`, so a key limited per minute is free of a
   * request the instant a minute has passed and not a tick before.
   */
  count(now: number): number {
    const cutoff = now - this.windowMs;
    let aged = 0;
    for (const stamp of this.stamps) {
      if (stamp > cutoff) break;
      aged++;
    }
    if (aged > 0) this.stamps = this.stamps.slice(aged);
    return this.stamps.length;
  }

  record(now: number): void {
    this.stamps.push(now);
  }

  /**
   * When the oldest event still held ages out, which is the earliest instant a
   * key at its ceiling regains a slot. `now` when nothing is held.
   *
   * Reads what `count` last left behind, so call it after `count(now)` or it
   * answers for a window that has not been trimmed.
   */
  resetAt(now: number): number {
    const oldest = this.stamps[0];
    return oldest === undefined ? now : oldest + this.windowMs;
  }

  /** True once nothing is held, so a caller can drop the whole entry. */
  get empty(): boolean {
    return this.stamps.length === 0;
  }
}
