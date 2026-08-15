import { getSettings, putSettings } from "@omni/control";
import type { Settings } from "@omni/store";
import { requirePositional, UsageError } from "../args.ts";
import type { Command } from "../command.ts";
import { emit, fields } from "../output.ts";

/** Flattens `{ weights: { tier: 1 } }` into `weights.tier`, which is how it is edited. */
function flatten(settings: Settings): Array<readonly [string, string]> {
  const rows: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(settings)) {
    if (value !== null && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        rows.push([`${key}.${inner}`, String(innerValue)]);
      }
      continue;
    }
    rows.push([key, String(value)]);
  }
  return rows;
}

export const settingsGet: Command = {
  usage: "settings get",
  summary: "Show routing and retention settings",
  async run(_args, { ctx, writer }) {
    const settings = await getSettings(await ctx.store());
    emit(ctx, writer, { settings }, () => fields(flatten(settings)));
  },
};

export const settingsSet: Command = {
  usage: "settings set <path> <value>",
  summary: "Change one setting, e.g. weights.cost 0.4",
  async run(args, { ctx, writer }) {
    const path = requirePositional(args, 0, "setting path");
    const raw = requirePositional(args, 1, "value");

    const store = await ctx.store();
    const current = await getSettings(store);

    // A blank positional is not zero: `requirePositional` catches `""`, but a
    // quoted space reaches `Number(" ")` as 0, and `weights.*`,
    // `requestDeadlineMs` and `quotaPollIntervalMs` all accept 0, so the schema
    // would store it as a deliberate edit. A literal "0" still passes.
    const value = raw.trim().length === 0 ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) throw new UsageError(`${path} must be a number, got "${raw}"`);

    const [head, tail] = path.split(".");
    if (head === undefined || !(head in current)) throw new UsageError(`no setting "${path}"`);

    // Validation lives in the settings schema, which the write goes through:
    // this only has to place the value, not judge it.
    const next: Settings =
      tail === undefined
        ? { ...current, [head]: value }
        : { ...current, weights: { ...current.weights, [tail]: value } };

    if (tail !== undefined && head !== "weights") {
      throw new UsageError(`"${head}" has no sub-settings`);
    }

    const saved = await putSettings(store, next);
    emit(ctx, writer, { settings: saved }, () => `${path} = ${value}`);
  },
};
