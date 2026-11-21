/**
 * The npm 0.x → Rust upgrade, end to end, with the real npm and real packages.
 *
 * Run ONLY through `upgrade-ns.sh` (private network, HOME and prefix). It:
 *  1. installs the published TS `omnigateway@0.15.5` tarball globally from a
 *     local registry, writes the TS systemd unit with that CLI, migrates a
 *     database, mints a key and starts the unit through a fake systemctl that
 *     really runs ExecStart;
 *  2. publishes the five 1.0.0 packages built by `scripts/build-npm.ts` from a
 *     release archive of the binary under test, and runs `npm update -g`;
 *  3. asserts, per scenario, what the user sees afterwards.
 *
 * Scenarios: `scripts` (postinstall allowed: migrates at install time) and
 * `blocked` (npm 12's default script policy: the old unit's next restart runs
 * the gateway.js bridge). Both end with a second update (1.0.1) that restarts
 * the service onto the replaced binary. `foreign`: another process (here a
 * second SQLite connection under its own process) keeps the database open, so
 * the exclusive lock refuses after the stop: nothing is rewritten, the service
 * is left stopped, the record says why.
 *
 * Usage: bun upgrade.ts <ts-0.15.5.tgz> <release omnigateway binary> <scratch> <scripts|blocked>
 */
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildPackages } from "../../scripts/build-npm.ts";

const [tsTarball, binary, scratch, scenario] = process.argv.slice(2);
if (
  !tsTarball ||
  !binary ||
  !scratch ||
  !["scripts", "blocked", "foreign"].includes(scenario ?? "")
) {
  throw new Error("usage: upgrade.ts <ts.tgz> <binary> <scratch> <scripts|blocked|foreign>");
}
const repo = resolve(import.meta.dir, "../..");
const home = join(scratch, "home");
const prefix = join(scratch, "prefix");
const registryDir = join(scratch, "registry");
const fake = join(scratch, "systemd");
const root = join(home, ".config", "omnigateway");
const stub = join(scratch, "stub-bin");
for (const dir of [home, prefix, registryDir, fake, root, stub])
  mkdirSync(dir, { recursive: true });
symlinkSync(join(repo, "conformance/npm/fake-systemctl.py"), join(stub, "systemctl"));
const PORT = 19_431;
writeFileSync(
  join(root, ".env"),
  `OMNI_ENCRYPTION_KEY=${"k".repeat(44)}\nOMNI_HOST=127.0.0.1\nOMNI_PORT=${PORT}\n`,
);

