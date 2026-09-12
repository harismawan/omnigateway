import { exportLogs, type LogFilterInput, pageLogs, queryUsage } from "@omni/control";
import type { RequestLog, RequestLogCursor } from "@omni/store";
import { boolFlag, numberFlag, type Parsed, stringFlag, UsageError } from "../args.ts";
import { type Command, state } from "../command.ts";
import { emit, formatTime, formatUsd, paint, table } from "../output.ts";
import { serviceLogs } from "../service.ts";
import { FOLLOW_INTERVAL_MS } from "./console.ts";

/** Accepts an epoch millisecond value or anything `Date` understands. */
function instant(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new UsageError(`could not read "${raw}" as a time`);
  return parsed;
}

export const usage: Command = {
  usage: "usage [--grain daily|raw] [--by DIMENSION] [--since T] [--until T]",
  summary: "Aggregate spend and tokens",
  options: {
    grain: { type: "string" },
    by: { type: "string" },
    split: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
  },
  async run(args, { ctx, writer }) {
    const until = instant(stringFlag(args.values, "until"), ctx.now());
    const since = instant(stringFlag(args.values, "since"), 0);

    const rows = await queryUsage(
      { store: await ctx.store(), now: ctx.now },
      {
        grain: stringFlag(args.values, "grain"),
        groupBy: stringFlag(args.values, "by"),
        splitBy: stringFlag(args.values, "split"),
        since,
        until,
      },
    );

    emit(ctx, writer, { rows }, () => {
      if (rows.length === 0) return "no usage in this window";
      const hasSplit = rows.some((row) => row.split !== null && row.split !== undefined);
      return table(
        [
          { header: "KEY" },
          ...(hasSplit ? [{ header: "SPLIT" } as const] : []),
          { header: "REQUESTS", align: "right" },
          { header: "INPUT", align: "right" },
          { header: "OUTPUT", align: "right" },
          { header: "COST", align: "right" },
        ],
        rows.map((row) => [
          row.key,
          ...(hasSplit ? [row.split ?? "—"] : []),
          String(row.requests),
          String(row.inputTokens),
          String(row.outputTokens),
          formatUsd(row.costUsd),
        ]),
      );
    });
  },
};

/**
 * The filter flags `omni logs` and `omni logs export` share.
 *
 * One spec, declared twice by reference rather than typed twice, because the
 * two commands answering different filter vocabularies is exactly the drift
 * that makes an export disagree with the page an operator was looking at when
 * they asked for it.
 */
const LOG_FILTER_OPTIONS = {
  since: { type: "string" },
  until: { type: "string" },
  state: { type: "string" },
  failed: { type: "boolean" },
  provider: { type: "string" },
  model: { type: "string" },
  "requested-model": { type: "string" },
  "resolved-model": { type: "string" },
  account: { type: "string" },
  key: { type: "string" },
  "error-code": { type: "string" },
} as const;

/**
 * Flags to the control package's filter shape.
 *
 * `instant` is applied here rather than left to the control layer because the
 * CLI accepts what `Date` understands and an HTTP caller sends epoch
 * milliseconds; the control layer takes the narrower of the two.
 */
function logFilters(values: Parsed["values"]): LogFilterInput {
  const since = stringFlag(values, "since");
  const until = stringFlag(values, "until");
  return {
    ...(since === undefined ? {} : { since: instant(since, 0) }),
    ...(until === undefined ? {} : { until: instant(until, 0) }),
    state: stringFlag(values, "state"),
    ...(boolFlag(values, "failed") ? { failed: "true" } : {}),
    provider: stringFlag(values, "provider"),
    // `--model` asks both columns, because the two hold different vocabularies:
    // an alias like `opus` only ever appears as a requested name, and the
    // `claude-opus-5` it routes to only ever as a resolved one. Bound to one
    // side, the flag answered "no such traffic" for half the names an operator
    // has. The two long flags are for the question that really is about one
    // side, which is the rarer one.
    model: stringFlag(values, "model"),
    requestedModel: stringFlag(values, "requested-model"),
    resolvedModel: stringFlag(values, "resolved-model"),
    credentialId: stringFlag(values, "account"),
    apiKeyId: stringFlag(values, "key"),
    errorCode: stringFlag(values, "error-code"),
  };
}

