/**
 * Bounded replay for `stream:*` topics.
 *
 * A reconnecting subscriber asks `subscribe { topic, sinceSeq }` and gets back
 * either the frames it missed or an explicit `gap`. There is no third answer,
 * and in particular there is no "here is what I still have, good luck": a
 * partial replay is indistinguishable at the far end from a complete one, so a
 * ring that answered with whatever it happened to retain would turn a bounded
 * buffer into silent data loss.
 *
 * Bounded two ways. Frame count stops a chatty topic, and a byte cap stops a
 * topic whose frames are individually large — a console emitting one 2 MiB
 * stack trace should not pin megabytes per topic just because it emitted one
 * frame.
 */

export type RingSlice =
  | { kind: "frames"; frames: readonly RingFrame[] }
  | { kind: "gap"; seq: number };

export type RingFrame = { seq: number; payload: unknown };

export type RingLimits = {
  /** Most frames retained per topic. */
  frames: number;
  /** Most bytes retained per topic, measured on the serialised payload. */
  bytes: number;
};

export type Ring = {
  /**
   * Appends and returns the sequence number assigned.
   *
   * With `seq`, records under a number issued elsewhere — the fleet's counter
   * — and moves the topic's head to it. A frame behind the head is dropped:
   * it was delivered before this process subscribed, and recording it would
   * put the ring out of order.
   */
  push(topic: string, payload: unknown, seq?: number): number;
  /** What a subscriber that last saw `sinceSeq` has missed. */
  since(topic: string, sinceSeq: number): RingSlice;
  /** The highest sequence number issued for a topic; 0 when it has none. */
  head(topic: string): number;
  /**
   * Forgets a topic's history without resetting its sequence.
   *
   * For a source that lost continuity rather than one that ended — a log file
   * truncated under a watcher. The sequence keeps climbing, so every existing
   * subscriber's `sinceSeq` now falls before the oldest retained frame and each
   * is told `gap`, which is exactly true.
   */
  reset(topic: string): void;
  drop(topic: string): void;
};

type Entry = { seq: number; payload: unknown; bytes: number };

type TopicState = { entries: Entry[]; bytes: number; seq: number };

function sizeOf(payload: unknown): number {
  try {
    // An approximation on purpose: the cap bounds memory, and paying for an
    // exact byte count of every frame on the way in costs more than the bound
    // is worth.
    return JSON.stringify(payload)?.length ?? 0;
  } catch {
    // Circular or otherwise unserialisable. It cannot go on the wire either,
    // but that is the sender's problem to report; here it simply counts as
    // nothing so a bad frame cannot evict good ones.
    return 0;
  }
}

export function createRing(limits: RingLimits): Ring {
  const topics = new Map<string, TopicState>();

  const stateFor = (topic: string): TopicState => {
    const existing = topics.get(topic);
    if (existing !== undefined) return existing;
    const created: TopicState = { entries: [], bytes: 0, seq: 0 };
    topics.set(topic, created);
    return created;
  };

  return {
    push(topic, payload, seq) {
      const state = stateFor(topic);
      if (seq !== undefined && seq <= state.seq) return state.seq;
      state.seq = seq ?? state.seq + 1;
      const bytes = sizeOf(payload);
      state.entries.push({ seq: state.seq, payload, bytes });
      state.bytes += bytes;

      while (
        state.entries.length > limits.frames ||
        (state.bytes > limits.bytes && state.entries.length > 1)
      ) {
        // `length > 1` guards the byte cap only: a single frame larger than the
        // whole cap is still the newest thing on the topic, and evicting it
        // would leave a subscriber that is perfectly current unable to be told
        // anything but `gap`.
        const evicted = state.entries.shift();
        if (evicted === undefined) break;
        state.bytes -= evicted.bytes;
      }
      return state.seq;
    },

    since(topic, sinceSeq) {
      const state = topics.get(topic);
      if (state === undefined) {
        // Never pushed. A subscriber claiming to have seen frames on a topic
        // that has issued none is out of step with the server, not merely
        // up to date.
        return sinceSeq === 0 ? { kind: "frames", frames: [] } : { kind: "gap", seq: 0 };
      }
      if (sinceSeq > state.seq) return { kind: "gap", seq: state.seq };
      if (sinceSeq === state.seq) return { kind: "frames", frames: [] };

      const oldest = state.entries[0];
      // Nothing retained, but frames were issued: everything the caller missed
      // has been evicted.
      if (oldest === undefined) return { kind: "gap", seq: state.seq };
      // The next frame the caller needs is `sinceSeq + 1`. If the oldest frame
      // still held is later than that, the ones in between are gone — and
      // returning what remains would be the silent skip this class forbids.
      if (oldest.seq > sinceSeq + 1) return { kind: "gap", seq: state.seq };

      return {
        kind: "frames",
        frames: state.entries
          .filter((entry) => entry.seq > sinceSeq)
          .map(({ seq, payload }) => ({ seq, payload })),
      };
    },

    head(topic) {
      return topics.get(topic)?.seq ?? 0;
    },

    reset(topic) {
      const state = topics.get(topic);
      if (state === undefined) return;
      state.entries = [];
      state.bytes = 0;
    },

    drop(topic) {
      topics.delete(topic);
    },
  };
}
