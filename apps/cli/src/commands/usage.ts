import { queryUsage, recentLogs } from "@omni/control";
import { boolFlag, numberFlag, stringFlag, UsageError } from "../args.ts";
import { type Command, state } from "../command.ts";
import { emit, formatTime, formatUsd, paint, table } from "../output.ts";
import { serviceLogs } from "../service.ts";

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

export const logs: Command = {
  usage: "logs [-n N] [--follow] [--service]",
  summary: "Show recent requests (--service is an alias for `omni console`)",
  options: {
    number: { type: "string", short: "n" },
    follow: { type: "boolean" },
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

    const render = (rows: Awaited<ReturnType<typeof recentLogs>>): string =>
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

    const first = await recentLogs(store, limit);
    emit(ctx, writer, { logs: first }, () =>
      first.length === 0 ? "no requests logged yet" : render(first),
    );

    if (args.values.follow !== true || ctx.json) return;

    // Polling, not streaming: the control surface has no log stream, and a
    // reader that tails the table sees exactly what the console sees.
    let seen = first[0]?.at ?? 0;
    for (;;) {
      await Bun.sleep(2_000);
      const next = (await recentLogs(store, limit)).filter((row) => row.at > seen);
      if (next.length === 0) continue;
      seen = next[0]?.at ?? seen;
      writer.out(render(next.reverse()));
    }
  },
};
