import { describe, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { UNIT_NAME } from "../src/console.ts";
import {
  describeLifecycle,
  type LifecycleDeps,
  requestRestart,
  requestShutdown,
} from "../src/lifecycle.ts";

/** Nothing exists on the fake filesystem unless a test says it does. */
const noFiles = () => false;

/**
 * A lifecycle over a fake environment, recording what it would have spawned and
 * whether it would have stopped the process. Nothing here spawns or exits.
 */
function deps(
  input: {
    env?: Record<string, string | undefined>;
    dockerenv?: boolean;
    code?: number;
    stderr?: string;
  } = {},
): LifecycleDeps & { argv: string[][]; stopped: number[] } {
  const argv: string[][] = [];
  const stopped: number[] = [];
  return {
    argv,
    stopped,
    env: input.env ?? {},
    version: "0.0.0-test",
    fileExists: (path) => input.dockerenv === true && path === "/.dockerenv",
    run: async (args) => {
      argv.push([...args]);
      return { code: input.code ?? 0, stdout: "", stderr: input.stderr ?? "" };
    },
    stop: (code) => stopped.push(code),
  };
}

const SYSTEM = { JOURNAL_STREAM: "8:12345" };
const USER = { JOURNAL_STREAM: "8:12345", MANAGERPID: "1234" };

describe("describeLifecycle", () => {
  test("reads JOURNAL_STREAM plus MANAGERPID as a user-scope systemd unit", () => {
    expect(describeLifecycle({ JOURNAL_STREAM: "8:12345", MANAGERPID: "1234" }, noFiles)).toEqual({
      supervisor: "systemd",
      canRestart: true,
      canShutdown: true,
    });
  });

  test("reads JOURNAL_STREAM alone as a system-scope systemd unit", () => {
    // The system manager is pid 1 and sets no MANAGERPID. Both scopes are
    // systemd and both can restart; the scope only decides the argv.
    expect(describeLifecycle({ JOURNAL_STREAM: "8:12345" }, noFiles)).toMatchObject({
      supervisor: "systemd",
      canRestart: true,
    });
  });

  test("says a container restart is a policy we cannot read, rather than claiming it", () => {
    const capability = describeLifecycle({}, (path) => path === "/.dockerenv");
    expect(capability.supervisor).toBe("container");
    expect(capability.canRestart).toBe(true);
    expect(capability.canShutdown).toBe(true);
    expect(capability.note ?? "").not.toBe("");
  });

  test("reports no restart when nothing is watching, without a note repeating it", () => {
    const capability = describeLifecycle({}, noFiles);
    expect(capability.supervisor).toBe("none");
    expect(capability.canRestart).toBe(false);
    // Stopping is still available: stopping is the point of shutdown.
    expect(capability.canShutdown).toBe(true);
    // The supervisor is the reason; a sentence restating it is the warning
    // this shape does not warrant.
    expect(capability.note).toBeUndefined();
  });

  test("prefers systemd over the container marker, since a unit is the stronger claim", () => {
    // Both signals at once is a real shape: a systemd-managed container host
    // that also bind-mounts the marker. The supervisor we can actually address
    // wins.
    expect(describeLifecycle({ JOURNAL_STREAM: "8:1" }, () => true).supervisor).toBe("systemd");
  });
});

describe("requestRestart under systemd", () => {
  test("asks the user manager to restart the unit, and never stops the process itself", async () => {
    const d = deps({ env: USER });
    await requestRestart(d);
    expect(d.argv).toEqual([["systemctl", "--user", "--no-block", "restart", UNIT_NAME]]);
    // We ask the supervisor and stay running; a systemctl failure is then an
    // ordinary error from a gateway that is still serving.
    expect(d.stopped).toEqual([]);
  });

  test("omits --user for a system unit", async () => {
    const d = deps({ env: SYSTEM });
    await requestRestart(d);
    expect(d.argv).toEqual([["systemctl", "--no-block", "restart", UNIT_NAME]]);
  });

  test("passes --no-block, because systemd kills the client it just spawned", async () => {
    // Restarting the unit tears down its cgroup, which contains this very
    // systemctl. A blocking call is killed mid-wait; the queued job survives.
    const d = deps({ env: USER });
    await requestRestart(d);
    expect(d.argv[0]).toContain("--no-block");
    expect(d.argv[0]?.indexOf("--no-block")).toBeLessThan(d.argv[0]?.indexOf("restart") ?? -1);
  });

  test("raises a failed systemctl rather than reporting a restart that did not happen", async () => {
    const d = deps({ env: USER, code: 1, stderr: "Failed to restart omnigateway.service" });
    expect(requestRestart(d)).rejects.toThrow(GatewayError);
  });
});

describe("requestRestart in a container", () => {
  test("exits zero and lets the restart policy decide, without shelling out", async () => {
    const d = deps({ dockerenv: true });
    await requestRestart(d);
    expect(d.stopped).toEqual([0]);
    expect(d.argv).toEqual([]);
  });
});

describe("requestRestart with no supervisor", () => {
  test("refuses, rather than exiting a process nothing would start again", async () => {
    const d = deps();
    expect(requestRestart(d)).rejects.toThrow(GatewayError);
    expect(d.stopped).toEqual([]);
    expect(d.argv).toEqual([]);
  });
});

describe("requestShutdown", () => {
  test.each([
    ["systemd", { env: USER }],
    ["container", { dockerenv: true }],
    ["none", {}],
  ])(
    "exits zero under %s, because a clean exit is what means 'meant to stop'",
    async (_, input) => {
      const d = deps(input);
      await requestShutdown(d);
      expect(d.stopped).toEqual([0]);
      expect(d.argv).toEqual([]);
    },
  );
});
