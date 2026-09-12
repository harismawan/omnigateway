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
 * The only thing the backends do differ on is placeholder syntax, so that is
 * the one thing passed in: `placeholder(n)` renders the n-th (1-based) bound
 * parameter — `"?"` for SQLite, `"$n"` for Postgres. No stored value is ever
 * interpolated.
 */
export function logPageClauses(
  query: RequestLogQuery,
  placeholder: (index: number) => string,
): { where: string; bindings: Array<string | number | boolean> } {
  const clauses: string[] = [];
  const bindings: Array<string | number | boolean> = [];

  const bind = (value: string | number): string => {
    bindings.push(value);
    return placeholder(bindings.length);
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

  // `= ?` never matches NULL, so an anonymous row falls out of a key-scoped read
  // on its own — the same property `recent` relies on, and the wanted answer:
  // an untagged request belongs to no key, so no key may read it.
  eq("api_key_id", query.apiKeyId);
  eq("credential_id", query.credentialId);
  eq("resolved_provider", query.provider);
  eq("requested_model", query.requestedModel);
  eq("resolved_model", query.resolvedModel);
  eq("error_code", query.errorCode);
  eq("state", query.state);

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
