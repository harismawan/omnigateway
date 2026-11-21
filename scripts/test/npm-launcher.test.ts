/**
 * The JavaScript shipped in the main npm package, run as npm runs it: under
 * Node, from an installed layout, against a stand-in "native binary" script.
 * The real binary is exercised by `npm-install.test.ts`.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packaging = join(import.meta.dir, "..", "..", "packaging", "npm");
const node = Bun.which("node");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = `${process.platform}-${process.arch}`;

/** `<prefix>/node_modules/{omnigateway,@omnigateway/<key>}` with a fake binary. */
function installed(binary: string): { main: string; native: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "omni-launcher-"));
  dirs.push(dir);
  const main = join(dir, "node_modules", "omnigateway");
  cpSync(packaging, main, { recursive: true });
  const platform = join(dir, "node_modules", "@omnigateway", key);
  mkdirSync(platform, { recursive: true });
  writeFileSync(join(platform, "package.json"), JSON.stringify({ name: `@omnigateway/${key}` }));
  const log = join(dir, "calls");
  const native = join(platform, "omnigateway");
  writeFileSync(native, binary.replace("$LOG", log));
  chmodSync(native, 0o755);
  return { main, native, log };
}

const recorder = `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > "$LOG"\nexit 7\n`;

test.skipIf(node === null)("bin/omni runs the binary as the CLI and returns its exit code", () => {
  const { main, native, log } = installed(recorder);
  const run = Bun.spawnSync([node as string, join(main, "bin", "omni"), "doctor", "--json"]);
  expect(run.exitCode).toBe(7);
  expect(readFileSync(log, "utf8")).toBe(`${native}\nomni\ndoctor\n--json\n`);
});

test.skipIf(node === null)("bin/omnigateway passes its arguments through untouched", () => {
  const { main, log } = installed(recorder);
  const run = Bun.spawnSync([node as string, join(main, "bin", "omnigateway"), "--version"]);
  expect(run.exitCode).toBe(7);
  expect(readFileSync(log, "utf8").split("\n").slice(1)).toEqual(["--version", ""]);
});

test.skipIf(node === null)("gateway.js runs the bridge migration", () => {
  const { main, log } = installed(recorder);
  Bun.spawnSync([node as string, join(main, "gateway.js")]);
  expect(readFileSync(log, "utf8").split("\n").slice(1)).toEqual([
    "omni",
    "service",
    "migrate",
    "--bridge",
    "",
  ]);
});

test.skipIf(node === null)("a signal reaches the binary and the launcher dies by it", async () => {
  const { main } = installed(
    `#!/bin/sh\ntrap 'exit 0' INT\necho ready\nwhile :; do sleep 0.05; done\n`,
  );
  // The child ignores nothing: the launcher must forward TERM and re-raise it.
  const child = Bun.spawn([node as string, join(main, "bin", "omnigateway")], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  await reader.read();
  child.kill("SIGTERM");
  await child.exited;
  expect(child.signalCode).toBe("SIGTERM");
});

test.skipIf(node === null)("a missing platform package names the fix", () => {
  const { main } = installed(recorder);
  rmSync(join(main, "..", "@omnigateway"), { recursive: true });
  const run = Bun.spawnSync([node as string, join(main, "bin", "omni")], { stderr: "pipe" });
  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toContain(`@omnigateway/${key} is not installed`);
});

test.skipIf(node === null)("an unsupported host is told to stay on the TS release", () => {
  const script = `const p=require(${JSON.stringify(join(packaging, "lib", "platform.js"))});
    const e=p.binaryPath({platform:"win32",arch:"x64"}); console.log(e.message)`;
  const run = Bun.spawnSync([node as string, "-e", script]);
  expect(run.stdout.toString()).toContain("npm i -g omnigateway@0.15.5");
});

test.skipIf(node === null)("postinstall links both bins straight to the binary", () => {
  const { main, native, log } = installed(recorder);
  const run = Bun.spawnSync([node as string, join(main, "postinstall.js")], {
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(run.exitCode).toBe(0);
  for (const bin of ["omni", "omnigateway"]) {
    const path = join(main, "bin", bin);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path).startsWith("/")).toBe(false);
    expect(realpathSync(path)).toBe(realpathSync(native));
  }
  // Not a global install: no migration attempted.
  expect(() => readFileSync(log)).toThrow();
});

test.skipIf(node === null || process.platform !== "linux")(
  "a global postinstall runs the migration and still exits 0 when it fails",
  () => {
    const { main, log } = installed(recorder);
    const run = Bun.spawnSync([node as string, join(main, "postinstall.js")], {
      env: { PATH: process.env.PATH ?? "", npm_config_global: "true" },
    });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(log, "utf8").split("\n").slice(1)).toEqual([
      "omni",
      "service",
      "migrate",
      "--from-npm",
      "",
    ]);
  },
);
