import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { RequestLogPage, RequestLogQuery, Store } from "@omni/store";
import { memoryStore, requestLog, seedApiKey } from "@omni/testkit";
import {
  csvCell,
  decodeLogCursor,
  EXPORT_CONTENT_TYPE,
  encodeLogCursor,
  exportFilename,
  exportLogs,
  exportRow,
  pageLogs,
} from "../src/logs.ts";
import { type Principal, scopeOf } from "../src/principal.ts";

const NOW = 1_800_000_000_000;
const MACHINE: Principal = { kind: "machine", tokenId: "t1", pluginId: "p1" };

/** Records what reached the repo, so a test can assert on the query and not only the rows. */
function spying(store: Store): { store: Store; queries: RequestLogQuery[] } {
  const queries: RequestLogQuery[] = [];
  const inner = store.usage.page.bind(store.usage);
  const usage: Store["usage"] = {
    ...store.usage,
    page: (query: RequestLogQuery): Promise<RequestLogPage> => {
      queries.push(query);
      return inner(query);
    },
  };
  return { store: { ...store, usage }, queries };
}

async function seeded() {
  const store = await memoryStore();
  const mine = await seedApiKey(store, { label: "mine" });
  const theirs = await seedApiKey(store, { label: "theirs" });
  await store.usage.append(requestLog({ id: "m1", at: NOW - 3_000, apiKeyId: mine.key.id }));
  await store.usage.append(requestLog({ id: "t1", at: NOW - 2_000, apiKeyId: theirs.key.id }));
  await store.usage.append(requestLog({ id: "m2", at: NOW - 1_000, apiKeyId: mine.key.id }));
  return { store, mine, theirs };
}

test("a cursor survives a round trip and is opaque in both directions", async () => {
  const cursor = { at: NOW, id: "req-1" };
  const wire = encodeLogCursor(cursor);
  expect(decodeLogCursor(wire)).toEqual(cursor);
  // Opaque to a reader, but not encrypted and not claimed to be: base64url of
  // JSON. What matters is that no caller is invited to construct one.
  expect(wire).not.toContain("req-1");
});

/**
 * Every way a cursor can be wrong, and none of them silently restarts.
 *
 * A traversal handed the head again reads as having reached the end of the
 * history, which is the one failure an operator walking an incident cannot
 * detect from the output.
 */
