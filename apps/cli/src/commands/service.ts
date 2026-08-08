import { existsSync } from "node:fs";
import { boolFlag, numberFlag } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError } from "../context.ts";
import { emit, fields, note, paint } from "../output.ts";
import { gatewayEntrypoint, hasGatewayEntrypoint } from "../runtime.ts";
import {
  install,
  logFile,
  serviceLogs,
  status as serviceStatus,
  start as startService,
  stop as stopService,
  uninstall,
  unitInstalled,
} from "../service.ts";

/** The command line that runs the gateway from this installation. */
function gatewayArgv(root: string): string[] {
  if (!hasGatewayEntrypoint(root)) {
    throw new CliError(
      `no gateway entrypoint under ${root}; point --root at an OmniGateway checkout`,
    );
  }
  return [process.execPath, gatewayEntrypoint(root)];
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
            : logFile(deps.stateDir);
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
    if (!hasGatewayEntrypoint(deps.root)) {
      throw new CliError(`no gateway entrypoint under ${deps.root}`);
    }

    const result = await install(deps, {
      bun: process.execPath,
      entrypoint: gatewayEntrypoint(deps.root),
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

export const serviceLogsCommand: Command = {
  usage: "logs --service [-n N]",
  summary: "Show the gateway process's own output",
  options: { number: { type: "string", short: "n" } },
  async run(args, { ctx, writer, service }) {
    const lines = numberFlag(args.values, "number") ?? 50;
    const text = await serviceLogs(service(), lines);
    emit(ctx, writer, { log: text }, () => (text.length === 0 ? "no service output yet" : text));
  },
};

export const doctor: Command = {
  usage: "doctor",
  summary: "Check what this CLI resolved, and whether it can do anything with it",
  options: { system: { type: "boolean" } },
  async run(_args, { ctx, writer, service }) {
    const deps = service();
    const key = ctx.env.OMNI_ENCRYPTION_KEY;
    const unit = unitInstalled(deps);
    const status = await serviceStatus(deps);

    const checks = {
      root: deps.root,
      rootSource: ctx.root.source,
      envFile: ctx.root.envFile,
      databasePath: ctx.databasePath,
      databaseExists: existsSync(ctx.databasePath),
      // Never the key itself: presence and length are all a diagnostic needs.
      encryptionKey: typeof key === "string" ? `present (${key.length} chars)` : "missing",
      configError: ctx.configError,
      gatewayEntrypoint: hasGatewayEntrypoint(deps.root) ? gatewayEntrypoint(deps.root) : null,
      unitInstalled: unit,
      supervisor: status.supervisor,
      running: status.running,
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
        ["systemd unit", unit ? deps.scope : paint(ctx, "dim", "none")],
        ["gateway", ok(status.running, status.running ? "running" : "stopped")],
      ]);
    });
  },
};
