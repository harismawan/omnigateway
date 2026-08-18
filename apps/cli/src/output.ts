import type { Context } from "./context.ts";

/**
 * The only colours the CLI uses.
 *
 * Colour carries state, the same two meanings it carries in the console: what
 * something is, and how it is doing. Nothing here is decorative, because a
 * pipe, a dumb terminal, or `NO_COLOR` must lose nothing by dropping it.
 */
const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  // The one hue the eight-colour palette does not carry. Six providers need
  // six tones that are not red, and the basic set holds exactly six once red
  // is out — so the sixth provider either wears `dim`, which means "unknown"
  // in every table a provider appears in, or the palette grows by one. It
  // grows: 256-colour sits behind the same `ctx.color` switch that already
  // drops every escape for `NO_COLOR`, a pipe, or a dumb terminal.
  orange: "\u001b[38;5;208m",
} as const;

export type Tone = keyof Omit<typeof ANSI, "reset">;

export type Writer = {
  out: (line: string) => void;
  err: (line: string) => void;
};

export const consoleWriter: Writer = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function paint(ctx: Context, tone: Tone, text: string): string {
  return ctx.color ? `${ANSI[tone]}${text}${ANSI.reset}` : text;
}

/** Printable width, ignoring the escape sequences `paint` may have added. */
function width(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export type Column = { header: string; align?: "left" | "right" };

/**
 * Renders an aligned table.
 *
 * Columns are padded to their widest cell rather than to a fixed size, so a
 * table of short ids does not waste half the terminal, and one long label does
 * not wrap every row.
 */
export function table(columns: readonly Column[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = columns.map((column, index) =>
    rows.reduce((max, row) => Math.max(max, width(row[index] ?? "")), width(column.header)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const padding = " ".repeat(Math.max(0, (widths[index] ?? 0) - width(cell)));
        return columns[index]?.align === "right" ? padding + cell : cell + padding;
      })
      .join("  ")
      .trimEnd();

  return [line(columns.map((c) => c.header)), ...rows.map((row) => line(row))].join("\n");
}

/** A single labelled value, for the `show`-style commands. */
export function fields(entries: ReadonlyArray<readonly [string, string]>): string {
  const label = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries.map(([key, value]) => `${key.padEnd(label)}  ${value}`).join("\n");
}

/**
 * Emits a result once, in whichever form was asked for.
 *
 * `--json` is the scripting contract, so it prints the structured value and
 * never the table; the human rendering is free to change without breaking a
 * script.
 */
export function emit(ctx: Context, writer: Writer, data: unknown, human: () => string): void {
  if (ctx.json) {
    writer.out(JSON.stringify(data, null, 2));
    return;
  }
  const text = human();
  if (text.length > 0) writer.out(text);
}

/** Progress and warnings go to stderr, so `--json` on stdout stays parseable. */
export function note(ctx: Context, writer: Writer, message: string): void {
  if (!ctx.json) writer.err(message);
}

export function formatTime(at: number | null): string {
  if (at === null || !Number.isFinite(at)) return "—";
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

export function formatAge(from: number | null, now: number): string {
  if (from === null || !Number.isFinite(from)) return "—";
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * A span still to run, e.g. `1h13m`, `45m`, `5d02h`.
 *
 * Two units where `formatAge` uses one: an age only has to be recognisable,
 * while a deadline is read to decide whether to wait it out, and "empty in 1h"
 * hides the difference between four minutes' warning and fifty-nine.
 */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`;
  }
  return `${Math.floor(seconds / 86_400)}d${pad(Math.floor(seconds / 3600) % 24)}h`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/**
 * A size on disk or on the wire, e.g. `0 B`, `3.1 KB`, `1.2 MB`.
 *
 * One decimal rather than a rounded figure, because the numbers this prints are
 * read against stated caps — 512 KB for one artifact, 64 KB for one string — and
 * "512 KB" against "511.8 KB" is the difference between bounded and bounding.
 * Bytes below a kilobyte stay bytes: `0 B` for a half that never happened has to
 * be visibly nothing, not `0.0 KB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
