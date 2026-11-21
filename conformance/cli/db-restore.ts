import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { adapterCases } from "./db-adapter-cases.ts";
import { fileState, restorePostState } from "./db-file-state.ts";
import { checkPreviewGoldens } from "./db-preview-goldens.ts";
import { refusalStateCases } from "./db-refusal-state-cases.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

checkPreviewGoldens();
const root = mkdtempSync("/tmp/opencode/e1-e5/db7-restore-");
mkdirSync(join(root, "request_bodies"));
writeFileSync(join(root, "request_bodies/sentinel"), "body sentinel");
const env = {
  ...process.env,
  HOME: root,
  XDG_STATE_HOME: join(root, "state"),
  OMNI_ENCRYPTION_KEY: "database-golden-secret",
  NO_COLOR: "1",
};
const store = await createStore({
  path: join(root, "seed"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
const unit = join(root, ".config/systemd/user/omnigateway.service");
mkdirSync(join(root, ".config/systemd/user"), { recursive: true });
mkdirSync(join(root, "state/omnigateway"), { recursive: true });
mkdirSync(join(root, "bin"));
mkdirSync(join(root, "snapshots"));
writeFileSync(join(root, "snapshots/sentinel"), "snapshot sentinel");
writeFileSync(
  join(root, "bin/systemctl"),
  '#!/bin/sh\ncase "$*" in *is-active*) echo active;; *) echo 0;; esac\n',
  { mode: 0o755 },
);
const state = () => fileState(root);
let count = 0;
try {
  count += await refusalStateCases(commands, join(root, "seed"), env);
  count += await adapterCases(commands, join(root, "seed"), env, "restore");
  for (const kind of ["missing", "pid", "supervisor"]) {
    const results = [];
    for (const cmd of commands) {
      copyFileSync(join(root, "seed"), join(root, "db"));
      rmSync(unit, { force: true });
      rmSync(join(root, "state/omnigateway/gateway.pid"), { force: true });
      if (kind === "pid")
        writeFileSync(join(root, "state/omnigateway/gateway.pid"), String(process.pid));
      if (kind === "supervisor") writeFileSync(unit, "fixture");
      const before = state();
      const p = goldenSpawn(
        [
          ...cmd,
          "--root",
          root,
          "--db",
          "db",
          "db",
          "restore",
          ...(kind === "missing" ? [] : ["absent"]),
        ],
        {
          env: { ...env, PATH: `${root}/bin:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const result = {
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      };
      assert.equal(result.code, kind === "missing" ? 2 : 1);
      assert.deepEqual(state(), before);
      results.push(result);
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  const id = "db_2026-11-01T00-00-00-000Z_manual.sqlite";
  for (const command of [["db", "restore", id, "--yes"], ["status"], ["status", "--json"]]) {
    const results = [];
    for (const cmd of commands) {
      rmSync(unit, { force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      copyFileSync(join(root, "seed"), join(root, "snapshots", id));
      const pidfile = join(root, "state/omnigateway/gateway.pid");
      writeFileSync(pidfile, String(process.pid));
      chmodSync(pidfile, 0o600);
      const before = state();
      chmodSync(pidfile, 0);
      try {
        const p = goldenSpawn([...cmd, "--root", root, "--db", "db", ...command], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const result = {
          out: await new Response(p.stdout).text(),
          err: await new Response(p.stderr).text(),
          code: await p.exited,
        };
        assert.equal(result.code, 1);
        assert.equal(result.out, "");
        assert(result.err.includes(`EACCES: permission denied, open '${pidfile}'`));
        assert.equal(lstatSync(pidfile).mode & 0o7777, 0);
        chmodSync(pidfile, 0o600);
        assert.deepEqual(state(), before);
        results.push(result);
      } finally {
        chmodSync(pidfile, 0o600);
        assert.equal(readFileSync(pidfile, "utf8"), String(process.pid));
        rmSync(pidfile);
      }
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const kind of [
    "absent",
    "slash",
    "backslash",
    "dotdot",
    "symlink",
    "directory",
    "empty",
    "unparsed",
    "garbage",
    "foreign-few",
    "foreign-many",
    "older",
    "newer",
    "truncated",
  ]) {
    const results = [],
      after = [];
    for (const cmd of commands) {
      rmSync(unit, { force: true });
      rmSync(join(root, "state/omnigateway/gateway.pid"), { force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const candidate = join(root, "snapshots", id);
      rmSync(candidate, { recursive: true, force: true });
      for (const suffix of ["-wal", "-shm"]) rmSync(candidate + suffix, { force: true });
      if (kind === "symlink") symlinkSync(join(root, "seed"), candidate);
      if (kind === "directory") mkdirSync(candidate);
      if (kind === "empty") writeFileSync(candidate, "");
      if (kind === "garbage") writeFileSync(candidate, "not a SQLite database");
      if (kind.startsWith("foreign-")) {
        const db = new Database(candidate);
        for (const name of kind === "foreign-few"
          ? ["zebra", "apple"]
          : ["zebra", "apple", "bravo", "delta", "echo", "foxtrot", "golf"])
          db.run(`CREATE TABLE ${name}(id INTEGER)`);
        db.close();
      }
      if (kind === "older" || kind === "newer") {
        copyFileSync(join(root, "seed"), candidate);
        const db = new Database(candidate);
        db.run("PRAGMA journal_mode=DELETE");
        db.run(`UPDATE migrations SET id=id${kind === "older" ? "-1000" : "+1000"}`);
        db.close();
      }
      if (kind === "truncated")
        writeFileSync(candidate, readFileSync(join(root, "seed")).subarray(0, 5000));
      const input =
        (
          {
            slash: `sub/${id}`,
            backslash: `sub\\${id}`,
            dotdot: `../${id}`,
            unparsed: "sentinel",
          } as Record<string, string>
        )[kind] ?? id;
      const before = state();
      const accepted = kind === "older" || kind === "newer";
      const p = goldenSpawn(
        [
          ...cmd,
          "--root",
          root,
          "--db",
          "db",
          "db",
          "restore",
          input,
          ...(accepted ? ["--dry-run", "--json"] : []),
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const result = {
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      };
      assert.equal(result.code, accepted ? 0 : 1);
      if (kind === "truncated") after.push(state());
      else assert.deepEqual(state(), before, kind);
      results.push(result);
    }
    assert.deepEqual(results[1], results[0], kind);
    if (kind === "truncated") assert.deepEqual(after[1], after[0], kind);
    count++;
  }
  for (const json of [false, true]) {
    const results = [];
    for (const cmd of commands) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, "db") + suffix, { force: true });
      for (const suffix of ["", "-wal", "-shm"])
        rmSync(join(root, "snapshots", id) + suffix, { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      copyFileSync(join(root, "db"), join(root, "snapshots", id));
      const snapshot = new Database(join(root, "snapshots", id));
      snapshot.run("PRAGMA journal_mode=DELETE");
      snapshot.close();
      const db = new Database(join(root, "db"));
      db.run(
        "INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,detail_state,truncated) VALUES ('changed',1,'body',1,'ready',0)",
      );
      db.close();
      const before = state();
      const p = goldenSpawn(
        [
          ...cmd,
          "--root",
          root,
          "--db",
          "db",
          "db",
          "restore",
          id,
          "--dry-run",
          ...(json ? ["--json"] : []),
        ],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const result = {
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      };
      assert.equal(result.code, 0);
      assert.deepEqual(state(), before);
      results.push(result);
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const json of [false, true])
    for (const answer of ["pipe", "n", "", "something else", "y", "--yes"]) {
      const results = [];
      const yes = answer === "y" || answer === "--yes";
      for (const cmd of commands) {
        for (const name of readdirSync(join(root, "snapshots")))
          if (name.endsWith("_preRestore.sqlite")) rmSync(join(root, "snapshots", name));
        for (const suffix of ["", "-wal", "-shm"])
          rmSync(join(root, "db") + suffix, { force: true });
        copyFileSync(join(root, "seed"), join(root, "db"));
        const before = state();
        const tty = answer !== "pipe" && answer !== "--yes";
        const args = [
          ...cmd,
          "--root",
          root,
          "--db",
          "db",
          "db",
          "restore",
          id,
          ...(json ? ["--json"] : []),
          ...(answer === "--yes" ? ["--yes"] : []),
        ];
        const p = goldenSpawn(
          tty ? ["python3", resolve("conformance/cli/pty.py"), answer, ...args] : args,
          {
            env: { ...env, PTY_NO_COLOR: "1", PTY_STDOUT_PIPE: "1" },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        let out = await new Response(p.stdout).text(),
          err = await new Response(p.stderr).text(),
          code = await p.exited;
        if (tty) {
          assert.equal(err, "");
          const nested = JSON.parse(out);
          out = Buffer.from(nested.stdout, "hex").toString();
          err = Buffer.from(nested.bytes, "hex").toString();
          code = nested.code;
        }
        let postState: ReturnType<typeof restorePostState> | undefined;
        if (yes) {
          assert.equal(code, 0);
          const undo = readdirSync(join(root, "snapshots")).find((name) =>
            name.endsWith("_preRestore.sqlite"),
          )!;
          assert(undo);
          postState = restorePostState(root, undo);
          if (json) {
            const data = JSON.parse(out);
            data.preRestoreSnapshot.id = data.preRestoreSnapshot.filename = "<undo>";
            data.preRestoreSnapshot.createdAt = "<time>";
            out = JSON.stringify(data);
          } else out = out.replaceAll(undo, "<undo>");
        } else {
          assert.equal(code, 1);
          assert.equal(out, "");
          assert.deepEqual(state(), before);
        }
        assert(err.startsWith("TABLE"));
        const question = `replace ${join(root, "db")} with ${id}?`;
        if (!yes) assert(err.indexOf(question) > err.indexOf("SNAPSHOT"));
        if (tty) assert(err.includes(`${question} [y/N] `));
        if (!yes)
          assert(
            err.includes(answer === "pipe" ? `${question} — refusing without --yes` : "cancelled"),
          );
        results.push({ out, err, code, postState });
      }
      assert.deepEqual(results[1], results[0]);
      count++;
    }
  await verifyGoldenExits("db-restore");
  console.log(`PASS ${count} restore comparisons; 6 formatter goldens`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
