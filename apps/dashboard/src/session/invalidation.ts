import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../api/queries.ts";

/** The one `stream:*` topic this console holds. Named because three files spell it. */
export const CONSOLE_TOPIC = "stream:console";

/**
 * Which queries a pushed topic makes stale.
 *
 * The whole client half of the `res:*` contract is here: a frame says a
 * resource changed, this table says which cached queries that touches, and the
 * ordinary REST hooks fetch it again. No `res:*` frame renders a payload, which
 * is what keeps push and poll from ever disagreeing on those topics — both
 * paths end in the same fetch and the same serializer.
 *
 * ## Prefixes, never enumerated keys
 *
 * Every entry matches a *prefix*. Two of the console's keys are parameterised —
 * `queryKeys.logs(limit)` is `["logs", limit]` and `queryKeys.usage(query)` is
 * six elements long — so a table listing whole keys would have to list every
 * limit and every range the console can ask for, and would go stale the moment
 * a board added one. It would go stale *silently*: the missing key is a panel
 * that stops updating, not an error. react-query's default `refetchType` is
 * `"active"`, so over-invalidating costs one refetch per mounted query and
 * nothing at all for the rest; that is the cheaper side to be wrong on.
 *
 * ## Why `res:logs` carries a predicate
 *
 * `queryKeys.requestBody(id)` is `["logs", "body", id]`, which is under the
 * `["logs"]` prefix and is not a log listing. A captured body is written once at
 * the end of a request and never rewritten, and its query is disabled unless a
 * row is open — so invalidating it means refetching the largest and most
 * sensitive thing this console can ask for, on the hottest topic in the system,
 * for a body that cannot have changed. The predicate excludes it by name.
 */
export const TOPIC_QUERIES: Readonly<Record<string, InvalidateQueryFilters>> = {
  // `["usage", grain, groupBy, splitBy, since, until]` — prefix, six deep.
  "res:usage": { queryKey: ["usage"] },
  "res:logs": {
    predicate: (query) => query.queryKey[0] === "logs" && query.queryKey[1] !== "body",
  },
  // `["credentials"]` covers `["credentials", "health"]`, which is the one that
  // actually moves: the health poller writes it every ten seconds today.
  "res:credentials": { queryKey: queryKeys.credentials },
  "res:keys": { queryKey: queryKeys.keys },
  "res:settings": { queryKey: queryKeys.settings },
  "res:models": { queryKey: queryKeys.models },
  // `["quota-history", credentialId, since, until]` — prefix again.
  "res:quota": { queryKey: ["quota-history"] },
  /**
   * The one `stream:*` topic the console holds, and the one entry here that is
   * *not* what happens on an ordinary frame.
   *
   * A log has no resource to re-read — the frame carries the lines themselves,
   * and `ConsoleBoard` appends them. This entry is the other half of that
   * contract: the answer for when the ring says it can no longer supply what
   * this client missed. `gap` means there is a hole, a hole must never be
   * stitched over silently, and the only honest repair is the whole-window read
   * a poll would have done. It is also what a frame nobody is mounted to
   * receive falls back to; `src/session/stream.tsx` decides between the two.
   */
  [CONSOLE_TOPIC]: { queryKey: ["console"] },
};

/** Sent on every connection when the database underneath was replaced. */
export const GLOBAL_INVALIDATE = "res:*";

const TOPICS = Object.keys(TOPIC_QUERIES);

/**
 * What the client subscribes to, derived from the table rather than listed
 * beside it: the console asks for exactly the topics it knows how to act on, so
 * a subscription with no entry — a frame arriving and nothing happening — is
 * not a state this module can be put into.
 */
export const RES_TOPICS: readonly string[] = TOPICS.filter((topic) => topic.startsWith("res:"));
export const STREAM_TOPICS: readonly string[] = TOPICS.filter((topic) =>
  topic.startsWith("stream:"),
);

/** Acts on one topic. Unknown topics are ignored, not guessed at. */
export function invalidateTopic(client: QueryClient, topic: string): void {
  if (topic === GLOBAL_INVALIDATE) {
    invalidateEverything(client);
    return;
  }
  const filters = TOPIC_QUERIES[topic];
  if (filters === undefined) return;
  void client.invalidateQueries(filters);
}

/**
 * Everything the socket speaks for, used when a reconnecting client cannot know
 * what it missed.
 *
 * Deliberately not `invalidateQueries()` with no argument: a reconnect says
 * nothing about a captured body or about which plugins are installed, and the
 * `res:logs` predicate is the one place that distinction is written down.
 */
export function invalidateEveryTopic(client: QueryClient): void {
  for (const topic of TOPICS) invalidateTopic(client, topic);
}

/**
 * Every query in the cache, for the two cases where that is literally true: the
 * database underneath was replaced, or the session behind every one of these
 * fetches is gone.
 */
export function invalidateEverything(client: QueryClient): void {
  void client.invalidateQueries();
}
