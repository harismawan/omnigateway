import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ConsoleDeps,
  type ConsoleSource,
  readConsole,
  resolveConsoleSource,
} from "@omni/control";

export const UNIT_NAME = "omnigateway.service";

export type Scope = "user" | "system";

export type RunResult = { code: number; stdout: string; stderr: string };

/** Runs a command to completion. Injected so tests never shell out. */
export type CommandRunner = (argv: readonly string[]) => Promise<RunResult>;

/** Starts a detached gateway and returns its pid. */
export type Spawner = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  logFile: string;
}) => number;

export type ServiceDeps = {
  root: string;
  stateDir: string;
  scope: Scope;
  /** Where this scope's unit file lives. Injected so a test never writes to a real one. */
  unitPath: string;
  run: CommandRunner;
  spawn: Spawner;
  /** True when the gateway answers `/health`. */
  probe: (baseUrl: string) => Promise<boolean>;
  /** True when a process with this pid exists and we may signal it. */
  alive: (pid: number) => boolean;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type ServiceStatus = {
  supervisor: "systemd" | "pidfile" | "none";
  running: boolean;
  /** Present under the pidfile supervisor, and under systemd when it reports one. */
  pid: number | null;
  /** systemd's own word for it: active, inactive, failed, … */
  state: string | null;
  unitPath: string | null;
  logFile: string | null;
};

export function unitPath(scope: Scope): string {
  return scope === "system"
    ? join("/etc/systemd/system", UNIT_NAME)
    : join(homedir(), ".config", "systemd", "user", UNIT_NAME);
}

function systemctlArgs(scope: Scope, args: readonly string[]): string[] {
  return scope === "system" ? ["systemctl", ...args] : ["systemctl", "--user", ...args];
}

export function pidFile(stateDir: string): string {
  return join(stateDir, "gateway.pid");
}

export function logFile(stateDir: string): string {
  return join(stateDir, "gateway.log");
}

/** The default state directory, honouring XDG when the operator has set it. */
export function defaultStateDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_STATE_HOME;
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(base, "omnigateway");
}

/**
 * The unit file text.
 *
 * `EnvironmentFile` rather than baked-in values: the CLI and the service must
 * read the same `.env`, or an operator who edits it would change one and not
 * the other. `ExecStart` carries an absolute bun path because systemd runs with
 * a minimal PATH.
 */
