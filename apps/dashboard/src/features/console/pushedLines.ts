import { LEVELS } from "@omni/ir";
import type { ConsoleLine } from "../../api/types.ts";

/**
 * The client half of a `stream:console` frame: reading one, and judging its
 * lines by the same rules the REST read judged its own by.
 *
 * ## Why the filter is written twice
 *
 * `packages/control/src/console.ts` holds the original — `parseConsoleLines`,
 * extracted precisely so the REST read and the gateway's stream source select
 * and filter identically. This console cannot call it: rule 12 in `CLAUDE.md`
 * lists what a dashboard may import, `@omni/control` is not on it, and every
 * `@omni/*` package is unpublished, so reaching for one from here is the same
 * class of mistake as a plugin importing core.
 *
 * So the level rule is restated, and the restatement is deliberately the
 * smaller half. The gateway already ran the *parsing* — a frame carries
 * `ConsoleLine` objects, not text — and it already ran the cap. What is left is
 * one comparison, and its ordering is imported from `@omni/ir` rather than
 * spelled out again, so the two copies cannot disagree about whether a warning
 * outranks an error. The branch that survives duplication is the awkward one
 * and is copied verbatim in spirit: **a line with no level is kept**. Journald
 * carries output the gateway never wrote, and an operator filtering to `error`
 * went looking for exactly those.
 *
 * The `since` half of the original's `keep` is not restated, because a frame is
 * already a delta — the ring decided what is new, and a second instant-based
 * filter here would drop the unparsed lines the rule above just kept.
 */

/** The level filter as the panel holds it: a `LogLevel`, or `""` for no filter. */
export type LevelFilter = string;

function isLevel(value: unknown): value is keyof typeof LEVELS {
  return typeof value === "string" && value in LEVELS;
}

/**
 * Whether a pushed line survives the panel's level filter.
 *
 * Mirrors the level branch of `keep()` in `packages/control/src/console.ts`. An
 * unrecognised filter value keeps everything, which is the same direction the
 * gateway errs in: showing an operator a line they did not ask for is visible,
 * hiding one they did is not.
 */
export function keepLevel(line: ConsoleLine, filter: LevelFilter): boolean {
  if (!isLevel(filter)) return true;
  if (line.level === null) return true;
  return LEVELS[line.level] >= LEVELS[filter];
}

function readLine(value: unknown): ConsoleLine | null {
  if (typeof value !== "object" || value === null) return null;
  const { raw, at, level, msg } = value as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  if (at !== null && typeof at !== "number") return null;
  if (level !== null && !isLevel(level)) return null;
  if (msg !== null && typeof msg !== "string") return null;
  return { raw, at, level, msg };
}

/**
 * The lines a `stream:console` frame carries, or `null` when it is not one.
 *
 * All or nothing, on purpose. A frame with one unreadable line among ten is a
 * frame this client cannot append without leaving a hole in the middle of it,
 * and an unmarked hole is the single thing the whole sequenced-payload contract
 * exists to prevent. `null` sends the caller down the same path a `gap` does —
 * drop what is held, re-read the window — which is the honest answer and the
 * one the vocabulary already has a name for.
 */
export function readConsoleFrame(payload: unknown): ConsoleLine[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { lines } = payload as { lines?: unknown };
  if (!Array.isArray(lines)) return null;

  const read: ConsoleLine[] = [];
  for (const entry of lines) {
    const line = readLine(entry);
    if (line === null) return null;
    read.push(line);
  }
  return read;
}
