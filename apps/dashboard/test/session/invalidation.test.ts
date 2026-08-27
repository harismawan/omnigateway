import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../src/api/queries.ts";
import {
  GLOBAL_INVALIDATE,
  invalidateEveryTopic,
  invalidateTopic,
  RES_TOPICS,
  STREAM_TOPICS,
  TOPIC_QUERIES,
} from "../../src/session/invalidation.ts";

/** The three limits the log board can be switched between. */
const LIMITS = [100, 200, 500] as const;

const USAGE = queryKeys.usage({ groupBy: "day", since: 0 });
const QUOTA = queryKeys.quotaHistory({ credentialId: "cred_1", since: 0 });
const BODY = queryKeys.requestBody("req_1");

/**
 * A cache holding one query of every shape the console asks for, seeded rather
 * than fetched: what is under test is which keys a topic reaches, and a real
 * fetch would only add a stub between the assertion and the answer.
 */
function seeded(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const limit of LIMITS) client.setQueryData(queryKeys.logs(limit), []);
  client.setQueryData(BODY, { requestId: "req_1" });
  client.setQueryData(queryKeys.credentials, []);
  client.setQueryData(queryKeys.credentialHealth, []);
  client.setQueryData(queryKeys.keys, []);
  client.setQueryData(queryKeys.settings, {});
  client.setQueryData(queryKeys.models, []);
  client.setQueryData(queryKeys.plugins, []);
  client.setQueryData(USAGE, []);
  client.setQueryData(QUOTA, []);
  client.setQueryData(["console", 200, ""], { lines: [] });
  return client;
}

const stale = (client: QueryClient, key: readonly unknown[]): boolean =>
  client.getQueryState(key)?.isInvalidated === true;

test("res:logs reaches every limit the log board can be switched to", () => {
  // The reason the table holds prefixes: the limit is part of the key, so an
  // enumerated table would have to list all three and would go quietly stale
  // the day a fourth is offered.
  const client = seeded();

  invalidateTopic(client, "res:logs");

  for (const limit of LIMITS) expect(stale(client, queryKeys.logs(limit))).toBe(true);
});

test("res:logs leaves a captured request body alone", () => {
  // `queryKeys.requestBody` is `["logs", "body", id]` — under the same prefix
  // and not a log listing. A body is written once at the end of its request and
  // never rewritten, and its query is disabled unless a row is open, so
  // refetching it on the hottest topic in the system is pure waste: the largest
  // and most sensitive response this console can ask for, re-fetched to get the
  // same bytes back.
  const client = seeded();

  invalidateTopic(client, "res:logs");

  expect(stale(client, BODY)).toBe(false);
  expect(stale(client, queryKeys.logs(100))).toBe(true);
});

test("res:credentials reaches credential health, which is the part that moves", () => {
  const client = seeded();

  invalidateTopic(client, "res:credentials");

  expect(stale(client, queryKeys.credentialHealth)).toBe(true);
  expect(stale(client, queryKeys.credentials)).toBe(true);
});

test("res:usage reaches a six-element usage key", () => {
  const client = seeded();
  // Stated here rather than assumed: the table's literal prefix and the key
  // builder have to agree, and this is the assertion that notices if one moves.
  expect(USAGE[0]).toBe("usage");

  invalidateTopic(client, "res:usage");

  expect(stale(client, USAGE)).toBe(true);
});

test("res:quota reaches quota history", () => {
  const client = seeded();
  expect(QUOTA[0]).toBe("quota-history");

  invalidateTopic(client, "res:quota");

  expect(stale(client, QUOTA)).toBe(true);
});

test("the single-key topics reach their own key and nothing else", () => {
  for (const [topic, key] of [
    ["res:keys", queryKeys.keys],
    ["res:settings", queryKeys.settings],
    ["res:models", queryKeys.models],
  ] as const) {
    const client = seeded();
    invalidateTopic(client, topic);
    expect(stale(client, key)).toBe(true);
    expect(stale(client, queryKeys.logs(100))).toBe(false);
  }
});

