import { parseArgs } from "node:util";
import { describeError } from "@omni/ir";

export class UsageError extends Error {}

export type OptionSpec = Record<
  string,
  { type: "string" | "boolean"; short?: string; multiple?: boolean }
>;

/** Flags every command accepts, so they can be given before or after the verb. */
export const GLOBAL_OPTIONS: OptionSpec = {
  root: { type: "string" },
  db: { type: "string" },
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
};

export type FlagValue = string | boolean | Array<string | boolean> | undefined;

export type Parsed = {
  positionals: string[];
  values: Record<string, FlagValue>;
};

/**
 * Parses one command's arguments.
 *
 * `parseArgs` is strict about unknown flags, which is what we want: a
 * misspelled `--tier` silently ignored would be an operator changing nothing
 * and being told it worked.
 */
export function parse(argv: readonly string[], options: OptionSpec = {}): Parsed {
  try {
    const result = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { positionals: result.positionals, values: result.values };
  } catch (error) {
    throw new UsageError(describeError(error, "could not parse arguments"));
  }
}

export function stringFlag(values: Parsed["values"], name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(values: Parsed["values"], name: string): boolean {
  return values[name] === true;
}

export function listFlag(values: Parsed["values"], name: string): string[] | undefined {
  const value = values[name];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : undefined;
}

/**
 * Reads a flag that must be a number, naming the flag when it is not.
 *
 * A blank value is the flag being absent — `omni logs -n "$COUNT"` with an
 * unset variable is a shell handing us `""`, not a request for zero rows, and
 * `Number("")` is 0. A literal `"0"` is not blank and stays a value.
 *
 * Deliberately not `optionalNumber` from `@omni/control`: that helper answers
 * with a fallback where this one answers "absent" and refuses garbage outright,
 * so reusing it would turn a misspelled `--tier ten` into a silent default.
 */
export function numberFlag(values: Parsed["values"], name: string): number | undefined {
  const raw = stringFlag(values, name);
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
  return value;
}

export function requirePositional(parsed: Parsed, index: number, name: string): string {
  const value = parsed.positionals[index];
  if (value === undefined || value.length === 0) throw new UsageError(`${name} is required`);
  return value;
}
