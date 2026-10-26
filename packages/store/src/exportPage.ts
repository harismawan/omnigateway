import type { ExportPageQuery } from "./types.ts";

/**
 * The export cursor's read, shared by both stores for the reason `logPage.ts`
 * is: the predicate is the contract — the keyset step, the inclusive settle
 * bound, what an empty filter list means — and one source cannot disagree with
 * itself. `placeholder(n)` renders the n-th (1-based) bound parameter.
 *
 * The keyset is a row-value comparison, which both engines seek on
 * `idx_request_logs_completed (completed_at, id)`; the `OR` spelling `scan`
 * uses would leave Postgres filtering instead of seeking.
 *
 * `from` is the dialect's other difference: SQLite pins the cursor's index
 * (`EXPORT_FROM` in `sqlite/usage.ts`); Postgres has no hint to give.
 */
export function exportPageSql(
  q: ExportPageQuery,
  placeholder: (index: number) => string,
  from = "request_logs",
): { sql: string; bindings: Array<string | number> } {
  const bindings: Array<string | number> = [];
  const bind = (value: string | number): string => {
    bindings.push(value);
    return placeholder(bindings.length);
  };
  const list = (values: readonly string[]): string => values.map(bind).join(", ");

  const clauses = [
    "state = 'done'",
    "completed_at IS NOT NULL",
    `completed_at <= ${bind(q.settledBefore)}`,
    `(completed_at, id) > (${bind(q.after.completedAt)}, ${bind(q.after.id)})`,
  ];

  // A present but empty list selects nothing: the operator named a set with no
  // one in it, which is not the same as naming no set. `IN ()` is not SQL, so
  // that case is spelled as a false clause.
  const { apiKeyIds, models, failedOnly } = q.filter ?? {};
  if (apiKeyIds !== undefined) {
    clauses.push(apiKeyIds.length === 0 ? "1 = 0" : `api_key_id IN (${list(apiKeyIds)})`);
  }
  if (models !== undefined) {
    clauses.push(
      models.length === 0
        ? "1 = 0"
        : `(requested_model IN (${list(models)}) OR resolved_model IN (${list(models)}))`,
    );
  }
  if (failedOnly === true) clauses.push("status >= 400");

  const sql = `SELECT * FROM ${from}
                WHERE ${clauses.join(" AND ")}
                ORDER BY completed_at, id
                LIMIT ${bind(q.limit)}`;
  return { sql, bindings };
}
