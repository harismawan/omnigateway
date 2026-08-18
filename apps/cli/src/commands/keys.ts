import { createKey, listKeys, revokeKey } from "@omni/control";
import { boolFlag, listFlag, numberFlag, requirePositional, stringFlag } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, formatTime, note, paint, table } from "../output.ts";

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
          { header: "RATE/MIN", align: "right" },
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
          key.rateLimitPerMin === null ? "—" : String(key.rateLimitPerMin),
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
  usage: "keys create [--label L] [--allow <model> ...] [--rate-limit N] [--no-bodies]",
  summary: "Mint a gateway API key, printed once",
  options: {
    label: { type: "string" },
    allow: { type: "string", multiple: true },
    "rate-limit": { type: "string" },
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
      rateLimitPerMin: numberFlag(args.values, "rate-limit") ?? null,
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