export function unitFile(input: {
  root: string;
  bun: string;
  entrypoint: string;
  description?: string;
}): string {
  return `[Unit]
Description=${input.description ?? "OmniGateway"}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${input.root}
EnvironmentFile=${join(input.root, ".env")}
ExecStart=${input.bun} ${input.entrypoint}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** True when a unit file is installed for this scope. */
export function unitInstalled(deps: Pick<ServiceDeps, "unitPath">): boolean {
  return existsSync(deps.unitPath);
}

function readPid(stateDir: string): number | null {
  const file = pidFile(stateDir);
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The pid this installation is supervising, or null.
 *
 * A pidfile is evidence, not proof: after a crash or a reboot the number in it
 * may name someone else's process. A pid that is not alive is treated as
 * stopped and the stale file is removed.
 */
export function livePid(deps: Pick<ServiceDeps, "stateDir" | "alive">): number | null {
  const pid = readPid(deps.stateDir);
  if (pid === null) return null;
  if (deps.alive(pid)) return pid;
  rmSync(pidFile(deps.stateDir), { force: true });
  return null;
}

export async function status(deps: ServiceDeps): Promise<ServiceStatus> {
  if (unitInstalled(deps)) {
    const active = await deps.run(systemctlArgs(deps.scope, ["is-active", UNIT_NAME]));
    const state = active.stdout.trim() || active.stderr.trim() || "unknown";
    const shown = await deps.run(
      systemctlArgs(deps.scope, ["show", UNIT_NAME, "--property=MainPID", "--value"]),
    );
    const pid = Number(shown.stdout.trim());
    return {
      supervisor: "systemd",
      running: state === "active",
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      state,
      unitPath: deps.unitPath,
      logFile: null,
    };
  }

  const pid = livePid(deps);
  return {
    supervisor: pid === null ? "none" : "pidfile",
    running: pid !== null,
    pid,
    state: null,
    unitPath: null,
    logFile: logFile(deps.stateDir),
  };
}

export type StartResult = {
  supervisor: "systemd" | "pidfile";
  pid: number | null;
  /** False when the process started but `/health` never answered. */
  healthy: boolean;
};

/**
 * Starts the gateway, and waits until it is actually serving.
 *
 * Under systemd this delegates: two supervisors for one process is how an
 * operator ends up with two gateways on one database. Without a unit, the CLI
 * becomes the supervisor — detached, with a pidfile and a log file — which is
 * enough for a workstation and is not pretending to be more.
 */
export async function start(
  deps: ServiceDeps,
  input: { argv: readonly string[]; env: Record<string, string | undefined>; baseUrl: string },
): Promise<StartResult> {
  if (unitInstalled(deps)) {
    const result = await deps.run(systemctlArgs(deps.scope, ["start", UNIT_NAME]));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `systemctl start exited ${result.code}`);
    }
    return {
      supervisor: "systemd",
      pid: null,
      healthy: await waitForHealth(deps, input.baseUrl),
    };
  }

  const running = livePid(deps);
  if (running !== null) {
    return {
      supervisor: "pidfile",
      pid: running,
      healthy: await waitForHealth(deps, input.baseUrl),
    };
  }

  mkdirSync(deps.stateDir, { recursive: true });
  const file = logFile(deps.stateDir);
  const pid = deps.spawn({
    argv: input.argv,
    cwd: deps.root,
    // The gateway is told where its own stdout is going, because a process
    // cannot read back what it wrote and the console view has to read it from
    // somewhere. systemd answers this with JOURNAL_STREAM; under this
    // supervisor there is nobody to answer it but us.
    env: { ...input.env, OMNI_LOG_FILE: file },
    logFile: file,
  });
  writeFileSync(pidFile(deps.stateDir), `${pid}\n`);

  return { supervisor: "pidfile", pid, healthy: await waitForHealth(deps, input.baseUrl) };
}

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_INTERVAL_MS = 200;

/**
 * Polls `/health` so that a successful start means serving, not merely spawned.
 *
 * Bounded by a count of attempts rather than by the clock: the injected clock
 * is free to stand still, and a wait that depends on it advancing is a wait
 * that can never end.
 */
async function waitForHealth(deps: ServiceDeps, baseUrl: string): Promise<boolean> {
  const attempts = Math.ceil(HEALTH_TIMEOUT_MS / HEALTH_INTERVAL_MS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await deps.probe(baseUrl)) return true;
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

const STOP_GRACE_MS = 5_000;
const STOP_INTERVAL_MS = 100;

export type StopResult = { supervisor: "systemd" | "pidfile" | "none"; stopped: boolean };

/** Stops the gateway: `systemctl stop`, or SIGTERM, a grace period, then SIGKILL. */
export async function stop(deps: ServiceDeps): Promise<StopResult> {
  if (unitInstalled(deps)) {
    const result = await deps.run(systemctlArgs(deps.scope, ["stop", UNIT_NAME]));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `systemctl stop exited ${result.code}`);
    }
    return { supervisor: "systemd", stopped: true };
  }

  const pid = livePid(deps);
  if (pid === null) return { supervisor: "none", stopped: false };

  deps.kill(pid, "SIGTERM");
  const attempts = Math.ceil(STOP_GRACE_MS / STOP_INTERVAL_MS);
  for (let attempt = 0; deps.alive(pid); attempt++) {
    if (attempt >= attempts) {
      // The grace period is over. A gateway that will not answer SIGTERM is
      // holding a database lock the next start needs.
      deps.kill(pid, "SIGKILL");
      break;
    }
    await deps.sleep(STOP_INTERVAL_MS);
  }

  rmSync(pidFile(deps.stateDir), { force: true });
  return { supervisor: "pidfile", stopped: true };
}

export type InstallResult = { path: string; reloaded: boolean; enabled: boolean };

/**
 * Writes the unit file and tells systemd about it.
 *
 * An existing unit is never overwritten without `force`: the operator may have
 * edited it, and silently replacing hand-written supervision is not a thing a
 * management tool should do.
 */
export async function install(
  deps: ServiceDeps,
  input: { bun: string; entrypoint: string; enable: boolean; force: boolean },
): Promise<InstallResult> {
  const path = deps.unitPath;
  if (existsSync(path) && !input.force) {
    throw new Error(`${path} already exists; pass --force to replace it`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitFile({ root: deps.root, bun: input.bun, entrypoint: input.entrypoint }));

  const reload = await deps.run(systemctlArgs(deps.scope, ["daemon-reload"]));
  let enabled = false;
  if (input.enable) {
    const result = await deps.run(systemctlArgs(deps.scope, ["enable", UNIT_NAME]));
    enabled = result.code === 0;
  }
  return { path, reloaded: reload.code === 0, enabled };
}

export type UninstallResult = { path: string; removed: boolean };

export async function uninstall(deps: ServiceDeps): Promise<UninstallResult> {
  const path = deps.unitPath;
  if (!existsSync(path)) return { path, removed: false };

  await deps.run(systemctlArgs(deps.scope, ["disable", "--now", UNIT_NAME]));
  rmSync(path, { force: true });
  await deps.run(systemctlArgs(deps.scope, ["daemon-reload"]));
  return { path, removed: true };
}

/**
 * Where this installation's gateway output goes, and how to read it.
 *
 * The journal when a unit is installed, this state directory's log file
 * otherwise — the same two answers `resolveConsoleSource` gives the gateway,
 * reached differently. The gateway asks whether systemd is capturing *it*; the
 * CLI is a separate process and cannot, so it asks whether a unit is installed
 * and infers the rest.
 */
export function consoleSource(deps: ServiceDeps): { source: ConsoleSource; deps: ConsoleDeps } {
  const file = logFile(deps.stateDir);
  // The file is claimed only once it exists. This directory is where *this*
  // supervisor would send output, but a gateway started by hand never wrote
  // here, and naming an empty path would report a quiet log where the honest
  // answer is that nothing captured anything.
  const hasFile = !unitInstalled(deps) && existsSync(file);
  return {
    source: resolveConsoleSource({
      ...(hasFile ? { logFile: file } : {}),
      unitInstalled: unitInstalled(deps),
      scope: deps.scope,
    }),
    deps: {
      readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
      run: deps.run,
    },
  };
}

/** Reads the process's own output: the journal under systemd, the log file otherwise. */
export async function serviceLogs(deps: ServiceDeps, lines: number): Promise<string> {
  const { source, deps: readDeps } = consoleSource(deps);
  const read = await readConsole(readDeps, source, { lines });
  return read.lines.map((line) => line.raw).join("\n");
}
