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

/**
 * Whether a settings object carries this key itself.
 *
 * `in` walks the prototype chain, so it answers yes for `toString`,
 * `constructor`, and everything else on `Object.prototype`. The schema then
 * strips the unknown key on the way to the store, and the edit exits 0 having
 * reported a change that was never written — a silent no-op dressed as success.
 */
function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

/**
 * What is stored at a flattened path today, or `undefined` when nothing is.
 *
 * The current value is what decides how the new one is read, so this runs before
 * the parse rather than after it.
 */
function currentValue(settings: Settings, head: string, tail: string | undefined): unknown {
  if (!has(settings, head)) return undefined;
  const top = (settings as unknown as Record<string, unknown>)[head];
  if (tail === undefined) return top;
  if (top === null || typeof top !== "object") return undefined;
  if (!has(top, tail)) return undefined;
  return (top as Record<string, unknown>)[tail];
}

/**
 * A number, refusing anything that is not one.
 *
 * A blank positional is not zero: `requirePositional` catches `""`, but a quoted
 * space reaches `Number(" ")` as 0, and `weights.*`, `requestDeadlineMs` and
 * `quotaPollIntervalMs` all accept 0, so the schema would store it as a
 * deliberate edit. A literal "0" still passes.
 */
function asNumber(path: string, raw: string): number {
  const value = raw.trim().length === 0 ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`${path} must be a number, got "${raw}"`);
  return value;
}

/**
 * `true` or `false`, and nothing else.
 *
 * Deliberately not permissive. `1`, `on`, and `yes` all look obvious until one
 * of them is typed at a capture switch and read as the opposite by whatever
 * writes the next tool, and the settings these gate — `rtkEnabled`,
 * `bodyLoggingEnabled` — are ones where guessing wrong is silent. Two words are
 * cheap to type and impossible to misread.
 */
function asBoolean(path: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`${path} must be true or false, got "${raw}"`);
}

/**
 * A non-blank string, left for the schema to judge.
 *
 * Deliberately does not know the ponytail levels: the settings schema already
 * rejects a name that is not one of them, and a second copy of that list here
 * would be one to keep in step. Blank is caught for the same reason
 * `asNumber` catches it — a quoted space is a typo, not an edit.
 */
function asString(path: string, raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new UsageError(`${path} must not be blank`);
  return value;
}

export const settingsSet: Command = {
  usage: "settings set <path> <value>",
  summary: "Change one setting, e.g. weights.cost 0.4 or rtkEnabled true",
  async run(args, { ctx, writer }) {
    const path = requirePositional(args, 0, "setting path");
    const raw = requirePositional(args, 1, "value");

    const store = await ctx.store();
    const current = await getSettings(store);

    const [head, tail] = path.split(".");
    if (head === undefined || !has(current, head)) throw new UsageError(`no setting "${path}"`);
    if (tail !== undefined && head !== "weights") {
      throw new UsageError(`"${head}" has no sub-settings`);
    }

    // The stored value's type picks the parse, rather than a list of paths kept
    // in step by hand, so a new setting of a type handled here is editable the
    // day it is added — which is the bug this replaces: `rtkEnabled` shipped
    // unreachable because the parse was `Number(raw)` and nothing told anyone.
    // `ponytailMode` was the same bug waiting to happen for strings, so the
    // reachability test now asks the question of every key at once rather than
    // of the one somebody remembered.
    const existing = currentValue(current, head, tail);
    const value =
      typeof existing === "boolean"
        ? asBoolean(path, raw)
        : typeof existing === "string"
          ? asString(path, raw)
          : asNumber(path, raw);

    // Validation lives in the settings schema, which the write goes through:
    // this only has to place the value, not judge it.
    const next: Settings =
      tail === undefined
        ? { ...current, [head]: value }
        : { ...current, weights: { ...current.weights, [tail]: value } };

    const saved = await putSettings(store, next);
    emit(ctx, writer, { settings: saved }, () => `${path} = ${value}`);
  },
};
