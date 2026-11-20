import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { databaseState } from "./database-state.ts";
import { adapterCases } from "./db-adapter-cases.ts";
import { fileState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const root = mkdtempSync("/tmp/opencode/e1-e5/db-backup-");
mkdirSync(join(root, "request_bodies"));
writeFileSync(join(root, "request_bodies/sentinel"), "body sentinel");
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1" };
const store = await createStore({
  path: join(root, "seed"),
  encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY),
});
store.close();
const commands = [
  ["bun", "--no-env-file", resolve("apps/cli/src/index.ts")],
  [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")],
];
let count = 0;
try {
  count += await adapterCases(commands, join(root, "seed"), env, "backup");
  for (const kind of ["collision", "wal-refusal"]) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, `db${suffix}`), { force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      mkdirSync(join(root, "snapshots"));
      const live = new Database(join(root, "db"));
      try {
        if (kind === "wal-refusal") {
          live.run("PRAGMA journal_mode=WAL");
          live.run("PRAGMA wal_autocheckpoint=0");
          live.run("CREATE TABLE wal_refusal(value)");
          live.run("INSERT INTO wal_refusal VALUES ('sentinel')");
          assert(readFileSync(join(root, "db-wal")).length > 32);
        } else {
          // Neither CLI exposes a clock override. Occupy every millisecond in a
          // bounded window; require the conflict diagnostic so expiration fails
          // the fixture rather than masking an accidentally successful backup.
          const start = Date.now();
          for (let at = start; at < start + 30000; at++) {
            const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
            writeFileSync(
              join(root, "snapshots", `db_${stamp}_manual.sqlite`),
              "existing snapshot sentinel",
            );
          }
        }
        const state = () => fileState(root);
        const before = state();
        const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup"], {
          env: { ...env, ...(kind === "wal-refusal" ? { OMNI_ENCRYPTION_KEY: "short" } : {}) },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(p.stdout).text();
        const err = (await new Response(p.stderr).text()).replace(
          /db_[\dTZ-]+_manual\.sqlite/g,
          "<id>",
        );
        const code = await p.exited;
        assert.equal(code, 1);
        if (kind === "collision") assert.match(err, /a snapshot for this instant already exists/);
        else assert.match(err, /OMNI_ENCRYPTION_KEY/);
        assert.deepEqual(state(), before);
        results.push({ out, err, code });
      } finally {
        chmodSync(join(root, "snapshots"), 0o700);
        live.close();
      }
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const kind of ["file", "unwritable"]) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      if (kind === "file") writeFileSync(join(root, "snapshots"), "sentinel");
      else {
        mkdirSync(join(root, "snapshots"));
        chmodSync(join(root, "snapshots"), 0o500);
      }
      const state = () => fileState(root);
      const before = state();
      const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      const err = (await new Response(p.stderr).text()).replace(
        /db_[\dTZ-]+_manual\.sqlite/g,
        "<id>",
      );
      const code = await p.exited;
      assert.equal(code, 1);
      assert.deepEqual(state(), before);
      if (kind === "file") assert.equal(readFileSync(join(root, "snapshots"), "utf8"), "sentinel");
      else {
        assert.deepEqual(readdirSync(join(root, "snapshots")), []);
        chmodSync(join(root, "snapshots"), 0o700);
      }
      results.push({ out, err, code });
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const live = new Database(join(root, "db"));
      live.run("CREATE TABLE broken(value)");
      live.run("INSERT INTO broken VALUES (zeroblob(100000))");
      const page = live
        .query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_master WHERE name='broken'")
        .get()?.rootpage;
      const size = live.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size;
      assert(page && size, "missing SQLite page geometry");
      live.close();
      const bytes = readFileSync(join(root, "db"));
      bytes[(page - 1) * size] = 255;
      writeFileSync(join(root, "db"), bytes);
      mkdirSync(join(root, "snapshots"));
      const state = () => fileState(root);
      const before = state();
      const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      const code = await p.exited;
      assert.equal(code, 1);
      assert.match(err, /database disk image is malformed/);
      assert.deepEqual(state(), before);
      assert.deepEqual(readdirSync(join(root, "snapshots")), []);
      results.push({ out, err, code });
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const bad of [true, false])
    for (const json of [false, true]) {
      const results = [];
      for (const cmd of commands) {
        for (const suffix of ["", "-wal", "-shm"])
          rmSync(join(root, `db${suffix}`), { force: true });
        rmSync(join(root, "snapshots"), { recursive: true, force: true });
        copyFileSync(join(root, "seed"), join(root, "db"));
        mkdirSync(join(root, "snapshots"));
        writeFileSync(join(root, "snapshots", "unmanaged"), "keep");
        writeFileSync(join(root, "snapshots", "db_2000-01-01T00-00-00-000Z_manual.sqlite"), "old");
        writeFileSync(
          join(root, "snapshots", "db_2025-02-30T00-00-00-000Z_manual.sqlite"),
          "overflow date",
        );
        writeFileSync(
          join(root, "snapshots", "db_2000-01-02T00-00-00-000Z_preRestore.sqlite"),
          "undo",
        );
        const before = fileState(root);
        const p = goldenSpawn(
          [...cmd, "--root", root, "--db", "db", "db", "backup", ...(json ? ["--json"] : [])],
          {
            env: { ...env, ...(bad ? { OMNI_ENCRYPTION_KEY: "short" } : {}) },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        let out = await new Response(p.stdout).text();
        const err = await new Response(p.stderr).text();
        const code = await p.exited;
        assert.equal(code, bad ? 1 : 0);
        let snapshotRows: ReturnType<typeof databaseState> | undefined;
        if (bad) {
          assert.deepEqual(fileState(root), before);
        } else {
          const ids = readdirSync(join(root, "snapshots")).filter((x) =>
            x.endsWith("_manual.sqlite"),
          );
          assert.equal(ids.length, 1);
          assert(
            readdirSync(join(root, "snapshots")).includes(
              "db_2000-01-02T00-00-00-000Z_preRestore.sqlite",
            ),
          );
          assert.equal(readFileSync(join(root, "snapshots", "unmanaged"), "utf8"), "keep");
          const db = new Database(join(root, "snapshots", ids[0]), { readonly: true });
          assert.equal(
            db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
            "ok",
          );
          snapshotRows = databaseState(db);
          const live = new Database(join(root, "db"), { readonly: true });
          assert.deepEqual(snapshotRows, databaseState(live));
          live.close();
          db.close();
          if (json) {
            const data = JSON.parse(out);
            assert.equal(data.id, ids[0]);
            assert.equal(typeof data.createdAt, "number");
            data.id = data.filename = "<id>";
            data.createdAt = "<time>";
            out = JSON.stringify(data);
          } else
            out = out
              .replace(/db_[\dTZ-]+_manual\.sqlite/g, "<id>")
              .replace(/(taken +)[^\n]+/, "$1<time>");
        }
        results.push({ out, err, code, snapshotRows });
      }
      assert.deepEqual(results[1], results[0]);
      count++;
    }
  for (const [value, expected] of [
    ["3", 3],
    ["garbage", 1],
    [-2, 1],
    [2.5, 3],
    [1e300, 5],
  ] as const) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const live = new Database(join(root, "db"));
      live.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('settings',?)", [
        JSON.stringify({ snapshotKeepLatest: value, snapshotMaxAgeDays: 1e300 }),
      ]);
      live.close();
      mkdirSync(join(root, "snapshots"));
      for (let day = 1; day <= 4; day++)
        writeFileSync(
          join(root, "snapshots", `db_2025-01-0${day}T00-00-00-000Z_manual.sqlite`),
          "old",
        );
      const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = JSON.parse(await new Response(p.stdout).text());
      const err = await new Response(p.stderr).text();
      const code = await p.exited;
      assert.equal(code, 0);
      assert.equal(err, "");
      const names = readdirSync(join(root, "snapshots"))
        .filter((n) => n !== out.id)
        .sort();
      assert.equal(names.length + 1, expected);
      results.push(names);
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const [value, expected] of [
    ["3", 4],
    ["garbage", 1],
    [-2, 1],
    [2.5, 3],
    [1e300, 5],
  ] as const) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const live = new Database(join(root, "db"));
      live.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('settings',?)", [
        JSON.stringify({ snapshotKeepLatest: 100, snapshotMaxAgeDays: value }),
      ]);
      live.close();
      mkdirSync(join(root, "snapshots"));
      for (const age of [1, 2, 2.75, 4]) {
        const stamp = new Date(Date.now() - age * 86400000).toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(root, "snapshots", `db_${stamp}_manual.sqlite`), String(age));
      }
      const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = JSON.parse(await new Response(p.stdout).text());
      const err = await new Response(p.stderr).text();
      assert.equal(await p.exited, 0);
      assert.equal(err, "");
      const kept = readdirSync(join(root, "snapshots"))
        .filter((n) => n !== out.id)
        .map((n) => readFileSync(join(root, "snapshots", n), "utf8"))
        .sort();
      assert.equal(kept.length + 1, expected);
      results.push(kept);
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  for (const reasons of [
    ["manual", "preRestore"],
    ["preRestore", "manual"],
  ]) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const live = new Database(join(root, "db"));
      live.run("INSERT OR REPLACE INTO settings(key,value) VALUES ('settings',?)", [
        JSON.stringify({ snapshotKeepLatest: 1, snapshotMaxAgeDays: 1e300 }),
      ]);
      live.close();
      mkdirSync(join(root, "snapshots"));
      for (const reason of reasons)
        writeFileSync(
          join(root, "snapshots", `db_2099-01-01T00-00-00-000Z_${reason}.sqlite`),
          "tie",
        );
      const enumeration = readdirSync(join(root, "snapshots"));
      const listing = goldenSpawn(
        [...cmd, "--root", root, "--db", "db", "db", "snapshots", "--json"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      const listed = JSON.parse(await new Response(listing.stdout).text()).snapshots.map(
        (s: { id: string }) => s.id,
      );
      assert.equal(await new Response(listing.stderr).text(), "");
      assert.equal(await listing.exited, 0);
      assert.deepEqual(listed, enumeration);
      const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup", "--json"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = JSON.parse(await new Response(p.stdout).text());
      assert.equal(out.reason, "manual");
      assert.equal(await new Response(p.stderr).text(), "");
      assert.equal(await p.exited, 0);
      const kept = readdirSync(join(root, "snapshots")).sort();
      assert.deepEqual(
        kept,
        enumeration.filter((name, i) => i === 0 || name.includes("preRestore")).sort(),
      );
      results.push({ enumeration, listed, kept });
    }
    assert.deepEqual(results[1], results[0], "same creation sequence must enumerate identically");
    count += 2;
  }
  {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root, "snapshots"), { recursive: true, force: true });
      copyFileSync(join(root, "seed"), join(root, "db"));
      const live = new Database(join(root, "db"));
      try {
        live.run("PRAGMA journal_mode=WAL");
        live.run("PRAGMA wal_autocheckpoint=0");
        live.run("CREATE TABLE wal_fixture(value)");
        live.run("INSERT INTO wal_fixture VALUES ('committed in WAL')");
        assert(readFileSync(join(root, "db-wal")).length > 32);
        const p = goldenSpawn([...cmd, "--root", root, "--db", "db", "db", "backup", "--json"], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = JSON.parse(await new Response(p.stdout).text());
        assert.equal(await new Response(p.stderr).text(), "");
        assert.equal(await p.exited, 0);
        const snapshot = new Database(join(root, "snapshots", out.id), { readonly: true });
        const state = databaseState(snapshot);
        assert.deepEqual(state, databaseState(live));
        snapshot.close();
        results.push(state);
      } finally {
        live.close();
      }
    }
    assert.deepEqual(results[1], results[0]);
    count++;
  }
  await verifyGoldenExits("db-backup");
  console.log(`PASS ${count} backup comparisons`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
