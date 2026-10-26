import {
  createDestination,
  DEFAULT_MAX_REQUEST_BYTES,
  type DestinationSummary,
  getDestination,
  listDestinations,
  removeDestination,
  updateDestination,
} from "@omni/control";
import { EXPORT_DESTINATION_TYPES, type ExportDestinationType } from "@omni/store/types";
import {
  boolFlag,
  listFlag,
  numberFlag,
  type OptionSpec,
  type Parsed,
  requirePositional,
  stringFlag,
  UsageError,
} from "../args.ts";
import { type Command, type CommandEnv, state } from "../command.ts";
import { CliError, type Context, postgresUrlOf } from "../context.ts";
import { emit, fields, formatBytes, formatTime, paint, table } from "../output.ts";
import { status as serviceStatus } from "../service.ts";

/**
 * `omni export`: log export destinations, administered on the store through
 * `@omni/control` like every other CLI command — no gateway needed for list,
 * show, add, set or remove. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Surfaces → CLI*).
 *
 * **Secrets never come from argv.** A flag value lands in shell history and in
 * `ps`; the secret is read from `--secret-file <path>`, or from stdin with
 * `--secret-file -` (the prompt hides it on a terminal), and is handed to
 * control as JSON text — never printed, never quoted in an error.
 *
 * **SQLite installations only.** The CLI opens the SQLite store; on an
 * installation configured for Postgres a write would land in a local file
 * the gateway never reads, so every subcommand refuses first (`guarded`).
 *
 * **Test and skip are the worker's.** Both run inside the gateway's export
 * worker, which this process cannot reach: the CLI administers through
 * `@omni/control`, never `/api/*`. So they are refused with a pointer to the
 * console rather than approximated here.
 */

const POSTGRES_REFUSAL =
  "this installation is configured for Postgres (cluster mode), and omni export administers " +
  "SQLite installations only; use the console (Export page)";

/**
 * Refuses before anything is opened when the installation's store is
 * Postgres — the detection `doctor` uses. Without it, `ctx.store()` would
 * create or edit `omnigateway.db` beside the root and report success.
 */
function guarded(command: Command): Command {
  return {
    ...command,
    async run(args, env) {
      if (postgresUrlOf(env.ctx) !== null) throw new CliError(POSTGRES_REFUSAL);
      await command.run(args, env);
    },
  };
}

/** Flags of one destination type, so a flag of another type is refused by name. */
const TYPE_FLAGS: Readonly<Record<ExportDestinationType, readonly string[]>> = {
  elasticsearch: ["url", "index", "auth", "flavor"],
  webhook: ["url", "header", "clear-headers"],
  otlp: ["endpoint", "signal"],
};

const CONFIG_OPTIONS: OptionSpec = {
  url: { type: "string" },
  index: { type: "string" },
  auth: { type: "string" },
  flavor: { type: "string" },
  header: { type: "string", multiple: true },
  endpoint: { type: "string" },
  signal: { type: "string" },
};

const FILTER_OPTIONS: OptionSpec = {
  "filter-key": { type: "string", multiple: true },
  "filter-model": { type: "string", multiple: true },
  "failed-only": { type: "boolean" },
};

const SECRET_OPTION: OptionSpec = { "secret-file": { type: "string" } };

const SECRET_SHAPES = [
  "Secrets are JSON, read from --secret-file <path>, or from stdin with --secret-file -",
  "(never from a flag value):",
  '  elasticsearch  {"apiKey":"…"} (--auth apiKey) or {"username":"…","password":"…"} (--auth basic)',
  '  webhook        {"signingSecret":"…"} and/or {"headers":{"authorization":"…"}}',
  '  otlp           {"headers":{"authorization":"…"}}',
].join("\n");

function isType(value: string): value is ExportDestinationType {
  return (EXPORT_DESTINATION_TYPES as readonly string[]).includes(value);
}

/** Refuses any config flag the destination's type does not take, naming it. */
function refuseForeignFlags(args: Parsed, type: ExportDestinationType): void {
  const own = new Set(TYPE_FLAGS[type]);
  for (const name of [...Object.keys(CONFIG_OPTIONS), "clear-headers"]) {
    if (args.values[name] !== undefined && !own.has(name)) {
      throw new UsageError(`--${name} does not apply to a ${type} destination`);
    }
  }
}

