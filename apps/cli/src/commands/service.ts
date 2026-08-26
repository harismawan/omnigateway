import { existsSync } from "node:fs";
import { listPlugins, orphanPluginTables, type PluginSummary, pluginsDir } from "@omni/control";
import { resolvePin } from "@omni/store";
import { boolFlag } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError, type Context } from "../context.ts";
import { emit, fields, note, paint } from "../output.ts";
import { gatewayEntrypoint } from "../runtime.ts";
import {
  consoleSource,
  install,
  status as serviceStatus,
  start as startService,
  stop as stopService,
  supervisedLogFile,
  uninstall,
  unitInstalled,
} from "../service.ts";
import { sourceHint } from "./console.ts";
import { doctorPluginDeps, pluginDoctorLines } from "./plugins.ts";

/** The command line that runs the gateway from this installation. */
function gatewayArgv(root: string): string[] {
  const entrypoint = gatewayEntrypoint(root);
  if (entrypoint === null) {
    throw new CliError(
      `no gateway to run: ${root} is not an OmniGateway checkout, and no bundled server ` +
        "was found beside this CLI",
    );
  }
  return [process.execPath, entrypoint];
}

export const start: Command = {
  usage: "start [--foreground]",
  summary: "Start the gateway and wait until it is serving",
  options: { system: { type: "boolean" }, foreground: { type: "boolean" } },
  async run(args, { ctx, writer, service, foreground }) {
    const deps = service();
    const baseUrl = ctx.config().baseUrl;

    if (boolFlag(args.values, "foreground")) {
      // Attached to this terminal: nothing is supervised, nothing is recorded,
      // and the operator's Ctrl-C is the stop command.
      const code = await foreground({ argv: gatewayArgv(deps.root), cwd: deps.root, env: ctx.env });
      if (code !== 0) throw new CliError(`gateway exited with code ${code}`, 3);
      return;
    }

    note(ctx, writer, `starting gateway at ${baseUrl}…`);
    const result = await startService(deps, {
      argv: gatewayArgv(deps.root),
      env: ctx.env,
      baseUrl,
    });

    emit(ctx, writer, result, () => {
      const how = result.supervisor === "systemd" ? "systemd" : `pid ${result.pid}`;
      if (!result.healthy) {
        // Started but silent. The log is the only thing that can say why, so
        // point at it rather than reporting a success nobody can verify.
        const where =
          result.supervisor === "systemd"
            ? "journalctl -u omnigateway.service"
            : supervisedLogFile(deps);
        return `${state(ctx, false, "started but /health never answered")} (${how}); see ${where}`;
      }
      return `${state(ctx, true, "running")} (${how}) at ${baseUrl}`;
    });

    if (!result.healthy) throw new CliError("gateway did not become healthy", 3);
  },
};

export const stop: Command = {
  usage: "stop",
  summary: "Stop the gateway",
  async run(_args, { ctx, writer, service }) {
    const result = await stopService(service());
    emit(ctx, writer, result, () =>
      result.stopped ? "stopped" : "nothing to stop: the gateway is not running",
    );
  },
};

export const restart: Command = {
  usage: "restart",
  summary: "Stop the gateway, then start it again",
  async run(_args, { ctx, writer, service }) {
    const deps = service();
    await stopService(deps);
    const result = await startService(deps, {
      argv: gatewayArgv(deps.root),
      env: ctx.env,
      baseUrl: ctx.config().baseUrl,
    });
    emit(ctx, writer, result, () =>
      result.healthy ? "restarted" : state(ctx, false, "restarted but /health never answered"),
    );
    if (!result.healthy) throw new CliError("gateway did not become healthy", 3);
  },
};

export const serviceInstall: Command = {
  usage: "service install [--system] [--enable] [--force]",
  summary: "Write a systemd unit for this installation",
  options: {
    system: { type: "boolean" },
    enable: { type: "boolean" },
    force: { type: "boolean" },
  },
  async run(args, { ctx, writer, service }) {
    const deps = service();
    const entrypoint = gatewayEntrypoint(deps.root);
    if (entrypoint === null) throw new CliError(`no gateway to run for ${deps.root}`);

    const result = await install(deps, {
      bun: process.execPath,
      entrypoint,
      enable: boolFlag(args.values, "enable"),
      force: boolFlag(args.values, "force"),
    });

    emit(ctx, writer, result, () =>
      fields([
        ["unit", result.path],
        ["scope", deps.scope],
        ["daemon-reload", result.reloaded ? "ok" : "failed"],
        ["enabled at boot", result.enabled ? "yes" : "no"],
      ]),
    );
  },
};

