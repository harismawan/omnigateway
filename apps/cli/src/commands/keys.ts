import {
  createKey,
  type LimitReading,
  listKeys,
  revokeKey,
  setKeyExpiry,
  setKeyLimits,
  setKeyModels,
} from "@omni/control";
import type { LimitConfig } from "@omni/store";
import { boolFlag, listFlag, requirePositional, stringFlag, UsageError } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, formatTime, formatUsd, note, paint, table } from "../output.ts";

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

/**
 * The one name this parser refuses itself rather than deferring to the schema.
 *
 * Everything else here is structural on purpose, but `__proto__` cannot be
 * carried structurally: assigning it to an object reaches the prototype setter
 * instead of becoming an own key, so the schema is never shown it. Reading it
 * back is no better — `limits.__proto__` is `Object.prototype`, which is not
 * `undefined`, so `--unset` reads it as a limit that is there and deletes
 * nothing. Both ends are the "succeeded having changed nothing" outcome
 * `applyUnsetFlags` refuses below, and `--limit requests:__proto__=60` stores
 * `{"requests":{}}` — the empty husk `toLoose` and `applyUnsetFlags` are both
 * written to avoid.
 *
 * Refused rather than passed through even with a null-prototype object, because
 * zod drops an own `__proto__` key silently instead of reporting it as an
 * unknown name: the vocabulary check the rest of this parser leans on is the one
 * check that does not cover it.
 */
const PROTO = "__proto__";

function rejectProto(flag: string, name: string): void {
  if (name === PROTO) throw new UsageError(`${flag} cannot name "${PROTO}"`);
}

/**
 * `--limit` at creation and `--set` afterwards are the same syntax, so they are
 * the same parser and the flag it names is a parameter. A second copy would be
 * free to drift into a second spelling of the one thing this design has.
 */
function parseLimitFlags(
  entries: readonly string[],
  flag: string,
  into: LooseLimits = {},
): LooseLimits {
  const limits: LooseLimits = into;
  for (const entry of entries) {
    const equals = entry.indexOf("=");
    if (equals <= 0) {
      throw new UsageError(`${flag} must be dimension:window=value, got "${entry}"`);
    }
    const pair = entry.slice(0, equals);
    const raw = entry.slice(equals + 1);
    const value = Number(raw);
    if (raw.trim().length === 0 || !Number.isFinite(value)) {
      throw new UsageError(`${flag} ${pair} must be a number, got "${raw}"`);
    }

    const colon = pair.indexOf(":");
    if (colon < 0) {
      // No window given. Only the gauge is allowed to omit one; a windowed
      // dimension without a window is a limit over no horizon at all.
      if (WINDOWED.has(pair)) {
        throw new UsageError(`${flag} ${pair} needs a window, e.g. ${flag} ${pair}:1m=60`);
      }
      rejectProto(flag, pair);
      limits[pair] = value;
      continue;
    }

    const dimension = pair.slice(0, colon);
    const window = pair.slice(colon + 1);
    if (dimension.length === 0 || window.length === 0) {
      throw new UsageError(`${flag} must be dimension:window=value, got "${entry}"`);
    }
    rejectProto(flag, dimension);
    rejectProto(flag, window);
    const existing = limits[dimension];
    const windows = typeof existing === "object" ? existing : {};
    windows[window] = value;
    limits[dimension] = windows;
  }
  return limits;
}

/**
 * The stored matrix as something `--set` and `--unset` can be applied to.
 *
 * Explicit nulls are dropped rather than carried: an absent pair and a null one
 * both mean unlimited, so keeping the second spelling through an edit would
 * write back a shape that says nothing the first does not.
 */
function toLoose(limits: LimitConfig): LooseLimits {
  const loose: LooseLimits = {};
  for (const dimension of ["requests", "tokens", "spend"] as const) {
    const windows = limits[dimension];
    if (windows === undefined) continue;
    const kept: Record<string, number> = {};
    for (const [window, value] of Object.entries(windows)) {
      if (value === null || value === undefined) continue;
      kept[window] = value;
    }
    if (Object.keys(kept).length > 0) loose[dimension] = kept;
  }
  if (limits.concurrency !== undefined && limits.concurrency !== null) {
    loose.concurrency = limits.concurrency;
  }
  return loose;
}