test("stream:console is read as a change signal for the console listing", () => {
  const client = seeded();

  invalidateTopic(client, "stream:console");

  expect(stale(client, ["console", 200, ""])).toBe(true);
});

test("the global topic invalidates everything, captured bodies included", () => {
  // The one case where that is literally true: the database underneath was
  // replaced, so even a body artifact may now belong to a different install.
  const client = seeded();

  invalidateTopic(client, GLOBAL_INVALIDATE);

  expect(stale(client, BODY)).toBe(true);
  expect(stale(client, queryKeys.plugins)).toBe(true);
});

test("a reconnect invalidates every topic without touching a captured body", () => {
  // A reconnect says the console missed announcements; it says nothing about an
  // immutable artifact or about which plugins are installed, neither of which
  // any topic can change.
  const client = seeded();

  invalidateEveryTopic(client);

  expect(stale(client, queryKeys.logs(500))).toBe(true);
  expect(stale(client, USAGE)).toBe(true);
  expect(stale(client, queryKeys.credentialHealth)).toBe(true);
  expect(stale(client, BODY)).toBe(false);
  expect(stale(client, queryKeys.plugins)).toBe(false);
});

test("an unknown topic changes nothing", () => {
  const client = seeded();

  invalidateTopic(client, "res:something-a-later-gateway-emits");

  expect(stale(client, queryKeys.logs(100))).toBe(false);
  expect(stale(client, queryKeys.credentials)).toBe(false);
});

test("the console subscribes to exactly the topics it can act on", () => {
  // Derived, not listed twice: a subscription with no table entry would be a
  // frame arriving and nothing happening, which is indistinguishable from a
  // quiet gateway.
  expect([...RES_TOPICS].sort()).toEqual(
    Object.keys(TOPIC_QUERIES)
      .filter((topic) => topic.startsWith("res:"))
      .sort(),
  );
  expect(STREAM_TOPICS).toEqual(["stream:console"]);
  expect(RES_TOPICS).toContain("res:usage");
  expect(RES_TOPICS).not.toContain(GLOBAL_INVALIDATE);
});

/**
 * The client branch's keys ride the same topics.
 *
 * A client session holds `res:usage` and `res:logs` and nothing else, so those
 * two entries are the whole of what keeps that screen fresh. An entry covering
 * only the console's key would leave the client subscribed to a frame that does
 * nothing — and the symptom is silence, which is indistinguishable from a quiet
 * gateway.
 */
const CLIENT_USAGE = queryKeys.clientUsage({ groupBy: "model", since: 0 });
const CLIENT_LOGS = queryKeys.clientLogs(50);

function seededClient(): QueryClient {
  const client = seeded();
  client.setQueryData(queryKeys.clientSummary, {});
  client.setQueryData(CLIENT_USAGE, []);
  client.setQueryData(CLIENT_LOGS, []);
  client.setQueryData(queryKeys.clientQuota, []);
  return client;
}

test("res:usage reaches the client's usage and its key summary", () => {
  const client = seededClient();

  invalidateTopic(client, "res:usage");

  expect(stale(client, CLIENT_USAGE)).toBe(true);
  // `limitUsage` is computed from usage rows, so this frame is when it moves.
  // It rides this topic and not `res:keys`, which a client is not subscribed to.
  expect(stale(client, queryKeys.clientSummary)).toBe(true);
  // Still reaches the console's own key: the topic names a resource, and both
  // branches read it.
  expect(stale(client, USAGE)).toBe(true);
});

test("res:logs reaches the client's log page", () => {
  const client = seededClient();

  invalidateTopic(client, "res:logs");

  expect(stale(client, CLIENT_LOGS)).toBe(true);
  expect(stale(client, queryKeys.logs(100))).toBe(true);
});

test("res:usage leaves the client's quota alone, which is why that one polls", () => {
  const client = seededClient();

  invalidateTopic(client, "res:usage");

  // Provider headroom does not move when this key serves a request, and a
  // client cannot hold `res:quota`. The board polls it instead, and this pins
  // the reason.
  expect(stale(client, queryKeys.clientQuota)).toBe(false);
});