export const serviceUninstall: Command = {
  usage: "service uninstall [--system]",
  summary: "Disable and remove the systemd unit",
  options: { system: { type: "boolean" } },
  async run(_args, { ctx, writer, prompt, service }) {
    const deps = service();
    if (!(await prompt.confirm(`remove the ${deps.scope} systemd unit for ${deps.root}?`))) {
      throw new CliError("cancelled");
    }

    const result = await uninstall(deps);
    emit(ctx, writer, result, () =>
      result.removed ? `removed ${result.path}` : `no unit at ${result.path}`,
    );
  },
};

/**
 * Whether the hourly usage rollup still agrees with the rows it summarizes.
 *
 * The rollup is what long-window rate limits are enforced from, and it is
 * derived: a disagreement means a key is being judged against history that is
 * not what the log holds, in either direction. Null where there is nothing to
 * check or nothing to check it with — a missing database, an unreadable
 * configuration, a store that will not open — because `doctor` is the command
 * an operator runs when those are exactly the things that are wrong.
 *
 * A full grouped scan of `request_logs`, which is the cost `sumSince` exists to
 * keep off the request path. It is paid here because this is a diagnostic
 * someone typed, not something the gateway does to itself.
 */
async function rollupState(ctx: Context): Promise<string | null> {
  if (ctx.configError !== null || !existsSync(ctx.databasePath)) return null;
  try {
    const audit = await (await ctx.store()).usage.auditRollup();
    return audit.ok
      ? `ok (${audit.buckets} hourly buckets)`
      : `${audit.mismatched} of ${audit.buckets} hourly buckets disagree with request_logs`;
  } catch {
    // The reason is already reported by `config` or `database` above; a second
    // rendering of the same fault would say nothing new.
    return null;
  }
}

/**
 * `plugin_*` tables belonging to no installed plugin, or null when unknowable.
 *
 * Reported and never dropped, which is the store's own promise and the reason
 * this is in `doctor` rather than in a sweep. A restore is exactly when a plugin
 * is most likely to be temporarily missing — installed again a minute later by
 * the same operator — so the tables that outlive it are a question for a human,
 * not garbage.
 *
 * Null, not `[]`, when there is no database to ask or it will not open. An empty
 * array is "nothing orphaned", which is a reassurance nobody computed.
 */
async function orphanTables(ctx: Context): Promise<string[] | null> {
  if (ctx.configError !== null || !existsSync(ctx.databasePath)) return null;
  try {
    return orphanPluginTables(doctorPluginDeps(), ctx.root.root, await ctx.store());
  } catch {
    // Already reported by `config` or `database` above.
    return null;
  }
}

/**
 * Targets pinned to an account this installation no longer holds.
 *
 * The pin is deliberately not validated when a model is saved — removing a
 * credential must not make an unrelated edit of a model that mentions it
 * unsavable — so the dangling state is allowed to exist by design, and nothing
 * cleans it up. That makes it exactly the class of thing `doctor` is for: the
 * target hard-fails every request rather than falling back, and there is no
 * other command that would tell an operator so before a client does.
 *
 * Same null-versus-empty rule as the orphan tables above.
 */
async function danglingPins(ctx: Context): Promise<string[] | null> {
  if (ctx.configError !== null || !existsSync(ctx.databasePath)) return null;
  try {
    const store = await ctx.store();
    const accounts = await store.credentials.list();
    return (await store.config.listModels()).flatMap((model) =>
      model.targets
        // The shared rule, not an id lookup. A pin is equally dead when it names
        // another provider's account or a custom account on another endpoint,
        // and the router reports all three the same way — a check that saw only
        // deletions would print "none" for two of the three.
        .filter(
          (target) =>
            target.credentialId !== undefined && resolvePin(target, accounts) === undefined,
        )
        .map((target) => `${model.id}/${target.model} → ${target.credentialId}`),
    );
  } catch {
    // Already reported by `config` or `database` above.
    return null;
  }
}