/**
 * Removes named pairs, refusing one that is not there.
 *
 * A no-op would report success for `--unset spned:5h` having changed nothing,
 * which is the same failure `parse` refuses unknown flags to avoid. The cost is
 * that a script clearing a limit twice fails the second time, which is a loud
 * break rather than a silent one.
 */
function applyUnsetFlags(limits: LooseLimits, entries: readonly string[]): void {
  for (const entry of entries) {
    if (entry.includes("=")) {
      throw new UsageError(`--unset names a limit to remove, not a value, got "${entry}"`);
    }

    const colon = entry.indexOf(":");
    if (colon < 0) {
      if (WINDOWED.has(entry)) {
        throw new UsageError(`--unset ${entry} needs a window, e.g. --unset ${entry}:1m`);
      }
      rejectProto("--unset", entry);
      if (limits[entry] === undefined) throw new UsageError(`this key has no ${entry} limit`);
      delete limits[entry];
      continue;
    }

    const dimension = entry.slice(0, colon);
    const window = entry.slice(colon + 1);
    if (dimension.length === 0 || window.length === 0) {
      throw new UsageError(`--unset must be dimension:window, got "${entry}"`);
    }
    rejectProto("--unset", dimension);
    rejectProto("--unset", window);
    const windows = limits[dimension];
    if (typeof windows !== "object" || windows[window] === undefined) {
      throw new UsageError(`this key has no ${entry} limit`);
    }
    delete windows[window];
    // A dimension with no windows left is removed outright rather than stored
    // as an empty object: unlimited has one spelling, and unsetting the last
    // limit has to leave `{}` rather than a husk of the matrix that was there.
    if (Object.keys(windows).length === 0) delete limits[dimension];
  }
}

/**
 * One row of the matrix: what it bounds, the ceiling, and what has gone against
 * it.
 *
 * `concurrency` reads `—` rather than `0`: it is an in-flight gauge held in the
 * gateway process, and this command runs in another one. Reporting zero would
 * tell an operator beside a saturated gateway that nothing is in flight.
 */
function limitRow(reading: LimitReading): string[] {
  const money = reading.dimension === "spend";
  const amount = (value: number): string => (money ? formatUsd(value) : String(value));
  return [
    reading.dimension,
    reading.window ?? "—",
    amount(reading.limit),
    reading.used === null ? "—" : amount(reading.used),
    reading.used === null ? "—" : `${Math.round((reading.used / reading.limit) * 100)}%`,
  ];
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

/**
 * A date or datetime from the command line as an epoch-ms instant.
 *
 * `Date.parse`, so `2030-01-01` and `2030-01-01T12:00:00Z` both work and mean
 * what the operator's own tooling would read them as. The `NaN` check is the
 * whole reason this is a function: `Date.parse` returns `NaN` rather than
 * throwing, and `NaN` written into the column is a key with an expiry no reader
 * can compare against — refused at the flag instead, naming what was typed.
 *
 * A past instant is deliberately not refused. It is how "expire this key now"
 * is spelled, and unlike `keys revoke` it can be undone with `--never`.
 */
function parseWhen(flag: string, raw: string): number {
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    throw new UsageError(`${flag} must be a date, e.g. 2030-01-01, got "${raw}"`);
  }
  return at;
}

/** Three states, not two: an expired key is neither active nor revoked. */
function keyState(
  key: { revokedAt: number | null; expiresAt: number | null },
  now: number,
): string {
  if (key.revokedAt !== null) return "revoked";
  // Exclusive at the instant named, matching `keyUsable` — the listing must not
  // call a key active that `/v1` has already stopped accepting.
  if (key.expiresAt !== null && key.expiresAt <= now) return "expired";
  return "active";
}

export const keysList: Command = {
  usage: "keys list",
  summary: "List gateway API keys",
  async run(_args, { ctx, writer }) {
    const keys = await listKeys(await ctx.store());
    const now = Date.now();

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
          { header: "EXPIRES" },
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
          // Three states, because an expired key is refused at `/v1` while
          // looking untouched here otherwise — a key that stopped working with
          // nothing on the board saying why is the failure this column exists
          // to prevent.
          ((verdict) => state(ctx, verdict === "active", verdict))(keyState(key, now)),
          // The date beside the state, so "expires tomorrow" and "expired in
          // 2001" are not the same cell.
          formatTime(key.expiresAt),
          formatTime(key.createdAt),
        ]),
      );
    });
  },
};