/** `name=value` pairs into a header record; the value is the operator's, not a secret. */
function headersFrom(args: Parsed): Record<string, string> | undefined {
  const pairs = listFlag(args.values, "header");
  if (pairs === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--header takes name=value, got "${pair.slice(0, 64)}"`);
    headers[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return headers;
}

/** The config fields these flags set, for the given type; absent flags are absent. */
function configFlags(args: Parsed, type: ExportDestinationType): Record<string, unknown> {
  const pick = (name: string, key = name): Record<string, unknown> => {
    const value = stringFlag(args.values, name);
    return value === undefined ? {} : { [key]: value };
  };
  switch (type) {
    case "elasticsearch":
      return { ...pick("url"), ...pick("index"), ...pick("auth"), ...pick("flavor") };
    case "webhook": {
      const headers = boolFlag(args.values, "clear-headers") ? {} : headersFrom(args);
      return { ...pick("url"), ...(headers === undefined ? {} : { headers }) };
    }
    case "otlp":
      return { ...pick("endpoint"), ...pick("signal") };
  }
}

/** The filter these flags describe, or undefined when none was given. */
function filterFlags(args: Parsed): Record<string, unknown> | undefined {
  const keys = listFlag(args.values, "filter-key");
  const models = listFlag(args.values, "filter-model");
  const failedOnly = boolFlag(args.values, "failed-only");
  if (keys === undefined && models === undefined && !failedOnly) return undefined;
  return {
    ...(keys === undefined ? {} : { apiKeyIds: keys }),
    ...(models === undefined ? {} : { models }),
    ...(failedOnly ? { failedOnly: true } : {}),
  };
}

/** `--max-request-bytes N`, or `default` for the type's own limit (null). */
function maxRequestBytesFlag(args: Parsed): number | null | undefined {
  if (stringFlag(args.values, "max-request-bytes") === "default") return null;
  return numberFlag(args.values, "max-request-bytes");
}

/**
 * The secret as JSON text, from a file or from stdin (`-`). Never echoed: an
 * unreadable file is named by its path, an empty one said to be empty, and
 * anything else is control's to judge with its own fixed messages.
 */
async function readSecret(env: CommandEnv, source: string): Promise<string> {
  const text =
    source === "-"
      ? await env.prompt.secret("secret (JSON): ")
      : await Bun.file(source)
          .text()
          .catch(() => {
            throw new CliError(`could not read ${source}`);
          });
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new CliError("the secret is empty");
  return trimmed;
}

function filterText(d: DestinationSummary): string {
  if (d.filterMalformed) return "unreadable: exports nothing until it is set again";
  const parts: string[] = [];
  if (d.filter.apiKeyIds !== undefined) parts.push(`keys ${d.filter.apiKeyIds.join(", ")}`);
  if (d.filter.models !== undefined) parts.push(`models ${d.filter.models.join(", ")}`);
  if (d.filter.failedOnly === true) parts.push("failed only");
  return parts.length === 0 ? "all requests" : parts.join("; ");
}

/** Where a destination sends, for the list. */
function target(d: DestinationSummary): string {
  const value = d.type === "otlp" ? d.config.endpoint : d.config.url;
  return typeof value === "string" ? value : "—";
}

function configValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return "—";
  return JSON.stringify(value);
}

function enabledState(ctx: Context, d: DestinationSummary): string {
  return state(ctx, d.enabled, d.enabled ? "enabled" : "disabled");
}

export const exportList: Command = guarded({
  usage: "export list",
  summary: "List log export destinations, without their secrets",
  async run(_args, { ctx, writer }) {
    const destinations = await listDestinations(await ctx.store());
    emit(ctx, writer, { destinations }, () => {
      if (destinations.length === 0) {
        return "no export destinations; add one with: omni export add <type> <id> …";
      }
      return table(
        [
          { header: "ID" },
          { header: "TYPE" },
          { header: "STATE" },
          { header: "TARGET" },
          { header: "SECRET" },
          { header: "FILTER" },
        ],
        destinations.map((d) => [
          d.id,
          d.type,
          enabledState(ctx, d),
          target(d),
          d.hasSecret ? "set" : "not set",
          filterText(d),
        ]),
      );
    });
  },
});

export const exportShow: Command = guarded({
  usage: "export show <id>",
  summary: "Show one export destination; its secret only as set or not set",
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "destination id");
    const d = await getDestination(await ctx.store(), id);
    emit(ctx, writer, d, () =>
      [
        fields([
          ["id", d.id],
          ["type", d.type],
          ["state", enabledState(ctx, d)],
          ...Object.entries(d.config).map(
            ([key, value]) => [key, configValue(value)] as [string, string],
          ),
          ["secret", d.hasSecret ? "set" : "not set"],
          ["filter", filterText(d)],
          ["starts at", d.startAt === 0 ? "oldest retained request" : formatTime(d.startAt)],
          [
            "max request",
            d.maxRequestBytes === null
              ? `default (${formatBytes(DEFAULT_MAX_REQUEST_BYTES[d.type])})`
              : formatBytes(d.maxRequestBytes),
          ],
          ["bodies", "off (body export is available in a later release)"],
          ["created", formatTime(d.createdAt)],
          ["updated", formatTime(d.updatedAt)],
        ]),
        paint(ctx, "dim", "lag and delivery errors: the console's Export page, or omni doctor"),
      ].join("\n"),
    );
  },
});

const ADD_USAGE = [
  "export add <type> <id> [--start-from now|oldest] [--disabled] [--secret-file <path>|-]",
  "  [--filter-key ID ...] [--filter-model M ...] [--failed-only] [--max-request-bytes N]",
  "  elasticsearch: --url URL --auth apiKey|basic|none [--index PATTERN] [--flavor elasticsearch|opensearch]",
  "  webhook:       --url URL [--header name=value ...]",
  "  otlp:          --endpoint URL [--signal logs|traces]",
].join("\n");

export const exportAdd: Command = guarded({
  usage: "export add <type> <id> [options]",
  summary: "Add a log export destination: elasticsearch, webhook or otlp",
  help: [
    ADD_USAGE,
    "",
    "--start-from now (default) exports what completes from here on; oldest, everything still retained.",
    "",
    SECRET_SHAPES,
  ].join("\n"),
  options: {
    ...CONFIG_OPTIONS,
    ...FILTER_OPTIONS,
    ...SECRET_OPTION,
    "start-from": { type: "string" },
    disabled: { type: "boolean" },
    "max-request-bytes": { type: "string" },
  },
  async run(args, env) {
    const type = requirePositional(args, 0, "destination type");
    if (!isType(type)) {
      throw new UsageError(
        `destination type must be one of ${EXPORT_DESTINATION_TYPES.join(", ")}`,
      );
    }
    const id = requirePositional(args, 1, "destination id");
    refuseForeignFlags(args, type);

    const config = configFlags(args, type);
    const required = type === "otlp" ? "endpoint" : "url";
    if (config[required] === undefined) throw new UsageError(`--${required} is required`);
    if (type === "elasticsearch" && config.auth === undefined) {
      throw new UsageError("--auth is required: apiKey, basic or none");
    }
    if (type === "otlp" && config.signal === undefined) config.signal = "logs";
    if (type === "webhook" && config.headers === undefined) config.headers = {};

    const filter = filterFlags(args);
    const maxRequestBytes = maxRequestBytesFlag(args);
    const secretSource = stringFlag(args.values, "secret-file");
    const secret = secretSource === undefined ? undefined : await readSecret(env, secretSource);

    const created = await createDestination(await env.ctx.store(), {
      id,
      type,
      config,
      startFrom: stringFlag(args.values, "start-from") ?? "now",
      ...(boolFlag(args.values, "disabled") ? { enabled: false } : {}),
      ...(filter === undefined ? {} : { filter }),
      ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
      ...(secret === undefined ? {} : { secret }),
    });
    emit(env.ctx, env.writer, created, () => `added ${created.type} destination ${created.id}`);
  },
});

export const exportSet: Command = guarded({
  usage: "export set <id> [options]",
  summary: "Change an export destination; what is not given is kept",
  help: [
    "export set <id> [--enable|--disable] [--secret-file <path>|- | --clear-secret]",
    "  [--filter-key ID ...] [--filter-model M ...] [--failed-only | --all-requests]",
    "  [--max-request-bytes N|default] and the type's own flags, as for export add",
    "  (webhook: --header replaces the plain headers, --clear-headers removes them)",
    "",
    "Config flags are applied over the stored config. A filter flag writes the filter whole.",
    "",
    SECRET_SHAPES,
  ].join("\n"),
  options: {
    ...CONFIG_OPTIONS,
    ...FILTER_OPTIONS,
    ...SECRET_OPTION,
    enable: { type: "boolean" },
    disable: { type: "boolean" },
    "clear-secret": { type: "boolean" },
    "clear-headers": { type: "boolean" },
    "all-requests": { type: "boolean" },
    "max-request-bytes": { type: "string" },
  },
  async run(args, env) {
    const id = requirePositional(args, 0, "destination id");
    const enable = boolFlag(args.values, "enable");
    const disable = boolFlag(args.values, "disable");
    if (enable && disable) throw new UsageError("pass one of --enable or --disable");
    const secretSource = stringFlag(args.values, "secret-file");
    const clearSecret = boolFlag(args.values, "clear-secret");
    if (secretSource !== undefined && clearSecret) {
      throw new UsageError("pass one of --secret-file or --clear-secret");
    }
    const allRequests = boolFlag(args.values, "all-requests");
    const filter = filterFlags(args);
    if (allRequests && filter !== undefined) {
      throw new UsageError("--all-requests clears the filter; pass it alone");
    }
    if (boolFlag(args.values, "clear-headers") && args.values.header !== undefined) {
      throw new UsageError("pass one of --header or --clear-headers");
    }

    const store = await env.ctx.store();
    const current = await getDestination(store, id);
    refuseForeignFlags(args, current.type);
    const config = configFlags(args, current.type);
    const maxRequestBytes = maxRequestBytesFlag(args);

    const patch = {
      ...(Object.keys(config).length === 0 ? {} : { config: { ...current.config, ...config } }),
      ...(enable ? { enabled: true } : disable ? { enabled: false } : {}),
      ...(allRequests ? { filter: {} } : filter === undefined ? {} : { filter }),
      ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
      ...(clearSecret ? { secret: null } : {}),
    };
    const secret = secretSource === undefined ? undefined : await readSecret(env, secretSource);
    if (Object.keys(patch).length === 0 && secret === undefined) {
      throw new UsageError("nothing to change; see omni export set --help");
    }

    const updated = await updateDestination(store, id, {
      ...patch,
      ...(secret === undefined ? {} : { secret }),
    });
    emit(env.ctx, env.writer, updated, () => `${updated.id} updated`);
  },
});

export const exportRemove: Command = guarded({
  usage: "export remove <id>",
  summary: "Delete an export destination; what it already sent stays sent",
  async run(args, { ctx, writer, prompt }) {
    const id = requirePositional(args, 0, "destination id");
    const store = await ctx.store();
    const d = await getDestination(store, id);
    const confirmed = await prompt.confirm(
      `delete ${d.type} export destination ${d.id}? Its position is lost; adding it again starts afresh.`,
    );
    if (!confirmed) throw new CliError("cancelled");
    await removeDestination(store, id);
    emit(ctx, writer, { id, removed: true }, () => `${id} removed`);
  },
});

/**
 * An action only the gateway's export worker performs. The destination is
 * checked first, so a typo is named as one; then refused either way, saying
 * whether the gateway is even running.
 */
function workerOnly(verb: "test" | "skip", summary: string): Command {
  return guarded({
    usage: `export ${verb} <id>`,
    summary,
    async run(args, { ctx, service }) {
      const id = requirePositional(args, 0, "destination id");
      await getDestination(await ctx.store(), id);
      const running = (await serviceStatus(service())).running;
      throw new CliError(
        `omni export ${verb} requires the running gateway; use the console (Export page)` +
          (running ? "" : ". The gateway is not running: start it with omni start"),
      );
    },
  });
}

export const exportTest = workerOnly("test", "Send one synthetic record (console only)");
export const exportSkip = workerOnly("skip", "Skip a destination to now (console only)");
