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
    // In place, rather than `slice` into a fresh array.
    //
    // The saving is narrower than it looks and the first version of this
    // comment overstated it: both forms sit behind this same `aged > 0`, so the
    // old `slice` allocated only when something actually aged out, never on the
    // common no-op path. What this removes is one array allocation on the
    // trimming path, for the same O(n) move of the survivors.
    if (aged > 0) this.stamps.splice(0, aged);
    return this.stamps.length;
  }

  record(now: number): void {
    this.stamps.push(now);
  }

  /**
   * Drops one event recorded at `at`, for a caller giving back a slot it took.
   *
   * A caller that records before it judges — which is how concurrent callers see
   * each other rather than one shared pre-burst snapshot — has to undo the
   * record when it refuses. Exactly one stamp goes, so a concurrent caller that
   * recorded the same instant keeps its own slot; which of two equal numbers is
   * removed is not a distinction the data can carry, and the scan runs from the
   * newest end only because the stamps are ascending and it can stop early.
   *
   * Silent when there is no such stamp: it aged out while the caller was
   * deciding, so the slot it is giving back has already been given back.
   */
  forget(at: number): void {
    for (let index = this.stamps.length - 1; index >= 0; index--) {
      const stamp = this.stamps[index];
      if (stamp === undefined || stamp < at) return;
      if (stamp === at) {
        this.stamps.splice(index, 1);
        return;
      }
    }
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
