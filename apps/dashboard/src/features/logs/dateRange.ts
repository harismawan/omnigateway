/**
 * The date arithmetic behind the log boards' one time-range control.
 *
 * Split from the component because all of it is a pure function of numbers and
 * strings, and because the interesting parts — which minute an inclusive upper
 * bound covers, what a click does when half a range is already chosen — are
 * exactly the parts a rendering test would assert least precisely.
 *
 * Everything here is local wall time. A row's `at` is an instant, but every
 * control an operator reads is in the browser's zone, so the conversion happens
 * at this boundary and nowhere deeper.
 */

const pad = (n: number): string => String(n).padStart(2, "0");

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The `YYYY-MM-DD` of an instant, in the browser's zone. */
export const dayOf = (at: number): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** A grid cell's `YYYY-MM-DD`, from the month the grid is drawn for. */
export const dayKey = (year: number, month: number, date: number): string =>
  `${year}-${pad(month + 1)}-${pad(date)}`;

/** The `HH:MM` of an instant, in the browser's zone. */
export const timeOf = (at: number): string => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * A day and a wall-clock minute back into an instant.
 *
 * `edge` is the whole reason this takes a parameter rather than being one
 * `Date.parse`. The controls are minute-granularity and the gateway's bounds are
 * inclusive, so an upper bound of `15:30` has to mean *through* 15:30 — landing
 * it on 15:30:00.000 drops every row in the 59 seconds an operator plainly meant
 * to include, and drops them silently, which is the worst way for a filter to be
 * wrong. The lower bound needs no such nudge: 14:00 already means from the first
 * instant of 14:00.
 */
export function instantOf(day: string, time: string, edge: "start" | "end"): number | undefined {
  // A naive ISO date-time is parsed in the local zone, which is what the
  // controls show and what `dayOf`/`timeOf` produced.
  const at = Date.parse(`${day}T${time}`);
  if (Number.isNaN(at)) return undefined;
  return edge === "end" ? at + 59_999 : at;
}

/**
 * One month's days, and how many columns to skip before the first of them.
 *
 * `lead` rather than padding cells: a blank has no identity to key a list on,
 * and a seven-column grid can start its first cell wherever it likes. The days
 * are then the only elements, each keyed by the date it is.
 *
 * `new Date(year, month + 1, 0)` is the last day of `month`, which is how the
 * length comes out without a leap-year table. The `+ 6) % 7` rotates Sunday to
 * the end, because the grid is Monday-first.
 */
export function monthDays(year: number, month: number): { lead: number; days: number[] } {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const length = new Date(year, month + 1, 0).getDate();
  return { lead, days: Array.from({ length }, (_, i) => i + 1) };
}

/**
 * The two days a click completes, ordered.
 *
 * Clicking backwards across the calendar is an ordinary thing to do — the end of
 * an incident is what an operator remembers first — so the pair is sorted rather
 * than refused. `YYYY-MM-DD` sorts correctly as a string, which is the only
 * reason that format is used internally.
 */
export function rangeFor(anchor: string, day: string): { from: string; to: string } {
  return day < anchor ? { from: day, to: anchor } : { from: anchor, to: day };
}

/** Whether `day` falls inside a chosen range, for shading the grid. */
export const withinRange = (
  day: string,
  from: string | undefined,
  to: string | undefined,
): boolean => from !== undefined && to !== undefined && day >= from && day <= to;

/** The last `days` days ending today, as the instants the wire wants. */
export function presetRange(days: number, now: number): { since: number; until: number } {
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { since: start.getTime(), until: end.getTime() };
}

const stamp = (at: number): string => {
  const d = new Date(at);
  return `${MONTHS[d.getMonth()] ?? ""} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * What the closed control reads.
 *
 * One bound set is a real state and says so rather than rendering as a range
 * with a blank half: filters arrive from places other than this control, and
 * "From Sep 3 14:00" is the honest reading of `since` alone.
 */
export function formatRange(since: number | undefined, until: number | undefined): string {
  if (since !== undefined && until !== undefined) return `${stamp(since)} - ${stamp(until)}`;
  if (since !== undefined) return `From ${stamp(since)}`;
  if (until !== undefined) return `Until ${stamp(until)}`;
  return "Any time";
}
