/**
 * The leaf every other package reads the ponytail vocabulary from.
 *
 * This file imports nothing on purpose. `@omni/store` persists the mode inside
 * its settings row, so the union is a storage contract in the same way
 * `RTK_FILTER_IDS` and `DIMENSIONS` are, and a store that had to import the
 * ruleset text to learn the four names would be carrying a prompt into a
 * database module.
 */
export const PONYTAIL_MODES = ["off", "lite", "full", "ultra"] as const;

export type PonytailMode = (typeof PONYTAIL_MODES)[number];

/** The three levels that inject. `off` reaches no text at all. */
export type PonytailLevel = Exclude<PonytailMode, "off">;

const MODES: ReadonlySet<unknown> = new Set(PONYTAIL_MODES);

export function isPonytailMode(value: unknown): value is PonytailMode {
  return MODES.has(value);
}
