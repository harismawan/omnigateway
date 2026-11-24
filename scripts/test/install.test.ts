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
  readdirSync,
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
    if [ "\${OMNI_STUB_STATUS_NO_FIELD:-}" = 1 ]; then
      printf '{"process":{"running":false}}\\n'
    else
      printf '{"process":{"running":false},"adminConfigured":%s,"credentials":[],"storeError":null}\\n' "\${OMNI_STUB_ADMIN_CONFIGURED:-false}"
    fi
    exit "\${OMNI_STUB_STATUS_EXIT:-0}"
    ;;
  "doctor --json"|"omni doctor")
    printf '{"root":"%s","rootSource":"default"}\\n' "\${OMNI_STUB_DOCTOR_ROOT:-}"
    ;;
  "admin set-password")
    cat >> "$OMNI_STUB_STDIN"
    ;;
esac
exit 0
`;

/**
 * A GNU-style wget: `--spider -S` prints both the raw Location header and
 * wget's own "[following]" line; `-O <file> <url>` copies from the fake
 * release. Every invocation's argv is recorded.
 */
const WGET_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$WGET_STUB_LOG"
out=
url=
spider=0
prev=
for a in "$@"; do
  if [ "$prev" = -O ]; then out=$a; prev=; continue; fi
  case $a in
    --help) printf 'GNU Wget (stub)\\n      --spider\\n  -O, --output-document\\n'; exit 0 ;;
    --spider) spider=1 ;;
    -O) prev=-O ;;
    -*) ;;
    *) url=$a ;;
  esac
done
if [ "$spider" = 1 ]; then
  printf '  HTTP/1.1 302 Found\\n  Location: /tag/%s\\nLocation: /tag/%s [following]\\n' \\
    "$WGET_STUB_TAG" "$WGET_STUB_TAG" >&2
  exit 0
fi
case $url in
  */health) exit 0 ;;
esac
name=\${url##*/}
if [ "$out" = - ]; then
  cat "$WGET_STUB_ASSETS/$name"
else
  cp "$WGET_STUB_ASSETS/$name" "$out"
fi
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

/**
 * A bin dir mirroring the system dirs minus curl, wget and the systemd tools,
 * plus the wget stub: the only downloader on PATH is wget, and the script can
 * never reach real systemd.
 */
function wgetOnlyBin(dir: string): string {
  const bin = join(dir, "wget-bin");
  mkdirSync(bin);
  const seen = new Set(["curl", "wget", "systemctl", "loginctl"]);
  for (const sys of SYSTEM_PATH.split(":")) {
    if (!existsSync(sys)) continue;
    for (const name of readdirSync(sys)) {
      if (seen.has(name)) continue;
      seen.add(name);
      symlinkSync(join(sys, name), join(bin, name));
    }
  }
  writeFileSync(join(bin, "wget"), WGET_STUB);
  chmodSync(join(bin, "wget"), 0o755);
  return bin;
}

/**
 * A fake ip command answering the one query install.sh makes with chosen
 * global IPv4 addresses, so the detected default host is deterministic.
 * Unlinks first: in wgetOnlyBin the name is a symlink to the real system
 * binary.
 */
function writeIpStub(bin: string, addrs: string[]): void {
  mkdirSync(bin, { recursive: true });
  const lines = addrs
    .map((a, i) => `'${i + 2}: eth${i}    inet ${a}/24 scope global eth${i}'`)
    .join(" ");
  rmSync(join(bin, "ip"), { force: true });
  writeFileSync(join(bin, "ip"), `#!/bin/sh\nprintf '%s\\n' ${lines}\n`);
  chmodSync(join(bin, "ip"), 0o755);
}

// Async spawn: the fake release server shares this process's event loop, which
// a spawnSync would block while curl waits for it.
async function runInstall(options: {
  home: string;
  base: string;
  args: string[];
  env?: Record<string, string>;
  withBinOnPath?: boolean;
  pathPrepend?: string;
  pathOverride?: string;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { home, base, args, env } = options;
  let path = options.withBinOnPath ? `${home}/.local/bin:${SYSTEM_PATH}` : SYSTEM_PATH;
  if (options.pathPrepend) path = `${options.pathPrepend}:${path}`;
  if (options.pathOverride) path = options.pathOverride;
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

test("--yes without --base-url prefers a public address on an interface", async () => {
  const { dir, home, base } = fixture();
  const bin = join(dir, "ip-bin");
  writeIpStub(bin, ["10.20.30.40", "203.0.113.7"]);
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
    pathPrepend: bin,
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(join(home, ".config", "omnigateway"))).toContain(
    "OMNI_BASE_URL=http://203.0.113.7:9000",
  );
});

test("--yes without --base-url falls back to the first private address", async () => {
  const { dir, home, base } = fixture();
  const bin = join(dir, "ip-bin");
  writeIpStub(bin, ["192.168.1.50", "10.0.0.9"]);
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
    pathPrepend: bin,
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(join(home, ".config", "omnigateway"))).toContain(
    "OMNI_BASE_URL=http://192.168.1.50:9000",
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
  const { dir, home, base } = fixture();
  const bin = join(dir, "ip-bin");
  writeIpStub(bin, ["192.168.1.50"]);
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes"],
    env: { OMNI_STUB_ADMIN_CONFIGURED: "true" },
    pathPrepend: bin,
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

test("an existing .env is parsed like the CLI: export prefix, quotes, last occurrence wins", async () => {
  const { home, base } = fixture();
  const root = join(home, "quoted-root");
  mkdirSync(root, { recursive: true });
  const original =
    "# a comment\n\nOMNI_ENCRYPTION_KEY=keepme\nOMNI_PORT=1111\n" +
    'export OMNI_PORT="9200"\nOMNI_HOST=0.0.0.0\n' +
    "OMNI_BASE_URL='http://x.example.test:9200'\n";
  writeFileSync(join(root, ".env"), original);
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--root", root],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple" },
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(root)).toBe(original);
  expect(run.stdout).toContain("Dashboard: http://x.example.test:9200");
  expect(run.stdout).toContain("Port 9200 must be open");
});

test("detection through omnigateway on PATH calls it with omni doctor --json", async () => {
  const { dir, home, base } = fixture();
  const stubDir = join(dir, "bin");
  mkdirSync(stubDir);
  writeFileSync(join(stubDir, "omnigateway"), STUB);
  chmodSync(join(stubDir, "omnigateway"), 0o755);
  const root = join(home, "detected-root");
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: {
      OMNI_ADMIN_PASSWORD: "correct horse battery staple",
      OMNI_STUB_DOCTOR_ROOT: root,
    },
    pathPrepend: stubDir,
  });
  expect(run.exitCode).toBe(0);
  expect(calls(home)[0]).toBe("omni doctor --json");
  expect(calls(home)).toContain(`db migrate --root ${root}`);
});

