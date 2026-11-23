/**
 * install.sh against a local fake release: a temp dir served over HTTP holding
 * a fake archive and SHA256SUMS. The archive carries a stub `omnigateway` that
 * records every invocation and its stdin and answers `status --json` with a
 * chosen `adminConfigured`; what migrate/set-password do is pinned by Rust
 * tests, this pins what the script asks of the CLI. Nothing here touches
 * GitHub, npm, systemd or the real HOME.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "..", "install.sh");
const TAG = "v9.9.9";

const dirs: string[] = [];
const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.stop();
});

/** The stub CLI: records argv and stdin, answers status/doctor from the env. */
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$OMNI_STUB_LOG"
case "$1 $2" in
  "status --json")
    printf '{"process":{"running":false},"adminConfigured":%s,"credentials":[],"storeError":null}\\n' "\${OMNI_STUB_ADMIN_CONFIGURED:-false}"
    ;;
  "doctor --json")
    printf '{"root":"%s","rootSource":"default"}\\n' "\${OMNI_STUB_DOCTOR_ROOT:-}"
    ;;
  "admin set-password")
    cat >> "$OMNI_STUB_STDIN"
    ;;
esac
exit 0
`;

/** A release archive as `rust-binaries` packs it, with the stub as the binary. */
function makeRelease(assets: string, tag: string, badChecksum = false): void {
  const stage = join(assets, `stage-${tag}`);
  mkdirSync(join(stage, "public"), { recursive: true });
  writeFileSync(join(stage, "omnigateway"), STUB);
  chmodSync(join(stage, "omnigateway"), 0o755);
  symlinkSync("omnigateway", join(stage, "omni"));
  writeFileSync(join(stage, "public", "index.html"), "<html></html>");
  writeFileSync(join(stage, "LICENSE"), "MIT");
  const name = `omnigateway-${tag}-linux-x64.tar.gz`;
  const tar = Bun.spawnSync(["tar", "-czf", join(assets, name), "-C", stage, "."]);
  expect(tar.exitCode).toBe(0);
  const digest = new Bun.CryptoHasher("sha256")
    .update(readFileSync(join(assets, name)))
    .digest("hex");
  const sum = badChecksum ? "0".repeat(64) : digest;
  // The workflow writes `sha256sum ./*.tar.gz`, so entries carry `./`.
  writeFileSync(join(assets, "SHA256SUMS"), `${sum}  ./${name}\n`, { flag: "a" });
  rmSync(stage, { recursive: true, force: true });
}

function serveRelease(assets: string): string {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/latest") {
        return new Response(null, { status: 302, headers: { Location: `/tag/${TAG}` } });
      }
      if (path === "/public-ip") return new Response("203.0.113.7");
      if (path.startsWith("/download/")) {
        const name = path.slice("/download/".length).split("/")[1];
        if (name && existsSync(join(assets, name))) {
          return new Response(Bun.file(join(assets, name)));
        }
        return new Response("not found", { status: 404 });
      }
      return new Response("ok");
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return `http://127.0.0.1:${server.port}`;
}

function fixture(badChecksum = false): { dir: string; assets: string; home: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "omni-install-"));
  dirs.push(dir);
  const assets = join(dir, "assets");
  mkdirSync(assets);
  makeRelease(assets, TAG, badChecksum);
  const home = join(dir, "home");
  mkdirSync(home);
  return { dir, assets, home, base: serveRelease(assets) };
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// Async spawn: the fake release server shares this process's event loop, which
// a spawnSync would block while curl waits for it.
async function runInstall(options: {
  home: string;
  base: string;
  args: string[];
  env?: Record<string, string>;
  withBinOnPath?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { home, base, args, env } = options;
  const path = options.withBinOnPath ? `${home}/.local/bin:${SYSTEM_PATH}` : SYSTEM_PATH;
  const run = Bun.spawn(["sh", script, ...args], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: path,
      OMNI_INSTALL_BASE_URL: base,
      OMNI_INSTALL_UNAME_S: "Linux",
      OMNI_INSTALL_UNAME_M: "x86_64",
      OMNI_INSTALL_PUBLIC_IP_URL: `${base}/public-ip`,
      OMNI_STUB_LOG: join(home, "calls.log"),
      OMNI_STUB_STDIN: join(home, "stdin.log"),
      OMNI_STUB_ADMIN_CONFIGURED: "false",
      OMNI_STUB_DOCTOR_ROOT: "",
      OMNI_ADMIN_PASSWORD: "",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const calls = (home: string): string[] =>
  existsSync(join(home, "calls.log"))
    ? readFileSync(join(home, "calls.log"), "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];

const envFile = (root: string): string => readFileSync(join(root, ".env"), "utf8");

test("binary install: current and bin links, .env, migrate then set-password on stdin", async () => {
  const { home, base } = fixture();
  const root = join(home, ".config", "omnigateway");
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);

  const data = join(home, ".local", "share", "omnigateway");
  expect(lstatSync(join(data, "current")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(data, "current"))).toBe(join(data, TAG));
  expect(existsSync(join(data, TAG, "omnigateway"))).toBe(true);
  expect(existsSync(join(data, TAG, "public", "index.html"))).toBe(true);
  expect(readlinkSync(join(home, ".local", "bin", "omni"))).toBe(join(data, "current", "omni"));
  expect(readlinkSync(join(home, ".local", "bin", "omnigateway"))).toBe(
    join(data, "current", "omnigateway"),
  );

  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
  const env = envFile(root);
  expect(env).toContain("OMNI_HOST=0.0.0.0");
  expect(env).toContain("OMNI_PORT=9000");
  expect(env).toContain("OMNI_BASE_URL=http://gw.example.test:9000");
  expect(env).toMatch(/OMNI_ENCRYPTION_KEY=\S+/);

  expect(calls(home)).toEqual([
    `db migrate --root ${root}`,
    `status --json --root ${root}`,
    `admin set-password --root ${root}`,
  ]);
  expect(readFileSync(join(home, "stdin.log"), "utf8")).toBe("correct horse battery staple\n");
  expect(run.stdout).toContain("Dashboard: http://gw.example.test:9000");
});

test("a bare --base-url host becomes http://host:port and --port is written", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--port", "9100", "--base-url", "192.0.2.10"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.exitCode).toBe(0);
  const env = envFile(join(home, ".config", "omnigateway"));
  expect(env).toContain("OMNI_PORT=9100");
  expect(env).toContain("OMNI_BASE_URL=http://192.0.2.10:9100");
});

test("--yes without --base-url takes the detected public address", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(join(home, ".config", "omnigateway"))).toContain(
    "OMNI_BASE_URL=http://203.0.113.7:9000",
  );
});

test("a pre-existing .env is never rewritten; --port/--base-url are ignored with a note", async () => {
  const { home, base } = fixture();
  const root = join(home, "existing-root");
  mkdirSync(root, { recursive: true });
  const original =
    "OMNI_ENCRYPTION_KEY=keepme\nOMNI_HOST=127.0.0.1\nOMNI_PORT=9200\nOMNI_BASE_URL=http://old.example.test:9200\n";
  writeFileSync(join(root, ".env"), original);
  const run = await runInstall({
    home,
    base,
    args: [
      "--no-service",
      "--yes",
      "--root",
      root,
      "--port",
      "9999",
      "--base-url",
      "http://new.example.test:9999",
    ],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(root)).toBe(original);
  expect(run.stdout).toContain("--port/--base-url are ignored");
  expect(run.stdout).toContain("Dashboard: http://old.example.test:9200");
  expect(run.stdout).toContain("OMNI_HOST=127.0.0.1");
  expect(calls(home)).toContain(`db migrate --root ${root}`);
});

test("no set-password when adminConfigured is true", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_STUB_ADMIN_CONFIGURED: "true" },
  });
  expect(run.exitCode).toBe(0);
  expect(calls(home).some((c) => c.startsWith("admin set-password"))).toBe(false);
});

test("--yes with no password set and none in the environment fails naming OMNI_ADMIN_PASSWORD", async () => {
  const { home, base } = fixture();
  const run = await runInstall({ home, base, args: ["--no-service", "--yes"] });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain("OMNI_ADMIN_PASSWORD");
});

test("upgrade reuses the root the installed omni resolves, moves current, keeps the old version", async () => {
  const { home, assets, base } = fixture();
  makeRelease(assets, "v9.10.0");
  const root = join(home, "custom-root");
  const first = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--root", root, "--base-url", "http://first.example.test:9000"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(first.exitCode).toBe(0);
  const envBefore = envFile(root);
  const callsBefore = calls(home).length;

  const second = await runInstall({
    home,
    base,
    args: [
      "--version",
      "v9.10.0",
      "--no-service",
      "--yes",
      "--port",
      "9999",
      "--base-url",
      "http://second.example.test:9999",
    ],
    env: { OMNI_STUB_DOCTOR_ROOT: root, OMNI_STUB_ADMIN_CONFIGURED: "true" },
    withBinOnPath: true,
  });
  expect(second.stderr).toBe("");
  expect(second.exitCode).toBe(0);
  expect(second.stdout).toContain("upgrading");
  expect(second.stdout).toContain(root);

  const data = join(home, ".local", "share", "omnigateway");
  expect(readlinkSync(join(data, "current"))).toBe(join(data, "v9.10.0"));
  expect(existsSync(join(data, TAG, "omnigateway"))).toBe(true);
  expect(second.stdout).toContain(join(data, TAG));
  expect(envFile(root)).toBe(envBefore);
  expect(second.stdout).toContain("--port/--base-url are ignored");

  const upgradeCalls = calls(home).slice(callsBefore);
  expect(upgradeCalls).toContain("doctor --json");
  expect(upgradeCalls).toContain(`db migrate --root ${root}`);
  expect(upgradeCalls.some((c) => c.startsWith("admin set-password"))).toBe(false);
});

test("a checksum mismatch refuses to install", async () => {
  const { home, base } = fixture(true);
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain("checksum mismatch");
  expect(existsSync(join(home, ".local", "share", "omnigateway", "current"))).toBe(false);
  expect(existsSync(join(home, ".config", "omnigateway", ".env"))).toBe(false);
});

test("an unsupported uname -m refuses with the supported list", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_INSTALL_UNAME_M: "mips" },
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr).toContain("linux-x64");
  expect(run.stderr).toContain("darwin-arm64");
  expect(existsSync(join(home, ".local", "share", "omnigateway"))).toBe(false);
});

test("XDG_CONFIG_HOME does not move the root: the CLI hardcodes ~/.config/omnigateway", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: {
      OMNI_ADMIN_PASSWORD: "correct horse battery staple",
      XDG_CONFIG_HOME: join(home, "xdg-elsewhere"),
    },
  });
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(home, ".config", "omnigateway", ".env"))).toBe(true);
  expect(existsSync(join(home, "xdg-elsewhere", "omnigateway"))).toBe(false);
});