test("a malformed cursor is refused rather than treated as the first page", async () => {
  const { store } = await seeded();
  const bad = [
    "not base64!!",
    Buffer.from("not json").toString("base64url"),
    Buffer.from("[1,2,3]").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from('{"v":1,"at":1}').toString("base64url"),
    Buffer.from('{"v":1,"at":1,"id":"a","extra":2}').toString("base64url"),
    Buffer.from('{"v":1,"at":1.5,"id":"a"}').toString("base64url"),
    Buffer.from('{"v":1,"at":"1","id":"a"}').toString("base64url"),
    Buffer.from('{"v":1,"at":1,"id":""}').toString("base64url"),
    Buffer.from(`{"v":1,"at":1,"id":"${"x".repeat(129)}"}`).toString("base64url"),
    // Trailing junk on an otherwise valid cursor. `Buffer.from(raw,
    // "base64url")` ignores it, so without the canonical re-encode check this
    // decodes cleanly and the wire form stops being the only accepted spelling.
    `${encodeLogCursor({ at: NOW, id: "m1" })}!!!`,
    // Same fields, different key order: still not a string this gateway minted.
    Buffer.from('{"at":1,"id":"a","v":1}').toString("base64url"),
  ];
  for (const cursor of bad) {
    const attempt = pageLogs(store, { cursor });
    await expect(attempt).rejects.toThrow(GatewayError);
    await expect(attempt).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

test("a cursor from a future version is named as such, not guessed at", async () => {
  const { store } = await seeded();
  const next = Buffer.from('{"v":2,"at":1,"id":"a"}').toString("base64url");
  await expect(pageLogs(store, { cursor: next })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("version"),
  });
});

test("an unknown filter is refused rather than ignored", async () => {
  const { store } = await seeded();
  // A misspelled filter that is merely dropped produces a page the operator
  // reads as "no matches" when the truth is "that filter never ran".
  await expect(
    pageLogs(store, { resolvedMdoel: "fast" } as unknown as Record<string, string>),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("an inverted interval is refused rather than returning nothing", async () => {
  const { store } = await seeded();
  await expect(pageLogs(store, { since: NOW, until: NOW - 1 })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

/**
 * A bound that does not parse is refused, never defaulted.
 *
 * Read as `0` — which is what a fallback gives — the bound is the epoch, so the
 * interval silently widens to every row still retained. On an export, whose
 * range is the only thing bounding it at all, that turns one mistyped character
 * into a download of the whole history under the range the operator believed
 * they had asked for.
 */
test("an unparseable time bound is refused rather than read as the epoch", async () => {
  const { store } = await seeded();
  const spy = spying(store);
  const bad = [
    "tomorrow",
    "NaN",
    "Infinity",
    "1.5",
    "9007199254740993",
    // Every one of these is `Number()`-coercible, which is why a coercing schema
    // is no better than the fallback it replaced: a bound of one space arrives
    // as 0, and 0 is the epoch.
    " ",
    "\t",
    "0x10",
    "1e3",
    "  42  ",
    "+1",
  ];
  for (const bound of bad) {
    await expect(pageLogs(spy.store, { since: bound })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(pageLogs(spy.store, { until: bound })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }
  // Refused before the read, not after it: a query that reached the store would
  // have run over the whole retention window on the way to the error.
  expect(spy.queries).toHaveLength(0);

  // The export is where this matters most: the interval is the only thing
  // bounding it, so a bound read as 0 is a download of the whole retention
  // window. A single space passes a `!== ""` required-bound check, which is why
  // that check is not what refuses it.
  const exported = async (since: string): Promise<string[]> => {
    const out: string[] = [];
    for await (const chunk of exportLogs(spy.store, { since, until: String(NOW) })) {
      out.push(chunk);
    }
    return out;
  };
  for (const since of ["tomorrow", " "]) {
    await expect(exported(since)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(spy.queries).toHaveLength(0);
});

test("the limit is clamped rather than trusted", async () => {
  const { store } = await seeded();
  const spy = spying(store);
  for (const [sent, expected] of [
    ["0", 1],
    ["-5", 1],
    ["100000", 500],
    ["abc", 100],
  ] as const) {
    await pageLogs(spy.store, { limit: sent });
    expect(spy.queries.at(-1)?.limit).toBe(expected);
  }
});

/**
 * Every filter the wire accepts has to reach the store.
 *
 * `toQuery` copies them across one key at a time, and a key it forgets is a
 * filter the schema accepts, the URL carries, and nothing ever applies — a page
 * of unfiltered rows the operator reads as the answer to the question they
 * asked. `.strict()` cannot catch it: the parameter *is* known, it is just
 * dropped on the way through. Asserted as a set rather than one key at a time so
 * a filter added to the schema and not to `toQuery` fails here.
 */
test("every accepted filter reaches the store query", async () => {
  const { store } = await seeded();
  const spy = spying(store);

  await pageLogs(spy.store, {
    state: "done",
    failed: "true",
    provider: "anthropic",
    requestedModel: "opus",
    resolvedModel: "claude-opus-5",
    model: "sonnet",
    credentialId: "cred-1",
    apiKeyId: "key-1",
    errorCode: "UPSTREAM",
    since: "1",
    until: "2",
  });

  expect(spy.queries.at(-1)).toEqual({
    limit: 100,
    cursor: null,
    state: "done",
    failed: true,
    provider: "anthropic",
    requestedModel: "opus",
    resolvedModel: "claude-opus-5",
    model: "sonnet",
    credentialId: "cred-1",
    apiKeyId: "key-1",
    errorCode: "UPSTREAM",
    since: 1,
    until: 2,
  });
});

test("a client reads only its own rows, and a key filter cannot widen that", async () => {
  const { store, mine, theirs } = await seeded();
  const spy = spying(store);
  const scope = scopeOf({ kind: "client", apiKeyId: mine.key.id });

  const own = await pageLogs(spy.store, {}, scope);
  expect(own.logs.map((row) => row.id).sort()).toEqual(["m1", "m2"]);

  // The session's key is written after the caller's, so a client naming
  // somebody else's key gets its own rows rather than theirs. The client route
  // also refuses the parameter outright; this is the second of the two gates.
  const attempted = await pageLogs(spy.store, { apiKeyId: theirs.key.id }, scope);
  expect(attempted.logs.map((row) => row.id).sort()).toEqual(["m1", "m2"]);
  expect(spy.queries.at(-1)?.apiKeyId).toBe(mine.key.id);
});

test("a scope that reads nothing never reaches the repo", async () => {
  const { store } = await seeded();
  const spy = spying(store);
  const page = await pageLogs(spy.store, {}, scopeOf(MACHINE));
  expect(page).toEqual({ logs: [], nextCursor: null });
  // `scopeKey` collapses `all` and `none` to the same `undefined`, so a reader
  // that asked it first would hand a machine principal every row in the log.
  expect(spy.queries).toHaveLength(0);
});

test("a scope that reads nothing still refuses a malformed cursor", async () => {
  const { store } = await seeded();
  // Otherwise a client's bad cursor reads as the end of its own history.
  await expect(pageLogs(store, { cursor: "!!!" }, scopeOf(MACHINE))).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("admin and viewer read the same rows", async () => {
  const { store } = await seeded();
  const admin = await pageLogs(store, {}, scopeOf({ kind: "admin" }));
  const viewer = await pageLogs(store, {}, scopeOf({ kind: "viewer" }));
  expect(viewer).toEqual(admin);
});

test("failed=false is dropped rather than inverted", async () => {
  const { store } = await seeded();
  const spy = spying(store);
  await pageLogs(spy.store, { failed: "false" });
  // "Not failed" and "succeeded" differ on every pending row, and only one of
  // them is a question the console's control can ask.
  expect(spy.queries.at(-1)).not.toHaveProperty("failed");
});

test("paging walks the whole history without repeating or dropping a row", async () => {
  const { store } = await seeded();
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page: Awaited<ReturnType<typeof pageLogs>> = await pageLogs(store, {
      limit: 1,
      ...(cursor === undefined ? {} : { cursor }),
    });
    seen.push(...page.logs.map((row) => row.id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  expect(seen).toEqual(["m2", "t1", "m1"]);
});

/**
 * A spreadsheet reading `=1+cmd|'/c calc'!A1` out of an unquoted cell executes
 * it, and a request log carries client-supplied model names and upstream error
 * text. CSV is deliberately not byte-exact for such values; JSONL is the
 * lossless format, which is why both exist.
 */
test("csv neutralises formulas and quotes by RFC 4180", () => {
  expect(csvCell("=1+1")).toBe("'=1+1");
  expect(csvCell("  @SUM(A1)")).toBe("'  @SUM(A1)");
  expect(csvCell("+1")).toBe("'+1");
  expect(csvCell("-1")).toBe("'-1");
  expect(csvCell("fast")).toBe("fast");
  expect(csvCell(null)).toBe("");
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell("a,b")).toBe('"a,b"');
  expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  expect(csvCell(["a", "b"])).toBe('"[""a"",""b""]"');
});

test("jsonl is lossless, one object per line, in a stable key order", () => {
  const log = requestLog({ id: "r1", at: NOW, errorCode: "=cmd", degradations: ["a:b"] });
  const line = exportRow("jsonl", log);
  expect(line.endsWith("\n")).toBe(true);
  expect(line.trimEnd()).not.toContain("\n");

  const parsed: unknown = JSON.parse(line);
  // Every column survives verbatim, formula-shaped text included: neutralising
  // it here would make the lossless format lossy.
  expect(parsed).toMatchObject({ id: "r1", errorCode: "=cmd", degradations: ["a:b"] });
  expect(Object.keys(parsed as Record<string, unknown>)[0]).toBe("id");
  expect(Object.keys(parsed as Record<string, unknown>)).toEqual(
    Object.keys(JSON.parse(exportRow("jsonl", requestLog({ id: "r2" }))) as object),
  );
});

test("an export requires both bounds", async () => {
  const { store } = await seeded();
  for (const input of [{}, { since: 0 }, { until: NOW }]) {
    // The one read here with no page size to bound it, so the interval bounds
    // it instead. An export with no range asks for the whole retention window.
    await expect(exportLogs(store, input).next()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }
});

test("an export streams a header and every matching row", async () => {
  const { store } = await seeded();
  const chunks: string[] = [];
  for await (const chunk of exportLogs(store, { since: 0, until: NOW, format: "csv" })) {
    chunks.push(chunk);
  }
  const text = chunks.join("");
  const lines = text.split("\r\n").filter((line) => line.length > 0);
  expect(lines[0]?.startsWith("id,state,at,")).toBe(true);
  expect(lines).toHaveLength(4);
  expect(text.endsWith("\r\n")).toBe(true);
});

test("an export is scoped like a page, and a scope reading nothing writes only a header", async () => {
  const { store, mine } = await seeded();
  const own: string[] = [];
  for await (const chunk of exportLogs(
    store,
    { since: 0, until: NOW, format: "jsonl" },
    scopeOf({ kind: "client", apiKeyId: mine.key.id }),
  )) {
    own.push(chunk);
  }
  expect(own.filter((line) => line.length > 0)).toHaveLength(2);
  expect(own.join("")).not.toContain('"id":"t1"');

  const none: string[] = [];
  for await (const chunk of exportLogs(store, { since: 0, until: NOW }, scopeOf(MACHINE))) {
    none.push(chunk);
  }
  expect(none.join("").split("\r\n").filter(Boolean)).toHaveLength(1);
});

/**
 * A walk longer than one batch, drained to the end.
 *
 * The cancellation test below stops at the first batch on purpose, and the
 * streaming test above fits in one page — so between them, an export that ended
 * after 500 rows, skipped the first row of the second batch or served a boundary
 * row twice would pass both. This is the case that reads every page.
 */
test("an export walks past its batch size without dropping or repeating a row", async () => {
  const store = await memoryStore();
  const ids: string[] = [];
  for (let i = 0; i < 501; i += 1) {
    // Descending `at`, so seeding order is the order they come back in.
    await store.usage.append(requestLog({ id: `r${i}`, at: NOW - i }));
    ids.push(`r${i}`);
  }
  const spy = spying(store);

  const lines: string[] = [];
  for await (const chunk of exportLogs(spy.store, { since: 0, until: NOW, format: "jsonl" })) {
    if (chunk.length > 0) lines.push(chunk);
  }

  expect(lines).toHaveLength(501);
  expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids);
  // Two reads for 501 rows at a batch of 500, and the second is what carries the
  // cursor: one read would mean a truncated export, three a re-read.
  expect(spy.queries).toHaveLength(2);
  expect(spy.queries[1]?.cursor).toMatchObject({ id: "r499" });
});

/**
 * The first page is read before the header is yielded.
 *
 * The route pulls one chunk before it builds a response, so which of the two
 * comes first decides whether an unreadable store is a status or a `200` that
 * downloads as a header-only file. A CSV holding nothing but its header opens as
 * a complete export reading "no request matched", which is indistinguishable
 * from a successful empty range.
 */
test("an unreadable store fails before the header rather than halfway through", async () => {
  const store = await memoryStore();
  const failing: Store = {
    ...store,
    usage: {
      ...store.usage,
      page: (): Promise<RequestLogPage> => Promise.reject(new Error("database is closed")),
    },
  };
  const rows = exportLogs(failing, { since: 0, until: NOW });
  await expect(rows.next()).rejects.toThrow("database is closed");
});

/**
 * Cancellation is the generator's own: a consumer that stops iterating stops
 * the paging, which is why there is no second mechanism for a client hanging up
 * mid-download. Seeded past one batch so "stopped" is distinguishable from
 * "there was nothing more anyway".
 */
test("an abandoned export stops paging rather than draining the window", async () => {
  const store = await memoryStore();
  for (let i = 0; i < 501; i += 1) {
    await store.usage.append(requestLog({ id: `r${i}`, at: NOW - i }));
  }
  const spy = spying(store);
  const rows = exportLogs(spy.store, { since: 0, until: NOW });
  await rows.next();
  await rows.next();
  expect(spy.queries).toHaveLength(1);

  await rows.return(undefined);
  expect(await rows.next()).toMatchObject({ done: true });
  // The second batch, which a generator run to completion would have read, was
  // never asked for.
  expect(spy.queries).toHaveLength(1);
});

test("the download name is the server's, and the content types are the registered ones", () => {
  // No caller-supplied text reaches a `content-disposition` header.
  expect(exportFilename("csv", Date.UTC(2026, 0, 2, 3, 4, 5))).toBe(
    "omnigateway-logs-2026-01-02T03-04-05-000Z.csv",
  );
  expect(EXPORT_CONTENT_TYPE.csv).toBe("text/csv; charset=utf-8");
  expect(EXPORT_CONTENT_TYPE.jsonl).toBe("application/x-ndjson");
});
