/**
 * The wire format of `/api/stream`, and the one place untrusted JSON is read.
 *
 * Frames are JSON. Two topic classes, and the class is the delivery contract
 * rather than a hint about it:
 *
 * **`res:<name>` — invalidation.** The payload carries at most `{ keys }`. No
 * sequencing, no replay, no ordering guarantee. A dropped frame is self-healing:
 * the next change re-invalidates, and a reconnecting client invalidates
 * everything before it resubscribes. This class exists so that push and poll
 * cannot disagree — both paths end in the same REST fetch and the same
 * serializer, so there is no second rendering of any resource and no bug where
 * the socket shows one number and a reload shows another.
 *
 * **`stream:<name>` — payload.** A monotonic `seq` per topic over a bounded
 * ring. A subscriber that has fallen off the back of the ring is told `gap` and
 * refetches. **Never claim gapless.** A bounded ring plus an explicit `gap` is
 * the entire contract, and silent skipping is the failure this class exists to
 * prevent.
 *
 * **`plugin:<id>:<name>`** is either class, owned by a plugin through the
 * `channels` capability. The `<id>` is supplied by the host from the manifest
 * and never by the plugin, so a plugin cannot name another plugin's topic.
 */

/** What a client may send. Anything else is refused by `parseClientFrame`. */
export type ClientFrame =
  | { id?: string; type: "subscribe"; topic: string; sinceSeq?: number }
  | { id?: string; type: "unsubscribe"; topic: string }
  | { id?: string; type: "send"; topic: string; payload?: unknown };

/** What the server sends. */
export type ServerFrame =
  | { type: "event"; topic: string; seq?: number; payload?: unknown }
  | { type: "ack"; id?: string; topic: string }
  | { type: "error"; id?: string; topic?: string; message: string }
  | { type: "gap"; topic: string; seq: number };

export type TopicClass = "res" | "stream" | "plugin";

/**
 * Which contract a topic name carries, or `null` when it names none.
 *
 * Unknown prefixes are refused rather than defaulted. A topic that fell through
 * to the invalidation class would be a stream that silently stopped sequencing,
 * which is exactly the failure `gap` exists to make visible.
 */
export function topicClass(topic: string): TopicClass | null {
  if (topic.startsWith("res:") && topic.length > 4) return "res";
  if (topic.startsWith("stream:") && topic.length > 7) return "stream";
  // `plugin:<id>:<name>` — both halves required, so `plugin:foo` is not a topic.
  if (topic.startsWith("plugin:")) {
    const rest = topic.slice(7);
    const colon = rest.indexOf(":");
    return colon > 0 && colon < rest.length - 1 ? "plugin" : null;
  }
  return null;
}

/** Bounds a topic name so a client cannot make the topic index grow by asking. */
const MAX_TOPIC = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one client frame, or `null` when it is not one.
 *
 * Every field is checked rather than coerced. A `sinceSeq` of `"12"` is not a
 * sequence number: coercing it would let a malformed client silently replay
 * from somewhere it did not ask for, and replaying from the wrong point is
 * indistinguishable at the far end from the gap this protocol promises to
 * report.
 */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (!isRecord(raw)) return null;

  const { id, type, topic } = raw;
  if (id !== undefined && typeof id !== "string") return null;
  if (typeof topic !== "string" || topic.length === 0 || topic.length > MAX_TOPIC) return null;
  if (topicClass(topic) === null) return null;

  const head = id === undefined ? { topic } : { id, topic };

  if (type === "unsubscribe") return { ...head, type: "unsubscribe" };
  if (type === "send") {
    return "payload" in raw
      ? { ...head, type: "send", payload: raw.payload }
      : { ...head, type: "send" };
  }
  if (type === "subscribe") {
    const { sinceSeq } = raw;
    if (sinceSeq === undefined) return { ...head, type: "subscribe" };
    if (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq) || sinceSeq < 0) return null;
    return { ...head, type: "subscribe", sinceSeq };
  }
  return null;
}
