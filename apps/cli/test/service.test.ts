import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  livePid,
  pidFile,
  start,
  status,
  stop,
  uninstall,
  unitFile,
} from "../src/service.ts";
import { fakeService, makeRoot } from "./helpers/harness.ts";

function withUnit(root: string): string {
  const path = join(root, "unit", "omnigateway.service");
  mkdirSync(join(root, "unit"), { recursive: true });
  writeFileSync(path, "[Unit]\n");
  return path;
}

test("the unit points at the root's own env file and an absolute bun", () => {
  const text = unitFile({ root: "/srv/omni", bun: "/usr/bin/bun", entrypoint: "/srv/omni/x.ts" });

  expect(text).toContain("WorkingDirectory=/srv/omni");
  expect(text).toContain("EnvironmentFile=/srv/omni/.env");
  expect(text).toContain("ExecStart=/usr/bin/bun /srv/omni/x.ts");
  expect(text).toContain("Restart=on-failure");
});

test("start delegates to systemctl when a unit is installed", async () => {
  const root = makeRoot();
  const service = fakeService({ root, unitPath: withUnit(root) });

  const result = await start(service.deps, { argv: ["bun", "x.ts"], env: {}, baseUrl: "http://x" });

  expect(result.supervisor).toBe("systemd");
  expect(service.commands).toContainEqual(["systemctl", "--user", "start", "omnigateway.service"]);
  // Two supervisors for one process is how an operator ends up with two
  // gateways on one database.
  expect(service.spawned).toHaveLength(0);
});

test("start spawns and records a pid when no unit is installed", async () => {
  const root = makeRoot();
  const service = fakeService({ root, pid: 321 });

  const result = await start(service.deps, {
    argv: ["bun", "gateway.ts"],
    env: { OMNI_PORT: "8787" },
    baseUrl: "http://x",
  });

  expect(result).toMatchObject({ supervisor: "pidfile", pid: 321, healthy: true });
  expect(service.spawned[0]?.argv).toEqual(["bun", "gateway.ts"]);
  expect(service.spawned[0]?.cwd).toBe(root);
  expect(readFileSync(pidFile(service.deps.stateDir), "utf8").trim()).toBe("321");
});

test("a start whose health check never answers is reported, not claimed", async () => {
  const root = makeRoot();
  const service = fakeService({ root, healthy: false });

  const result = await start(service.deps, { argv: ["bun"], env: {}, baseUrl: "http://x" });
  expect(result.healthy).toBe(false);
});

test("an already-running installation is not started twice", async () => {
  const root = makeRoot();
  const service = fakeService({ root, pid: 99, alivePids: new Set([99]) });
  writeFileSync(pidFile(service.deps.stateDir), "99\n");

  const result = await start(service.deps, { argv: ["bun"], env: {}, baseUrl: "http://x" });

  expect(result.pid).toBe(99);
  expect(service.spawned).toHaveLength(0);
});

test("a pidfile naming a dead process reads as stopped and is cleared", async () => {
  const root = makeRoot();
  const service = fakeService({ root, alivePids: new Set() });
  writeFileSync(pidFile(service.deps.stateDir), "4242\n");

  expect(livePid(service.deps)).toBeNull();
  expect(existsSync(pidFile(service.deps.stateDir))).toBe(false);
  expect(await status(service.deps)).toMatchObject({ supervisor: "none", running: false });
});

test("stop signals the process and clears the pidfile", async () => {
  const root = makeRoot();
  const alive = new Set([77]);
  const service = fakeService({ root, alivePids: alive });
  writeFileSync(pidFile(service.deps.stateDir), "77\n");

  const result = await stop(service.deps);

  expect(result).toMatchObject({ supervisor: "pidfile", stopped: true });
  expect(service.killed).toEqual([{ pid: 77, signal: "SIGTERM" }]);
  expect(existsSync(pidFile(service.deps.stateDir))).toBe(false);
});

test("a process that ignores SIGTERM is killed once the grace period is over", async () => {
  const root = makeRoot();
  const service = fakeService({ root, alivePids: new Set([88]) });
  // This fake keeps running through SIGTERM, which is the case the grace
  // period exists for.
  service.deps.kill = (pid, signal) => {
    service.killed.push({ pid, signal });
  };
  writeFileSync(pidFile(service.deps.stateDir), "88\n");

  await stop(service.deps);

  expect(service.killed.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
});

test("stopping an installation that is not running does nothing", async () => {
  const root = makeRoot();
  const service = fakeService({ root });
  expect(await stop(service.deps)).toMatchObject({ supervisor: "none", stopped: false });
  expect(service.killed).toHaveLength(0);
});

test("stop delegates to systemctl when a unit is installed", async () => {
  const root = makeRoot();
  const service = fakeService({ root, unitPath: withUnit(root) });

  expect(await stop(service.deps)).toMatchObject({ supervisor: "systemd" });
  expect(service.commands).toContainEqual(["systemctl", "--user", "stop", "omnigateway.service"]);
});

test("install writes the unit, reloads, and enables only when asked", async () => {
  const root = makeRoot();
  const path = join(mkdtempSync(join(tmpdir(), "omni-unit-")), "omnigateway.service");
  const service = fakeService({ root, unitPath: path });

  const result = await install(service.deps, {
    bun: "/usr/bin/bun",
    entrypoint: "/srv/x.ts",
    enable: false,
    force: false,
  });

  expect(result.path).toBe(path);
  expect(readFileSync(path, "utf8")).toContain("ExecStart=/usr/bin/bun /srv/x.ts");
  expect(service.commands).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  expect(service.commands).not.toContainEqual([
    "systemctl",
    "--user",
    "enable",
    "omnigateway.service",
  ]);
});

test("install refuses to replace a unit the operator may have written", async () => {
  const root = makeRoot();
  const path = withUnit(root);
  const service = fakeService({ root, unitPath: path });

  await expect(
    install(service.deps, { bun: "bun", entrypoint: "x.ts", enable: false, force: false }),
  ).rejects.toThrow(/already exists/);
  expect(readFileSync(path, "utf8")).toBe("[Unit]\n");

  await install(service.deps, { bun: "bun", entrypoint: "x.ts", enable: false, force: true });
  expect(readFileSync(path, "utf8")).toContain("ExecStart=bun x.ts");
});

test("uninstall disables the unit before removing it", async () => {
  const root = makeRoot();
  const path = withUnit(root);
  const service = fakeService({ root, unitPath: path });

  expect(await uninstall(service.deps)).toMatchObject({ removed: true });
  expect(service.commands[0]).toEqual([
    "systemctl",
    "--user",
    "disable",
    "--now",
    "omnigateway.service",
  ]);
  expect(existsSync(path)).toBe(false);
});

test("systemd status reports the unit's own word for what it is doing", async () => {
  const root = makeRoot();
  const service = fakeService({
    root,
    unitPath: withUnit(root),
    runResults: {
      "systemctl --user is-active omnigateway.service": {
        code: 3,
        stdout: "failed\n",
        stderr: "",
      },
      "systemctl --user show omnigateway.service --property=MainPID --value": {
        code: 0,
        stdout: "0\n",
        stderr: "",
      },
    },
  });

  expect(await status(service.deps)).toMatchObject({
    supervisor: "systemd",
    running: false,
    state: "failed",
    pid: null,
  });
});
