import { type ConsoleLine, type ConsoleSource, readConsole } from "@omni/control";
import { parseLogLevel } from "@omni/ir";
import { boolFlag, numberFlag, stringFlag, UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import type { Context } from "../context.ts";
import { emit, note, paint, type Tone } from "../output.ts";
import { consoleSource } from "../service.ts";

const FOLLOW_INTERVAL_MS = 2_000;

/**
 * How a level reads in a terminal.
 *
 * Colour carries state, the same as everywhere else here, and nothing
 * decorative. `info` is deliberately absent: it is the ordinary case, and a
 * line the gateway did not write has no level at all. Both print as they
 * arrived.
 */
const LEVEL_TONE: Partial<Record<NonNullable<ConsoleLine["level"]>, Tone>> = {
  debug: "dim",
  warn: "yellow",
  error: "red",
};

function render(ctx: Context, lines: readonly ConsoleLine[]): string {
  return lines
    .map((line) => {
      const tone = line.level === null ? undefined : LEVEL_TONE[line.level];
      return tone === undefined ? line.raw : paint(ctx, tone, line.raw);
    })
    .join("\n");
}

/**
 * What to tell an operator about where these lines came from.
 *
 * Always shown, not only when there are none: someone reading a file who
 * expected the journal needs to know as much as someone reading nothing.
 * Shared with `omni doctor`, which answers the same question before there is
 * anything to read.
 */
export function sourceHint(source: ConsoleSource): string {
  if (source.kind === "file") return `${source.path} (set OMNI_LOG_FILE to change it)`;
  if (source.kind === "journal") return `systemd journal for ${source.unit}`;
  return "not captured — run under systemd, or set OMNI_LOG_FILE and restart";
}

/**
 * What to print when there is nothing.
 *
 * Two different silences: a log that exists and is quiet, and no log at all.
 * The second is the ordinary state of a gateway started by hand, so it says
 * what to do rather than implying something is broken.
 */
function empty(source: ConsoleSource): string {
  if (source.kind !== "none") return `no output yet in ${sourceHint(source)}`;
  return [
    "this gateway's output is not being captured, so there is nothing to show.",
    "run it in the foreground and its output goes to your terminal instead.",
    "to capture it: `omni service install`, or set OMNI_LOG_FILE and restart.",
  ].join("\n");
}

export const console_: Command = {
  usage: "console [-n N] [--follow] [--level debug|info|warn|error]",
  summary: "Show the gateway process's own output",
  options: {
    number: { type: "string", short: "n" },
    follow: { type: "boolean" },
    level: { type: "string" },
  },
  async run(args, { ctx, writer, service }) {
    const lines = numberFlag(args.values, "number") ?? 50;
    const rawLevel = stringFlag(args.values, "level");
    const level = parseLogLevel(rawLevel);
    if (rawLevel !== undefined && level === null) {
      throw new UsageError(`unknown level "${rawLevel}"; use debug, info, warn or error`);
    }

    // Resolved from the installation, not from this process: `omni` is not the
    // gateway, and its own stdout says nothing about where the gateway's went.
    const { source, deps } = consoleSource(service());
    const query = { lines, ...(level === null ? {} : { level }) };

    const first = await readConsole(deps, source, query);
    emit(ctx, writer, first, () =>
      first.lines.length === 0 ? empty(source) : render(ctx, first.lines),
    );
    // Always, not only when empty: an operator reading a file who expected the
    // journal needs to know that as much as one reading nothing.
    if (!ctx.json && first.lines.length > 0) {
      note(ctx, writer, paint(ctx, "dim", `reading ${sourceHint(source)}`));
    }

    if (boolFlag(args.values, "follow") !== true || ctx.json) return;

    // Polling, like `omni logs --follow`: neither log is a stream, and a reader
    // that polls sees exactly what the console sees.
    let seen = first.lines.at(-1)?.at ?? 0;
    for (;;) {
      await Bun.sleep(FOLLOW_INTERVAL_MS);
      const next = await readConsole(deps, source, { ...query, since: seen });
      if (next.lines.length === 0) continue;
      seen = next.lines.at(-1)?.at ?? seen;
      writer.out(render(ctx, next.lines));
    }
  },
};