export const logs: Command = {
  usage: "logs [-n N] [--follow] [--cursor C] [filters] [--service]",
  summary: "Show recent requests (--service is an alias for `omni console`)",
  options: {
    ...LOG_FILTER_OPTIONS,
    number: { type: "string", short: "n" },
    follow: { type: "boolean" },
    cursor: { type: "string" },
    service: { type: "boolean" },
    // Only meaningful beside --service, but declared unconditionally: strict
    // parsing rejects an undeclared flag, and the alias must accept whatever
    // `omni console` accepts.
    system: { type: "boolean" },
  },
  async run(args, { ctx, writer, service }) {
    const limit = numberFlag(args.values, "number") ?? 20;

    // Kept as an alias for `omni console`, which is the discoverable name for
    // the same log and the only one with --follow and --level. The flag is
    // documented and may be in an operator's scripts, so it does not move.
    if (boolFlag(args.values, "service")) {
      const text = await serviceLogs(service(), limit);
      emit(ctx, writer, { log: text }, () => (text.length === 0 ? "no service output yet" : text));
      return;
    }

    const store = await ctx.store();
    const filters = logFilters(args.values);

    const render = (rows: readonly RequestLog[]): string =>
      table(
        [
          { header: "AT" },
          { header: "MODEL" },
          { header: "RESOLVED" },
          { header: "STATUS", align: "right" },
          { header: "TOKENS", align: "right" },
          { header: "COST", align: "right" },
          { header: "MS", align: "right" },
        ],
        rows.map((row) => [
          paint(ctx, "dim", formatTime(row.at)),
          row.requestedModel,
          `${row.resolvedProvider}/${row.resolvedModel}`,
          state(ctx, row.status < 400, String(row.status)),
          `${row.inputTokens}+${row.outputTokens}`,
          formatUsd(row.costUsd),
          String(row.durationMs),
        ]),
      );

    const page = await pageLogs(store, {
      ...filters,
      limit,
      cursor: stringFlag(args.values, "cursor"),
    });
    const first = page.logs;
    // `nextCursor` rides in the structured output so a script can page without
    // having to construct one, and is printed under the table so an operator
    // can paste it back. Absent when this page is the last.
    emit(ctx, writer, { logs: first, nextCursor: page.nextCursor }, () =>
      first.length === 0
        ? "no requests match"
        : page.nextCursor === null
          ? render(first)
          : `${render(first)}\n${paint(ctx, "dim", `older: --cursor ${page.nextCursor}`)}`,
    );

    if (args.values.follow !== true || ctx.json) return;

    // Polling, not streaming: the control surface has no log stream, and a
    // reader that tails the table sees exactly what the console sees.
    //
    // The whole `(at, id)` tuple is remembered, not just the newest timestamp.
    // Two rows written in the same millisecond are ordered only by their ids,
    // so a watermark of `at` alone drops every row after the first in such a
    // group — silently, and more often the busier the gateway is, which is
    // when a follower is most likely to be watching.
    let seen: RequestLogCursor | null = first[0] === undefined ? null : cursorOf(first[0]);
    for (;;) {
      await Bun.sleep(FOLLOW_INTERVAL_MS);
      const mark = seen;
      const { rows, skipped } = await newerThan(
        (cursor) => pageLogs(store, { ...filters, limit, cursor }),
        mark,
      );
      if (rows.length === 0) continue;
      const newest = rows[0];
      if (newest !== undefined) seen = cursorOf(newest);
      if (skipped) {
        writer.out(
          paint(
            ctx,
            "dim",
            `more than ${FOLLOW_MAX_PAGES * limit} requests arrived since the last poll; older ones are not shown`,
          ),
        );
      }
      writer.out(render(rows.reverse()));
    }
  },
};

const cursorOf = (row: RequestLog): RequestLogCursor => ({ at: row.at, id: row.id });

/**
 * How far back a single poll will page before it gives up and says so.
 *
 * A follower that slept through an incident must not write a retention window
 * into somebody's terminal in one go.
 */
export const FOLLOW_MAX_PAGES = 10;

/**
 * Every row newer than the watermark, newest first, paging back until a page
 * reaches it.
 *
 * **One page is not enough, and the shortfall is silent.** `pageLogs` answers
 * with the newest `limit` rows, so a burst larger than the page pushes its own
 * oldest rows off the bottom; taking that page and advancing the watermark to
 * the newest row in it loses the rest permanently. It loses more of them the
 * busier the gateway is, which is exactly when somebody is following.
 *
 * Bounded by `FOLLOW_MAX_PAGES`, and hitting the bound is **reported rather
 * than absorbed** — rows were skipped, and a follower that says nothing about
 * it is the failure this function exists to fix.
 *
 * A null watermark means nothing has been shown yet, so there is no gap to
 * close: one page is the whole answer, and draining would replay the log.
 */
export async function newerThan(
  read: (cursor: string | undefined) => Promise<{ logs: RequestLog[]; nextCursor: string | null }>,
  mark: RequestLogCursor | null,
): Promise<{ rows: RequestLog[]; skipped: boolean }> {
  const rows: RequestLog[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < FOLLOW_MAX_PAGES; page++) {
    const got = await read(cursor);
    if (mark === null) return { rows: got.logs, skipped: false };
    const fresh = got.logs.filter((row) => isAfter(row, mark));
    rows.push(...fresh);
    // A page holding anything at or before the watermark has closed the gap, as
    // has a page with nothing after it. Either way everything newer is in hand.
    if (fresh.length < got.logs.length || got.nextCursor === null) {
      return { rows, skipped: false };
    }
    cursor = got.nextCursor;
  }
  return { rows, skipped: true };
}

/**
 * Strictly newer than the watermark, in the store's own `(at, id)` order.
 *
 * Exported for its test rather than for a caller: the follow loop it sits in
 * has no exit, so the predicate is the only part of it a test can hold still.
 */
export const isAfter = (row: RequestLog, seen: RequestLogCursor): boolean =>
  row.at > seen.at || (row.at === seen.at && row.id > seen.id);

export const logsExport: Command = {
  usage: "logs export --since T --until T [--format csv|jsonl] [filters]",
  summary: "Write matching request metadata to stdout as CSV or JSONL",
  options: {
    ...LOG_FILTER_OPTIONS,
    format: { type: "string" },
  },
  async run(args, { ctx, writer }) {
    const store = await ctx.store();
    // Written a chunk at a time rather than joined: the interval is the only
    // thing bounding this read, and an operator exporting a month of a busy
    // gateway should not need it to fit in memory first.
    //
    // Straight to the writer with no `emit`, because this output is a file. A
    // `--json` wrapper around a CSV is neither format, and the diagnostics that
    // would normally share the stream go to stderr instead.
    for await (const chunk of exportLogs(store, {
      ...logFilters(args.values),
      format: stringFlag(args.values, "format") ?? "csv",
    })) {
      writer.raw(chunk);
    }
  },
};