const env: Record<string, string> = {
  PATH: `${join(prefix, "bin")}:${stub}:${process.env.PATH}`,
  HOME: home,
  XDG_STATE_HOME: join(home, ".local", "state"),
  FAKE_SYSTEMD: fake,
  npm_config_prefix: prefix,
  npm_config_cache: join(scratch, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  NO_COLOR: "1",
};
const transcript: unknown[] = [];
function sh(argv: string[], options: { ok?: boolean; cwd?: string } = {}) {
  const p = Bun.spawnSync(argv, { cwd: options.cwd ?? root, env, stdout: "pipe", stderr: "pipe" });
  const record = {
    argv,
    exit: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
  transcript.push(record);
  if (options.ok !== false) assert.equal(p.exitCode, 0, JSON.stringify(record, null, 1));
  return record;
}
const save = () =>
  writeFileSync(join(scratch, "transcript.json"), JSON.stringify(transcript, null, 1));

async function healthy(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch {}
    await Bun.sleep(100);
  }
  return false;
}
const recordPath = join(home, ".local/state/omnigateway/npm-migration.json");
async function migrationRecord(done: (r: { status?: string }) => boolean) {
  for (let i = 0; i < 350; i++) {
    if (existsSync(recordPath)) {
      const r = JSON.parse(readFileSync(recordPath, "utf8"));
      if (done(r)) return r;
    }
    await Bun.sleep(100);
  }
  throw new Error(`no migration record at ${recordPath}`);
}
const servicePid = () => Number(readFileSync(join(fake, "pid"), "utf8"));
const unitPath = join(home, ".config/systemd/user/omnigateway.service");
const exe = (pid: number) => {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
};

/** Five 1.0.x tarballs from a release archive holding `binary`. */
async function publish(version: string, bytes: string): Promise<void> {
  const assets = join(scratch, `assets-${version}`);
  const stage = join(scratch, `stage-${version}`);
  mkdirSync(join(stage, "public"), { recursive: true });
  copyFileSync(bytes, join(stage, "omnigateway"));
  chmodSync(join(stage, "omnigateway"), 0o755);
  cpSync(join(repo, "apps/dashboard/dist"), join(stage, "public"), { recursive: true });
  copyFileSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
  symlinkSync("omnigateway", join(stage, "omni"));
  mkdirSync(assets);
  for (const target of [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
  ]) {
    const tar = Bun.spawnSync([
      "tar",
      "-czf",
      join(assets, `omnigateway-v${version}-${target}.tar.gz`),
      "-C",
      stage,
      ".",
    ]);
    assert.equal(tar.exitCode, 0);
  }
  const out = join(scratch, `npm-${version}`);
  for (const dir of await buildPackages({ version, assets, out })) {
    sh(["npm", "pack", "--pack-destination", registryDir, dir], { cwd: dir });
  }
}

const registry = Bun.spawn(
  ["bun", "--no-env-file", join(import.meta.dir, "registry.ts"), registryDir],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
);
const ready = await registry.stdout.getReader().read();
env.npm_config_registry = `${new TextDecoder().decode(ready.value).trim()}/`;
try {
  // 1. The 0.x world: published TS package, its own unit and database.
  copyFileSync(tsTarball, join(registryDir, "omnigateway-0.15.5.tgz"));
  sh(["npm", "install", "-g", "omnigateway@0.15.5"]);
  sh(["omni", "db", "migrate"]);
  const key = JSON.parse(sh(["omni", "keys", "create", "--label", "before", "--json"]).stdout);
  sh(["omni", "service", "install", "--enable"]);
  const tsUnit = readFileSync(unitPath, "utf8");
  assert.match(tsUnit, /ExecStart=\S+bun \S+\/node_modules\/omnigateway\/gateway\.js\n/);
  // The owner's own unit carries operator lines; they must survive.
  writeFileSync(
    unitPath,
    tsUnit.replace("Restart=", `StandardOutput=append:${join(root, "gateway.log")}\nRestart=`),
  );
  sh(["systemctl", "--user", "daemon-reload"]);
  sh(["systemctl", "--user", "start", "omnigateway.service"]);
  assert(await healthy(), "TS gateway did not start");
  const tsPid = servicePid();
  assert.match(exe(tsPid), /bun/);

  // 2. The update.
  await publish("1.0.0", binary);
  if (scenario === "foreign") {
    // Holds a shared lock in a separate process the whole time; /proc shows
    // it, so this is refused before the stop. That is the visible-holder path.
    const holder = Bun.spawn(
      [
        "python3",
        "-c",
        `import sqlite3,time,sys;c=sqlite3.connect(${JSON.stringify(join(root, "omnigateway.db"))});c.execute('begin');c.execute('select count(*) from api_keys').fetchall();print('held',flush=True);time.sleep(120)`,
      ],
      { stdout: "pipe" },
    );
    await holder.stdout.getReader().read();
    const out = sh([
      "npm",
      "update",
      "-g",
      "omnigateway",
      "--foreground-scripts",
      "--allow-scripts=omnigateway",
    ]);
    holder.kill();
    assert.match(out.stdout + out.stderr, /is open in process \d+ besides the service/);
    assert.equal(readFileSync(unitPath, "utf8").includes("gateway.js"), true, "unit untouched");
    assert.equal(servicePid(), tsPid, "TS left running: refused before the stop");
    assert.equal(JSON.parse(readFileSync(recordPath, "utf8")).status, "skipped-writer");
    assert.match(
      sh(["omni", "doctor", "--json"]).stderr,
      /skipped-writer\): .* is open in process/,
    );
    console.log(JSON.stringify({ scenario, ok: true }));
    // `process.exit` skips `finally`: clean up here.
    sh(["systemctl", "--user", "stop", "omnigateway.service"], { ok: false });
    registry.kill();
    save();
    process.exit(0);
  }
  const update = ["npm", "update", "-g", "omnigateway", "--foreground-scripts"];
  if (scenario === "scripts") update.push("--allow-scripts=omnigateway");
  const updated = sh(update);
  const main = join(prefix, "lib/node_modules/omnigateway");
  // Global installs nest a package's dependencies under it.
  const native = realpathSync(join(main, "node_modules/@omnigateway/linux-x64/omnigateway"));
  assert.equal(JSON.parse(readFileSync(join(main, "package.json"), "utf8")).version, "1.0.0");
  assert.equal(sh(["omni", "--version"]).stdout.trim(), "1.0.0");

  const backups = () =>
    readdirSync(join(root, "snapshots")).filter((f) => f.endsWith("_preRust.sqlite"));
  if (scenario === "scripts") {
    for (const bin of ["omni", "omnigateway"]) {
      assert(lstatSync(join(main, "bin", bin)).isSymbolicLink(), `${bin} not linked`);
      assert.equal(realpathSync(join(prefix, "bin", bin)), native);
    }
    assert.match(updated.stdout + updated.stderr, /migrated .*omnigateway\.service/);
  } else {
    assert.match(updated.stderr, /install scripts blocked/);
    assert(!lstatSync(join(main, "bin", "omni")).isSymbolicLink(), "launcher expected");
    // TS still serves from memory until its next start; the CLI says so.
    assert.equal(servicePid(), tsPid);
    const doctor = sh(["omni", "doctor", "--json"]);
    assert.match(doctor.stderr, /old 0\.x systemd service is still installed/);
    // The next start of the old unit lands on the gateway.js bridge.
    sh(["systemctl", "--user", "restart", "omnigateway.service"]);
  }
  assert(await healthy(), "Rust gateway did not answer /health");
  // The bridge hands over to systemd, whose ExecStartPost verifier records
  // the outcome and removes itself; wait for it before reading the unit.
  const record = await migrationRecord((r) => r.status !== undefined && r.status !== "verifying");
  assert.equal(record.status, "migrated");
  // Only ExecStart changed; the operator's StandardOutput line survived.
  assert.equal(
    readFileSync(unitPath, "utf8"),
    tsUnit
      .replace("Restart=", `StandardOutput=append:${join(root, "gateway.log")}\nRestart=`)
      .replace(/ExecStart=.*\n/, `ExecStart=${native}\n`),
  );
  assert.equal(backups().length, 1, "one preRust backup");
  // The data came across: the key minted under TS authenticates against Rust.
  const models = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
    headers: { authorization: `Bearer ${key.key}` },
  });
  assert.equal(models.status, 200);
  const dashboard = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(dashboard.status, 200, "console served from the platform package's public/");
  assert.equal(sh(["omni", "doctor", "--json"]).stderr, "", "no banner after migration");
  if (scenario === "blocked") {
    // systemd, not the bridge, runs Rust: one verifier run, which passed,
    // and the binary is MainPID. Nothing left to restart.
    const posts = readFileSync(join(fake, "posts"), "utf8").trim().split("\n");
    assert.equal(posts.length, 1, posts.join("\n"));
    assert.match(posts[0] ?? "", /omni service migrate --verify-start exit=0$/);
    const servingPid = servicePid();
    const same = sh(["omni", "service", "migrate"]);
    assert.match(same.stderr, /no restart needed/);
    assert.equal(servicePid(), servingPid, "gateway left running");
  }
  assert.equal(exe(servicePid()), native);

  // 3. A later Rust update replaces the binary in place: restart onto it.
  const beforePid = servicePid();
  await publish("1.0.1", binary);
  const second = ["npm", "update", "-g", "omnigateway", "--foreground-scripts"];
  if (scenario === "scripts") {
    second.push("--allow-scripts=omnigateway");
    const out = sh(second);
    assert.match(out.stdout + out.stderr, /restarted omnigateway\.service on omnigateway/);
    assert(await healthy());
    assert.notEqual(servicePid(), beforePid);
    assert.equal(exe(servicePid()), native);
  } else {
    sh(second);
    // Scripts blocked: the running process keeps the old inode until a
    // restart, which `omni service migrate` performs on request.
    const manual = sh(["omni", "service", "migrate"]);
    assert.match(manual.stderr, /restarted omnigateway\.service/);
    assert(await healthy());
  }
  const last = await migrationRecord((r) => r.status === "restarted");
  // Both releases carry the same binary (compiled as 1.0.0), so the version
  // history is pinned by the unit tests, not here.
  assert.equal(last.status, "restarted");
  assert(existsSync(join(fake, "starts")));
  console.log(
    JSON.stringify({
      scenario,
      ok: true,
      starts: readFileSync(join(fake, "starts"), "utf8").trim().split("\n"),
    }),
  );
} finally {
  sh(["systemctl", "--user", "stop", "omnigateway.service"], { ok: false });
  registry.kill();
  save();
}