export const keysCreate: Command = {
  usage:
    "keys create [--label L] [--allow <model> ...] [--limit <d>:<w>=N ...] [--expires <when>] [--no-bodies]",
  summary: "Mint a gateway API key, printed once",
  options: {
    label: { type: "string" },
    allow: { type: "string", multiple: true },
    limit: { type: "string", multiple: true },
    expires: { type: "string" },
    "no-bodies": { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const allow = listFlag(args.values, "allow");
    const expires = stringFlag(args.values, "expires");
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
      limits: parseLimitFlags(listFlag(args.values, "limit") ?? [], "--limit"),
      // Creation only, matching the console and the store: a key handed to a
      // client on the promise that its payloads are never retained must not
      // become capturable later by an edit the client cannot see. Reissue
      // instead — there is no flag that turns this off.
      bodyLoggingOptOut: boolFlag(args.values, "no-bodies"),
      // Absent means never, which is what every key minted before this flag
      // existed carries. Editable afterwards with `keys expiry`, unlike the
      // opt-out above.
      expiresAt: expires === undefined ? null : parseWhen("--expires", expires),
    });

    emit(ctx, writer, created, () => {
      note(ctx, writer, paint(ctx, "yellow", "this key is shown once and stored only as a hash"));
      return `${created.key}`;
    });
  },
};

export const keysLimits: Command = {
  usage: "keys limits <id> [--set <d>:<w>=N ...] [--unset <d>:<w> ...]",
  summary: "Show or edit one key's limits, with what has been used against them",
  options: {
    set: { type: "string", multiple: true },
    unset: { type: "string", multiple: true },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "key id");
    const sets = listFlag(args.values, "set") ?? [];
    const unsets = listFlag(args.values, "unset") ?? [];

    const store = await ctx.store();
    const existing = (await listKeys(store)).find((entry) => entry.id === id);
    if (existing === undefined) throw new CliError(`no api key "${id}"`);

    let key = existing;
    /**
     * Whether this edit threw away limits nobody could read.
     *
     * Carried into the payload, not only onto stderr. `note()` is
     * `if (!ctx.json) writer.err(...)`, so under `--json` the warning reached
     * neither stream and a provisioning script adding one limit to a key whose
     * column had gone bad discarded every other limit, with output
     * indistinguishable from an ordinary edit. Same `--json` silence this branch
     * already fixed in `credentials add-key`, on a path that destroys data
     * rather than refusing.
     *
     * Present only when it happened: absence means "not replaced", which is what
     * every other run reports, and a permanent `false` would change the shape of
     * every existing response for one rare case.
     */
    let replaced = false;
    if (sets.length > 0 || unsets.length > 0) {
      // An unreadable matrix cannot be edited into: merging onto a value no
      // reader can parse would drop whatever the operator meant without saying
      // so. `--set` alone is allowed through as the repair path, replacing the
      // column outright, and says as much on stderr.
      if (existing.limits === null) {
        if (unsets.length > 0) {
          throw new CliError(
            `the stored limits for "${id}" cannot be read, so there is nothing to unset; ` +
              "replace them with --set instead",
          );
        }
        // Set here and not above the throw: on that path nothing is replaced,
        // and a flag meaning "unreadable" where the name says "replaced" is the
        // kind of drift this file has already paid for elsewhere.
        replaced = true;
        note(
          ctx,
          writer,
          paint(ctx, "yellow", "the stored limits could not be read and are being replaced"),
        );
      }

      const next = existing.limits === null ? {} : toLoose(existing.limits);
      applyUnsetFlags(next, unsets);
      parseLimitFlags(sets, "--set", next);
      key = await setKeyLimits(store, id, { limits: next });
    }

    emit(ctx, writer, replaced ? { ...key, limitsReplaced: true } : key, () => {
      const head = fields([
        ["id", key.id],
        ["label", key.label],
        ["prefix", `${key.prefix}…`],
      ]);
      if (key.limits === null) {
        return `${head}\n\n${paint(ctx, "red", "limits unreadable")}: this key is refused at /v1 until they are replaced with --set`;
      }
      if (key.limitUsage.length === 0) {
        return `${head}\n\nno limits configured; this key is unlimited`;
      }
      return `${head}\n\n${table(
        [
          { header: "DIMENSION" },
          { header: "WINDOW" },
          { header: "LIMIT", align: "right" },
          { header: "USED", align: "right" },
          { header: "USE%", align: "right" },
        ],
        key.limitUsage.map(limitRow),
      )}\n${paint(ctx, "dim", "usage is counted from completed requests still inside each window")}`;
    });
  },
};

