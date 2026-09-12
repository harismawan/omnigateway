import type { RequestLogCursor, RequestLogQuery } from "./types.ts";

/**
 * The `WHERE` fragments and bindings for one `RequestLogQuery`, shared by both
 * stores.
 *
 * Written once here rather than twice in the repos because the predicate *is*
 * the contract — the keyset comparison, the inclusive time bounds, the meaning
 * of `failed` — and two hand-written copies of it would be two chances to get
 * the tie-break or a boundary wrong in only one backend. The contract suite
 * runs against both, but a suite proves what it was told to ask; a single
 * source cannot disagree with itself in the first place.
 *
 * The backends differ on two things, so those are the two things passed in.
 * `placeholder(n)` renders the n-th (1-based) bound parameter — `"?"` for
 * SQLite, `"$n"` for Postgres. `like` is the case-insensitive containment
 * operator, and it differs because the defaults do: SQLite's `LIKE` folds ASCII
 * case already, Postgres' does not and spells the folding one `ILIKE`. Passing
 * it keeps the two from quietly answering differently — a suite that tests
 * `opus` against `opus` would never notice. No stored value is ever
 * interpolated.
 */
export function logPageClauses(
  query: RequestLogQuery,
  placeholder: (index: number) => string,
  like = "LIKE",
): { where: string; bindings: Array<string | number | boolean> } {
  const clauses: string[] = [];
  const bindings: Array<string | number | boolean> = [];

  const bind = (value: string | number): string => {
    bindings.push(value);
    return placeholder(bindings.length);
  };

  /**
   * A substring match on a column an operator typed into.
   *
   * `_` and `%` are escaped rather than passed through, because they are LIKE's
   * own wildcards and they occur in real values: every error code is spelled
   * `ALL_CANDIDATES_FAILED`, so an unescaped filter for `ALL_CANDIDATES` also
   * matched `ALLXCANDIDATESXFAILED`. Measured, not theorised. The backslash
   * itself is escaped first, or escaping would be defeated by typing one.
   *
   * `ESCAPE` is named explicitly: SQLite has no default escape character at all,
   * and Postgres' default backslash is not something to inherit silently.
   */
  const contains = (column: string, value: string | undefined): void => {
    if (value === undefined) return;
    const escaped = value.replace(/[\\%_]/g, "\\$&");
    clauses.push(`${column} ${like} ${bind(`%${escaped}%`)} ESCAPE '\\'`);
  };
  const eq = (column: string, value: string | number | undefined): void => {
    if (value !== undefined) clauses.push(`${column} = ${bind(value)}`);
  };

  // The keyset step, and the reason the ID is in it: `at` alone repeats within a
  // millisecond, so a page boundary landing inside such a group either loses the
  // rest of it (`<`) or serves the whole group again (`<=`). Comparing the pair
  // is exact at any traffic rate.
  if (query.cursor !== null) {
    const cursor: RequestLogCursor = query.cursor;
    clauses.push(
      `(at < ${bind(cursor.at)} OR (at = ${bind(cursor.at)} AND id < ${bind(cursor.id)}))`,
    );
  }

  // **These four stay `=`, and not out of consistency.** `api_key_id` is how a
  // client scope is enforced — `scopeKey` writes the session's own key into this
  // query — and under a substring match the scope `key-1` would also read
  // `key-12`'s rows. The other three are values a caller picks from a list the
  // gateway handed them rather than types, so matching substrings would widen
  // them without ever helping anybody. `= ?` also never matches NULL, so an
  // anonymous row falls out of a key-scoped read on its own — the same property
  // `recent` relies on, and the wanted answer: an untagged request belongs to no
  // key, so no key may read it.
  eq("api_key_id", query.apiKeyId);
  eq("credential_id", query.credentialId);
  eq("resolved_provider", query.provider);
  eq("state", query.state);

  // The typed filters match substrings, because an exact match on a name nobody
  // recalls exactly is a filter that answers "no such traffic" for every
  // spelling but one. `claude-opus-5` is what the log holds and `opus` is what
  // the operator has; both find it now.
  //
  // Applied before the page limit like every other filter, which is the whole
  // difference between this and the substring box the investigation spec
  // removed. That one matched a *fetched tail*, so it answered "among the newest
  // N rows" while reading as "in the log". Same predicate, different place.
  contains("requested_model", query.requestedModel);
  contains("resolved_model", query.resolvedModel);
  contains("error_code", query.errorCode);

  // Either name, because an operator naming a model cannot know which of the two
  // columns their spelling lives in. `AND`ed with the rest like every other
  // filter, so combining it with a narrow one stays a narrowing.
  if (query.model !== undefined) {
    const before = clauses.length;
    contains("requested_model", query.model);
    contains("resolved_model", query.model);
    // Spliced back off and re-joined, so the escaping and the operator have one
    // source: these two halves are `OR`ed with each other where every other
    // clause is `AND`ed, so they cannot be left on the list flat.
    clauses.push(`(${clauses.splice(before).join(" OR ")})`);
  }

  // Inclusive, because an operator copying an instant out of a row and pasting
  // it into `since` means "from this request onward" and would otherwise get
  // everything but it.
  if (query.since !== undefined) clauses.push(`at >= ${bind(query.since)}`);
  if (query.until !== undefined) clauses.push(`at <= ${bind(query.until)}`);

  // A *completed* row with an error status. `state` is load-bearing: a pending
  // row's `status` is a placeholder zero, not a measurement, and a future
  // `failed: false` arm reading this predicate inverted would call every
  // in-flight request a success. Which is why there is no such arm — `false` is
  // dropped by the caller rather than negated here.
  if (query.failed === true) clauses.push("state = 'done' AND status >= 400");

  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, bindings };
}

/**
 * Splits `limit + 1` fetched rows into a page and the cursor after it.
 *
 * Asking for one row more than the page is what lets a full final page report
 * no next cursor: without the extra row, "exactly `limit` rows came back" is
 * indistinguishable from "there are more", and the caller is handed a cursor
 * whose page is empty.
 */
export function splitPage<T extends { at: number; id: string }>(
  rows: T[],
  limit: number,
): { logs: T[]; next: RequestLogCursor | null } {
  if (rows.length <= limit) return { logs: rows, next: null };
  const logs = rows.slice(0, limit);
  const last = logs[logs.length - 1];
  return { logs, next: last === undefined ? null : { at: last.at, id: last.id } };
}
