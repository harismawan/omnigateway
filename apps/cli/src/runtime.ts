import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner, Scope, ServiceDeps, Spawner } from "./service.ts";
import { defaultStateDir, unitPath } from "./service.ts";

/** Runs a command and collects its output. The one place the CLI shells out. */
export const runCommand: CommandRunner = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/**
 * Starts the gateway detached, with its output appended to the log file.
 *
 * `unref` is what makes `omni start` return: without it the CLI would stay
 * alive as long as the gateway it just started.
 */
export const spawnDetached: Spawner = ({ argv, cwd, env, logFile }) => {
  const fd = openSync(logFile, "a");
  try {
    const proc = Bun.spawn([...argv], {
      cwd,
      env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    proc.unref();
    return proc.pid;
  } finally {
    closeSync(fd);
  }
};

/**
 * Runs the gateway attached to this terminal and resolves with its exit code.
 *
 * No pidfile and no unit: the operator's shell is the supervisor, and Ctrl-C is
 * how it stops. This is the shape a container or a `--foreground` debugging
 * session wants.
 */
export async function runForeground(input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<number> {
  const proc = Bun.spawn([...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/** True when something answers `/health` at this origin. */
export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Signal 0 asks whether we could signal the process, without sending anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The gateway this installation should run.
 *
 * Two layouts exist. A checkout runs its own source, which is what an operator
 * developing against a root expects: the code they are editing. A published
 * package has no checkout, and ships the server bundled beside the CLI.
 *
 * The checkout wins when both are present. The root names the installation
 * being managed, so its own code is the more specific answer.
 */
export function gatewayEntrypoint(root: string, cliDir = import.meta.dir): string | null {
  const candidates = [
    join(root, "apps", "gateway", "src", "index.ts"),
    // Published layout: bin/omni.js and gateway.js are siblings.
    join(cliDir, "..", "gateway.js"),
    join(cliDir, "gateway.js"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function createServiceDeps(input: {
  root: string;
  env: Record<string, string | undefined>;
  scope: Scope;
  now: () => number;
}): ServiceDeps {
  const logFile = input.env.OMNI_LOG_FILE?.trim();
  return {
    root: input.root,
    stateDir: defaultStateDir(input.env),
    scope: input.scope,
    unitPath: unitPath(input.scope),
    ...(logFile === undefined || logFile.length === 0 ? {} : { logFile }),
    run: runCommand,
    spawn: spawnDetached,
    probe: probeHealth,
    alive: processAlive,
    kill: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: (ms) => Bun.sleep(ms),
    now: input.now,
  };
}