/**
 * The third editable field, and the only edit that can be undone.
 *
 * Mirrors `keys models`: show when asked nothing, replace whole when given
 * something, and one spelling per invocation because `--at` and `--never` name
 * opposite facts. A date already behind the clock is accepted rather than
 * refused — it is how "expire this key now" is spelled, and `--never` brings it
 * back, which `keys revoke` deliberately cannot.
 */
export const keysExpiry: Command = {
  usage: "keys expiry <id> [--at <when>] [--never]",
  summary: "Show or replace one key's expiry",
  options: {
    at: { type: "string" },
    never: { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "key id");
    const at = stringFlag(args.values, "at");
    const never = boolFlag(args.values, "never");

    const store = await ctx.store();
    const existing = (await listKeys(store)).find((entry) => entry.id === id);
    if (existing === undefined) throw new CliError(`no api key "${id}"`);

    let key = existing;
    if (never || at !== undefined) {
      if (never && at !== undefined) {
        throw new UsageError("--at and --never cannot be combined");
      }
      // Parsed before the write, so an unparseable date names the flag rather
      // than becoming a `NaN` no reader can compare against.
      const next = never ? null : parseWhen("--at", at as string);
      key = await setKeyExpiry(store, id, { expiresAt: next });
    }

    emit(ctx, writer, key, () => {
      const head = fields([
        ["id", key.id],
        ["label", key.label],
        ["prefix", `${key.prefix}…`],
      ]);
      if (key.expiresAt === null) return `${head}\nexpires: never`;
      const verdict = keyState(key, Date.now());
      return `${head}\nexpires: ${formatTime(key.expiresAt)}${
        verdict === "expired" ? ` ${paint(ctx, "red", "(expired)")}` : ""
      }`;
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

export const keysModels: Command = {
  usage: "keys models <id> [--allow <model> ...] [--all] [--none]",
  summary: "Show or replace one key's allowed models",
  options: {
    allow: { type: "string", multiple: true },
    all: { type: "boolean" },
    none: { type: "boolean" },
  },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "key id");
    const allow = listFlag(args.values, "allow");
    const all = boolFlag(args.values, "all");
    const none = boolFlag(args.values, "none");

    const store = await ctx.store();
    const existing = (await listKeys(store)).find((entry) => entry.id === id);
    if (existing === undefined) throw new CliError(`no api key "${id}"`);

    let key = existing;
    if (all || none || allow !== undefined) {
      // One spelling per invocation: the three name opposite facts (every
      // model, none, an exact list) and combining them would leave the edit
      // meaning whichever the parser happened to test last.
      if ([all, none, allow !== undefined].filter(Boolean).length > 1) {
        throw new UsageError("--all, --none, and --allow cannot be combined");
      }
      // Sent whole through the same strict schema as creation: null is every
      // model, [] denies all of them, and neither may collapse into the other.
      const next = all ? null : none ? [] : (allow ?? []);
      key = await setKeyModels(store, id, { modelAllowlist: next });
    }

    emit(ctx, writer, key, () => {
      const head = fields([
        ["id", key.id],
        ["label", key.label],
        ["prefix", `${key.prefix}…`],
      ]);
      const models =
        key.modelAllowlist === null
          ? "every model"
          : key.modelAllowlist.length === 0
            ? "no models; every request this key makes is refused"
            : key.modelAllowlist.join(", ");
      return `${head}\nmodels: ${models}`;
    });
  },
};