export const doctor: Command = {
  usage: "doctor",
  summary: "Check what this CLI resolved, and whether it can do anything with it",
  options: { system: { type: "boolean" } },
  async run(_args, { ctx, writer, service }) {
    const deps = service();
    const key = ctx.env.OMNI_ENCRYPTION_KEY;
    const unit = unitInstalled(deps);
    const status = await serviceStatus(deps);
    const usageRollup = await rollupState(ctx);
    // Never throws over a broken plugin: an installation with one is exactly the
    // installation whose operator is running `doctor`.
    const plugins: PluginSummary[] = listPlugins(doctorPluginDeps(), deps.root);
    const orphans = await orphanTables(ctx);
    const pins = await danglingPins(ctx);

    const checks = {
      root: deps.root,
      rootSource: ctx.root.source,
      envFile: ctx.root.envFile,
      databasePath: ctx.databasePath,
      databaseExists: existsSync(ctx.databasePath),
      // Never the key itself: presence and length are all a diagnostic needs.
      encryptionKey: typeof key === "string" ? `present (${key.length} chars)` : "missing",
      configError: ctx.configError,
      gatewayEntrypoint: gatewayEntrypoint(deps.root),
      usageRollup,
      unitInstalled: unit,
      supervisor: status.supervisor,
      running: status.running,
      // Which log `omni console` will read, and whether there is one at all.
      consoleSource: consoleSource(deps).source,
      pluginsDir: pluginsDir(deps.root),
      plugins,
      orphanPluginTables: orphans,
      danglingPins: pins,
      // Repeated from stderr on purpose: `doctor` is the command an operator
      // runs to find out why the paths above are what they are, and `--json`
      // is read by scripts that never see stderr.
      warnings: ctx.warnings,
    };

    emit(ctx, writer, checks, () => {
      const ok = (value: boolean, text: string) => state(ctx, value, text);
      return fields([
        ["root", `${checks.root} ${paint(ctx, "dim", `(from ${checks.rootSource})`)}`],
        ["env file", checks.envFile ?? paint(ctx, "dim", "none")],
        [
          "database",
          `${checks.databasePath} ${ok(checks.databaseExists, checks.databaseExists ? "exists" : "missing")}`,
        ],
        ["encryption key", checks.encryptionKey],
        ["config", checks.configError === null ? ok(true, "ok") : ok(false, checks.configError)],
        ["entrypoint", checks.gatewayEntrypoint ?? ok(false, "not found")],
        [
          "usage rollup",
          checks.usageRollup === null
            ? paint(ctx, "dim", "not checked")
            : ok(checks.usageRollup.startsWith("ok"), checks.usageRollup),
        ],
        ["systemd unit", unit ? deps.scope : paint(ctx, "dim", "none")],
        ["gateway", ok(status.running, status.running ? "running" : "stopped")],
        ["console log", sourceHint(checks.consoleSource)],
        // One row per plugin rather than a count. A count answers "are there
        // plugins", and the question `doctor` is asked is "which one is wrong".
        ...(plugins.length === 0
          ? ([["plugins", paint(ctx, "dim", "none")]] as Array<[string, string]>)
          : pluginDoctorLines(ctx, plugins).map(
              (line, index) => [index === 0 ? "plugins" : "", line] as [string, string],
            )),
        [
          "orphan plugin tables",
          orphans === null
            ? paint(ctx, "dim", "not checked")
            : orphans.length === 0
              ? ok(true, "none")
              : // Named, not dropped. The store reports these and this command
                // prints them; removing one is `omni plugin remove --purge`,
                // which asks first.
                paint(ctx, "yellow", `${orphans.length}: ${orphans.join(", ")}`),
        ],
        [
          "dangling pins",
          pins === null
            ? paint(ctx, "dim", "not checked")
            : pins.length === 0
              ? ok(true, "none")
              : // Named, like the orphans above: the fix is to repoint or clear
                // the target in the model editor, and that needs to know which.
                paint(ctx, "yellow", `${pins.length}: ${pins.join(", ")}`),
        ],
        ...checks.warnings.map(
          (warning) => ["ignored", paint(ctx, "yellow", warning)] as [string, string],
        ),
      ]);
    });
  },
};
