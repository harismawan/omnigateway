import { GatewayError } from "@omni/ir";
import { type CommandRunner, UNIT_NAME } from "./console.ts";

export type Supervisor = "systemd" | "container" | "none";

export type LifecycleCapability = {
  supervisor: Supervisor;
  canRestart: boolean;
  canShutdown: boolean;
  /** Why the capability above is what it is, when that is not obvious. */
  note?: string;
};

/** The file every Docker container has, and the only container signal read. */
export const DOCKERENV_PATH = "/.dockerenv";

/**
 * What, if anything, would start this process again.
 *
 * Pure, and given both of its inputs: the environment and a probe for one path.
 * The probe is a parameter rather than a `statSync` because a test that had to
 * create `/.dockerenv` to describe a container could not be run.
 */
export function describeLifecycle(
  env: Record<string, string | undefined>,
  fileExists: (path: string) => boolean,
): LifecycleCapability {
  if (env.JOURNAL_STREAM !== undefined) {
    return { supervisor: "systemd", canRestart: true, canShutdown: true };
  }
  if (fileExists(DOCKERENV_PATH)) {
    return {
      supervisor: "container",
      // The one capability here that is a hope rather than a fact: a container
      // cannot read its own restart policy, so exiting either brings us back or
      // ends the installation, and only the host knows which.
      canRestart: true,
      canShutdown: true,
      note: "restart exits the container and relies on its restart policy, which cannot be read from inside it",
    };
  }
  return {
    supervisor: "none",
    canRestart: false,
    canShutdown: true,
    note: "no supervisor is watching this process, so nothing would start it again",
  };
}

/**
 * Which manager owns this unit.
 *
 * Taken from systemd rather than guessed from the uid, for the reason the
 * console reader documents: the user manager sets `MANAGERPID` and only for the
 * units it started, while the system manager is pid 1 and sets nothing. A system
 * unit with `User=omni` has a nonzero uid and a root user manager has uid 0, so
 * the uid is wrong in both directions — and the wrong scope addresses either
 * another manager's unit or none.
 */
function systemdScope(env: Record<string, string | undefined>): "user" | "system" {
  return env.MANAGERPID === undefined ? "system" : "user";
}

export type LifecycleDeps = {
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
  run: CommandRunner;
  /**
   * Stops this process.
   *
   * Injected so `process` never appears in this package, and expected to defer:
   * a caller that has an HTTP response to send first schedules its own teardown
   * and returns, because timers belong to the app and not here.
   */
  stop: (exitCode: number) => void;
};

/** Enough of a failed command to act on, and never enough to be a path or a secret. */
function commandFailure(action: string, result: { code: number; stderr: string }): GatewayError {
  const detail = result.stderr.split("\n")[0]?.trim().slice(0, 200) ?? "";
  const suffix = detail.length > 0 ? `: ${detail}` : "";
  return new GatewayError("INTERNAL", `${action} failed with exit ${result.code}${suffix}`);
}

/**
 * Restarts the gateway the way its supervisor expects.
 *
 * Under systemd we ask the manager instead of signalling ourselves. The unit the
 * CLI installs sets `Restart=on-failure`, and a handled SIGTERM exits zero,
 * which systemd reads as success — a self-signalling gateway would stop and stay
 * stopped. Asking also fails better: a refused `systemctl` is an ordinary error
 * from a gateway that is still running, rather than a process that killed itself
 * and hoped.
 */
export async function requestRestart(deps: LifecycleDeps): Promise<void> {
  const capability = describeLifecycle(deps.env, deps.fileExists);
  if (!capability.canRestart) {
    throw new GatewayError(
      "CONFLICT",
      capability.note ?? "this installation has no supervisor that would restart the gateway",
    );
  }

  if (capability.supervisor === "container") {
    // Exit zero and let the policy decide. Nothing to ask: the policy lives
    // outside the container and is not addressable from within it.
    deps.stop(0);
    return;
  }

  const scope = systemdScope(deps.env);
  const result = await deps.run([
    "systemctl",
    ...(scope === "user" ? ["--user"] : []),
    // Load-bearing. Restarting the unit tears down its whole cgroup, which
    // contains the `systemctl` just spawned; a blocking call is killed
    // mid-wait. The queued job survives, the client does not.
    "--no-block",
    "restart",
    UNIT_NAME,
  ]);
  if (result.code !== 0) throw commandFailure("systemctl restart", result);
}

/**
 * Stops the gateway.
 *
 * Exiting zero in every shape, because a clean exit is exactly what a supervisor
 * reads as "meant to stop": the installed unit's `Restart=on-failure` leaves it
 * down, and a container's policy is the operator's own statement. Shutdown is
 * available even with no supervisor at all — stopping is the point of it.
 */
export async function requestShutdown(deps: LifecycleDeps): Promise<void> {
  deps.stop(0);
}
