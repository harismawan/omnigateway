import { LEVELS, type LogLevel, type ParsedLine, parseLine } from "@omni/ir";
import { optionalNumber } from "./schemas.ts";

/**
 * The unit the CLI installs, and the only one this reads.
 *
 * Duplicated from `apps/cli/src/service.ts` rather than imported: a package may
 * not depend on an app, and the gateway needs the name to read its own journal.
 */
export const UNIT_NAME = "omnigateway.service";

/** A page of console output, capped so one read cannot pull a whole log file. */
export const MAX_CONSOLE_LINES = 500;
const DEFAULT_CONSOLE_LINES = 200;

/**
 * Where this gateway's stdout ended up.
 *
 * A process cannot read back what it wrote, so a reader has to find whatever
 * captured it. `none` is an ordinary answer, not a failure: under `bun run dev`
 * output goes to a terminal that nothing captured, and the surfaces say so.
 */
export type ConsoleSource =
  | { kind: "file"; path: string }
  | { kind: "journal"; unit: string; scope: "user" | "system" }
  | { kind: "none" };

export type ConsoleLine = ParsedLine;

export type ConsoleRead = {
  source: ConsoleSource["kind"];
  /**
   * Present only for a file.
   *
   * An operator who cannot see the process needs to know which file they are
   * being shown; a journal has no path to name.
   */
  path?: string;
  lines: ConsoleLine[];
};

export type RunResult = { code: number; stdout: string; stderr: string };

/** Runs a command to completion. Injected so no test spawns a process. */
export type CommandRunner = (argv: readonly string[]) => Promise<RunResult>;

export type ConsoleDeps = {
  /**
   * The last `lines` lines of a file, or null when it does not exist.
   *
   * The line budget is part of the seam because a log file is documented as
   * growing without bound: an implementation that reads the whole thing to
   * return its tail would allocate the entire file on every poll. What the
   * caller needs is the end.
   */
  readFile: (path: string, lines: number) => string | null;
  run: CommandRunner;
};

export type ConsoleQuery = {
  lines: number;
  level?: LogLevel | undefined;
  /** Only lines strictly newer than this instant. What `--follow` polls with. */
  since?: number | undefined;
};

/**
 * Picks the log to read: an explicit file, else the journal, else nothing.
 *
 * The file wins because it is the operator's own statement of where output
 * goes, and because the CLI's pidfile supervisor sets it for the gateway it
 * spawns — a case systemd knows nothing about.
 */
export function resolveConsoleSource(input: {
  logFile?: string | null | undefined;
  unitInstalled: boolean;
  scope: "user" | "system";
}): ConsoleSource {
  const path = input.logFile?.trim();
  if (path !== undefined && path.length > 0) return { kind: "file", path };
  if (input.unitInstalled) return { kind: "journal", unit: UNIT_NAME, scope: input.scope };
  return { kind: "none" };
}

/** Clamps a requested page size into `1..MAX_CONSOLE_LINES`. */
export function consoleLimit(requested: string | number | undefined): number {
  const value = optionalNumber(requested, DEFAULT_CONSOLE_LINES);
  return Math.floor(Math.min(Math.max(1, value), MAX_CONSOLE_LINES));
}

/**
 * Whether a line survives the query.
 *
 * A line that did not parse has no level to compare, and is kept. Journald
 * carries output the gateway never wrote — systemd's own notices, a runtime
 * stack trace — and those are exactly what an operator filtering to `error`
 * went looking for. `since` is the opposite: an unparsed line has no instant,
 * so a poll asking for what is new cannot honestly claim it.
 */
function keep(line: ConsoleLine, query: ConsoleQuery): boolean {
  if (query.since !== undefined && (line.at === null || line.at <= query.since)) return false;
  if (query.level === undefined || line.level === null) return true;
  return LEVELS[line.level] >= LEVELS[query.level];
}

/**
 * How many raw lines to consider before filtering.
 *
 * A filtered page should be *filled*: asking for the last 50 errors must not
 * return two because the other 48 fell outside the last 50 lines. So the source
 * is asked for a wider window and the tail is taken after filtering.
 *
 * The multiplier is bounded rather than unbounded — a log with no errors at all
 * would otherwise scan the whole file to prove it. `SCAN_LIMIT` is the honest
 * edge: beyond it, an older matching line is not found, and that is a stated
 * limit rather than a silent one.
 */
const SCAN_FACTOR = 20;
const SCAN_LIMIT = 5_000;

function scanWidth(query: ConsoleQuery): number {
  const filtered = query.level !== undefined || query.since !== undefined;
  return filtered ? Math.min(query.lines * SCAN_FACTOR, SCAN_LIMIT) : query.lines;
}

async function readSource(
  deps: ConsoleDeps,
  source: ConsoleSource,
  lines: number,
): Promise<string> {
  if (source.kind === "none") return "";
  if (source.kind === "file") return deps.readFile(source.path, lines) ?? "";

  const unit = source.scope === "system" ? ["-u", source.unit] : [`--user-unit=${source.unit}`];
  const result = await deps.run([
    "journalctl",
    ...unit,
    "-n",
    String(lines),
    "--no-pager",
    // Without this, journalctl prefixes every entry with its own timestamp,
    // hostname and `unit[pid]:` — so the gateway's own ISO instant is no longer
    // the first token, `parseLine` recovers nothing, and a level filter silently
    // matches everything. `cat` prints the MESSAGE field exactly as written.
    "--output=cat",
  ]);
  // A missing journal, a unit systemd has never heard of, a host without
  // journalctl at all: each is "there is nothing to show", not a failure worth
  // turning a console screen into an error.
  return result.code === 0 ? result.stdout : "";
}

/**
 * Reads the tail of whatever captured this gateway's stdout.
 *
 * The tail is taken *after* filtering, over a window wider than the page, so a
 * page asked to show errors is filled with errors rather than with whatever
 * happened to fall in the last N lines. `scanWidth` bounds how far back that
 * search goes.
 *
 * `lines` is clamped here rather than by each caller, because every caller has
 * to agree: an unclamped 0 reaches `slice(-0)`, which returns the whole array
 * instead of nothing.
 */
export async function readConsole(
  deps: ConsoleDeps,
  source: ConsoleSource,
  query: ConsoleQuery,
): Promise<ConsoleRead> {
  const limited: ConsoleQuery = { ...query, lines: consoleLimit(query.lines) };
  const text = await readSource(deps, source, scanWidth(limited));
  const lines = text
    .split("\n")
    .filter((raw) => raw.trim().length > 0)
    .map(parseLine)
    .filter((line) => keep(line, limited))
    .slice(-limited.lines);

  return source.kind === "file"
    ? { source: "file", path: source.path, lines }
    : { source: source.kind, lines };
}
