import { createKey, listKeys, revokeKey } from "@omni/control";
import type { LimitConfig } from "@omni/store";
import { boolFlag, listFlag, requirePositional, stringFlag, UsageError } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, formatTime, note, paint, table } from "../output.ts";

/**
 * The dimensions written `dimension:window=value`. `concurrency` is a gauge and
 * is written `concurrency=value`, because it has no window to name.
 */
const WINDOWED = new Set(["requests", "tokens", "spend"]);

/**
 * A `limits` object built structurally from the flags, for the control schema to
 * judge.
 *
 * Loose on purpose: which dimension and window names exist is the schema's
 * question, and answering it here as well would put the vocabulary in two places
 * that are free to disagree. This parse only refuses shapes the schema could
 * never see — a pair with no `=`, a value that is not a number.
 */
type LooseLimits = Record<string, Record<string, number> | number>;

function parseLimitFlags(entries: readonly string[]): LooseLimits {
  const limits: LooseLimits = {};
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      throw new UsageError(`--limit must be dimension:window=value, got "${entry}"`);
    }
    const pair = entry.slice(0, equals);
    const raw = entry.slice(equals + 1);
    const value = Number(raw);
    if (raw.trim().length === 0 || !Number.isFinite(value)) {
      throw new UsageError(`--limit ${pair} must be a number, got "${raw}"`);
    }

    const colon = pair.indexOf(":");
    if (colon < 0) {
      // No window given. Only the gauge is allowed to omit one; a windowed
      // dimension without a window is a limit over no horizon at all.
      if (WINDOWED.has(pair)) {
        throw new UsageError(`--limit ${pair} needs a window, e.g. --limit ${pair}:1m=60`);
      }
      limits[pair] = value;
      continue;
    }

    const dimension = pair.slice(0, colon);
    const window = pair.slice(colon + 1);
    if (dimension.length === 0 || window.length === 0) {
      throw new UsageError(`--limit must be dimension:window=value, got "${entry}"`);
    }
    const existing = limits[dimension];
    const windows = typeof existing === "object" ? existing : {};
    windows[window] = value;
    limits[dimension] = windows;
  }
  return limits;
}

/**
 * A compact summary for the list, printed in the syntax `--limit` accepts so
 * what is shown can be pasted back. The full matrix is one key's business.
 */
function summarizeLimits(limits: LimitConfig): string {
  const parts: string[] = [];
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows = limits[dimension];
    if (windows === undefined) continue;
    for (const [window, value] of Object.entries(windows)) {
      if (value === null || value === undefined) continue;
      parts.push(`${dimension}:${window}=${value}`);
    }
  }
  if (limits.concurrency !== undefined && limits.concurrency !== null) {
    parts.push(`concurrency=${limits.concurrency}`);
  }
  return parts.length === 0 ? "—" : parts.join(" ");
}

export const keysList: Command = {
  usage: "keys list",
  summary: "List gateway API keys",
  async run(_args, { ctx, writer }) {
    const keys = await listKeys(await ctx.store());

    emit(ctx, writer, { keys }, () => {
      if (keys.length === 0) return "no api keys; create one with: omni keys create";
      return table(
        [
          { header: "ID" },
          { header: "LABEL" },
          { header: "PREFIX" },
          { header: "MODELS" },
          { header: "LIMITS" },
          { header: "BODY CAPTURE" },
          { header: "STATE" },
          { header: "CREATED" },
        ],
        keys.map((key) => [
          key.id,
          key.label,
          key.prefix,
          key.modelAllowlist === null
            ? "all"
            : key.modelAllowlist.length === 0
              ? "none"
              : key.modelAllowlist.join(","),
          // A dash is already spoken for: below it means "defers to the
          // installation's setting", and here it means "no limits configured".
          // A key whose stored limits cannot be parsed is neither — it is
          // refused at `/v1` until the row is fixed — so it gets a word of its
          // own rather than a glyph that reads as unlimited.
          key.limits === null ? paint(ctx, "red", "unreadable") : summarizeLimits(key.limits),
          // An opted-out key is never captured whatever the settings say, and
          // that is a promise made to whoever holds it — so it is listed rather
          // than left in the database for an auditor to find. A dash is not
          // "captured": it means this key defers to the installation's setting,
          // which is off unless someone turned it on.
          key.bodyLoggingOptOut ? "no bodies" : "—",
          state(ctx, key.revokedAt === null, key.revokedAt === null ? "active" : "revoked"),
          formatTime(key.createdAt),
        ]),
      );
    });
  },
};

export const keysCreate: Command = {
  usage: "keys create [--label L] [--allow <model> ...] [--limit <d>:<w>=N ...] [--no-bodies]",
  summary: "Mint a gateway API key, printed once",
  options: {
    label: { type: "string" },
    allow: { type: "string", multiple: true },
    limit: { type: "string", multiple: true },
    "no-bodies": { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const allow = listFlag(args.values, "allow");
    const created = await createKey(await ctx.store(), {
      ...(stringFlag(args.values, "label") === undefined
        ? {}
        : { label: stringFlag(args.values, "label") }),
      // A null allowlist means every model; an empty array would mean none, so
      // an absent flag must stay null rather than becoming [].
      modelAllowlist: allow ?? null,
      // `--rate-limit N` is gone rather than aliased: one syntax for limits, and
      // a script still passing it fails on an unknown flag with a one-line fix
      // instead of quietly taking a deprecated path.
      limits: parseLimitFlags(listFlag(args.values, "limit") ?? []),
      // Creation only, matching the console and the store: a key handed to a
      // client on the promise that its payloads are never retained must not
      // become capturable later by an edit the client cannot see. Reissue
      // instead — there is no flag that turns this off.
      bodyLoggingOptOut: boolFlag(args.values, "no-bodies"),
    });

    emit(ctx, writer, created, () => {
      note(ctx, writer, paint(ctx, "yellow", "this key is shown once and stored only as a hash"));
      return `${created.key}`;
    });
  },
};

export const keysRevoke: Command = {
  usage: "keys revoke <id>",
  summary: "Revoke a gateway API key, keeping its usage history",
  async run(args, { ctx, writer, prompt }) {
    const id = requirePositional(args, 0, "key id");
    const keys = await listKeys(await ctx.store());
    const key = keys.find((k) => k.id === id);
    if (key === undefined) throw new CliError(`no api key "${id}"`);

    if (!(await prompt.confirm(`revoke key "${key.label}" (${key.prefix}…)?`))) {
      throw new CliError("cancelled");
    }

    await revokeKey(await ctx.store(), id);
    emit(ctx, writer, { id, revoked: true }, () => `${id} revoked`);
  },
};