test("a truncated download (first 60% of bytes) installs nothing under HOME", async () => {
  const { dir, home, base } = fixture();
  const bytes = readFileSync(script);
  const truncated = join(dir, "truncated.sh");
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const run = Bun.spawn(
    ["sh", truncated, "--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        PATH: SYSTEM_PATH,
        OMNI_INSTALL_BASE_URL: base,
        OMNI_INSTALL_UNAME_S: "Linux",
        OMNI_INSTALL_UNAME_M: "x86_64",
        OMNI_STUB_LOG: join(home, "calls.log"),
        OMNI_STUB_STDIN: join(home, "stdin.log"),
        OMNI_ADMIN_PASSWORD: "correct horse battery staple",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(readdirSync(home)).toEqual([]);
});

test("a user unit file gives the root and npm method; --method binary overrides the method", async () => {
  const { home, base } = fixture();
  const root = join(home, "unit-root");
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(
    join(unitDir, "omnigateway.service"),
    `[Service]\nWorkingDirectory=${root}\nExecStart=/usr/lib/node_modules/omnigateway/bin/omnigateway\n`,
  );
  const run = await runInstall({
    home,
    base,
    args: [
      "--no-service",
      "--yes",
      "--method",
      "binary",
      "--base-url",
      "http://gw.example.test:9000",
    ],
    env: {
      OMNI_ADMIN_PASSWORD: "correct horse battery staple",
      XDG_CONFIG_HOME: join(home, "xdg-elsewhere"),
    },
  });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain(`Found an existing installation (root: ${root}, method: binary)`);
  expect(calls(home)).toContain(`db migrate --root ${root}`);
});

const wgetEnv = (home: string, assets: string): Record<string, string> => ({
  OMNI_ADMIN_PASSWORD: "correct horse battery staple",
  WGET_STUB_LOG: join(home, "wget.log"),
  WGET_STUB_ASSETS: assets,
  WGET_STUB_TAG: TAG,
});

const wgetCalls = (home: string): string[] =>
  readFileSync(join(home, "wget.log"), "utf8")
    .split("\n")
    .filter((l) => l !== "");

test("GNU wget spider output resolves the tag, not the '[following]' line", async () => {
  const { dir, home, assets, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: wgetEnv(home, assets),
    pathOverride: wgetOnlyBin(dir),
  });
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
  const data = join(home, ".local", "share", "omnigateway");
  expect(readlinkSync(join(data, "current"))).toBe(join(data, TAG));
  expect(existsSync(join(data, TAG, "omnigateway"))).toBe(true);
  expect(run.stdout).toContain(`OmniGateway ${TAG} is ready`);
  expect(wgetCalls(home).some((l) => l.includes(`omnigateway-${TAG}-linux-x64.tar.gz`))).toBe(true);
});

test("wget health probe passes -t 1 and no external address lookup is made", async () => {
  const { dir, home, assets, base } = fixture();
  const bin = wgetOnlyBin(dir);
  writeIpStub(bin, ["203.0.113.7"]);
  const run = await runInstall({
    home,
    base,
    args: ["--version", TAG, "--yes"],
    env: wgetEnv(home, assets),
    pathOverride: bin,
  });
  expect(run.exitCode).toBe(0);
  expect(envFile(join(home, ".config", "omnigateway"))).toContain(
    "OMNI_BASE_URL=http://203.0.113.7:9000",
  );
  const health = wgetCalls(home).find((l) => l.includes("/health"));
  expect(health).toBeDefined();
  expect(health).toContain("-t 1");
  expect(wgetCalls(home).some((l) => /ipify|public-ip/.test(l))).toBe(false);
});

test("a failing omni status skips the password step with a warning, never resets", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple", OMNI_STUB_STATUS_EXIT: "1" },
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain("could not tell whether an admin password is set");
  expect(run.stderr).toContain(
    `omni admin set-password --root ${join(home, ".config", "omnigateway")}`,
  );
  expect(calls(home).some((c) => c.startsWith("admin set-password"))).toBe(false);
});

test("status output without adminConfigured also skips the password step", async () => {
  const { home, base } = fixture();
  const run = await runInstall({
    home,
    base,
    args: ["--no-service", "--yes", "--base-url", "http://gw.example.test:9000"],
    env: { OMNI_ADMIN_PASSWORD: "correct horse battery staple", OMNI_STUB_STATUS_NO_FIELD: "1" },
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toContain("could not tell whether an admin password is set");
  expect(calls(home).some((c) => c.startsWith("admin set-password"))).toBe(false);
});
