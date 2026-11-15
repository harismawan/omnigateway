// Frozen swap characterization. Default runs TS only; --compare also runs Rust
// and is deliberately red until the accepted-confirmation path is implemented.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { databaseState } from "./database-state.ts";
import { restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";

const base = mkdtempSync("/tmp/opencode/e1-e5/db8-swap-");
const commands = [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")]];
if (process.argv.includes("--compare")) commands.push([resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]);
const id = "db_2026-11-01T00-00-00-000Z_manual.sqlite";
const stale = "db_2000-01-01T00-00-00-000Z_manual.sqlite";
const cases = [
  { name: "yes-human", json: false, tty: false, hashes: [] },
  { name: "yes-json-admin", json: true, tty: false, hashes: ["adminPasswordHash"] },
  { name: "terminal-human-viewer", json: false, tty: true, hashes: ["viewerPasswordHash"] },
  { name: "terminal-json-both", json: true, tty: true, hashes: ["adminPasswordHash", "viewerPasswordHash"] },
  { name: "older-ledger", json: true, tty: false, hashes: [], ledger: -1000 },
  { name: "newer-ledger", json: true, tty: false, hashes: [], ledger: 1000 },
  { name: "candidate-wal-only-row", json: true, tty: false, hashes: [], wal: true },
];
function rows(path: string) {
  const db = new Database(path, { readonly: true });
  try { return databaseState(db); } finally { db.close(); }
}
try {
  const seed = join(base, "seed");
  const store = await createStore({ path: seed, encryptionKey: await deriveKey("database-golden-secret") });
  store.close();
  for (const test of cases) {
    const results = [];
    let wal: Database | undefined;
    const walSource = join(base, "wal-source");
    for (const [index, command] of commands.entries()) {
      const root = join(base, `${test.name}-${index}`);
      mkdirSync(join(root, "snapshots"), { recursive: true });
      const live = join(root, "db"), candidate = join(root, "snapshots", id);
      copyFileSync(seed, live);
      const db = new Database(live);
      // Zero retention would remove the old manual sentinel if force were lost.
      db.run("INSERT INTO settings (key,value) VALUES ('settings', ?)", [JSON.stringify({snapshotKeepLatest: 0, snapshotMaxAgeDays: 0})]);
      for (const key of ["adminPasswordHash", "viewerPasswordHash"]) db.run("INSERT INTO settings (key,value) VALUES (?, 'old-hash')", [key]);
      db.run("CREATE TABLE plugin_restore_fixture (id TEXT PRIMARY KEY, value TEXT)");
      db.run("INSERT INTO plugin_restore_fixture VALUES ('old', 'old contents')");
      db.run("INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,detail_state,truncated) VALUES ('old',1,'old',1,'ready',0)");
      db.close();
      copyFileSync(live, candidate);
      const incoming = new Database(candidate);
      incoming.run("PRAGMA journal_mode=DELETE");
      incoming.run("UPDATE plugin_restore_fixture SET id='candidate',value='candidate contents'");
      incoming.run("DELETE FROM request_bodies");
      incoming.run("INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,detail_state,truncated) VALUES ('candidate',2,'candidate',2,'ready',0)");
      for (const key of test.hashes) incoming.run("UPDATE settings SET value='different-hash' WHERE key=?", [key]);
      if (test.ledger) incoming.run("UPDATE migrations SET id=id+?", [test.ledger]);
      incoming.close();
      const installedRows = rows(candidate);
      if (test.wal) {
        if(!wal) {
        copyFileSync(candidate,walSource);
        wal = new Database(walSource);
        wal.run("PRAGMA journal_mode=WAL");
        wal.run("PRAGMA wal_autocheckpoint=0");
        wal.run("INSERT INTO settings (key,value) VALUES ('wal-only','lost on restore')");
        }
        for(const suffix of ["","-wal","-shm"])copyFileSync(walSource+suffix,candidate+suffix);
        assert(readFileSync(candidate + "-wal").length > 0);
      }
      copyFileSync(seed, join(root, "snapshots", stale));
      const oldRows = rows(live), candidateRows = rows(candidate), candidateBytes = readFileSync(candidate);
      const env = { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1", PTY_NO_COLOR: "1", PTY_STDOUT_PIPE: "1" };
      async function run(snapshot: string, tty: boolean, json: boolean) {
        const args = [...command, "--root", root, "--db", "db", "db", "restore", snapshot, ...(json ? ["--json"] : []), ...(tty ? [] : ["--yes"])];
        const process = goldenSpawn(tty ? ["python3", resolve("conformance/cli/pty.py"), "y", ...args] : args, { env, stdout: "pipe", stderr: "pipe" });
        let [out, err, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
        if (tty) {
          assert.equal(err, "");
          const result = JSON.parse(out);
          out = Buffer.from(result.stdout, "hex").toString(); err = Buffer.from(result.bytes, "hex").toString(); code = result.code;
        }
        return { out, err, code };
      }
      const result = await run(id, test.tty, test.json);
      // A changed ledger is accepted by inspection, but missing migration 001
      // makes reopen rerun CREATE TABLE against existing tables after the rename.
      assert.equal(result.code, test.ledger ? 1 : 0, `${test.name}: ${result.err}`);
      const sidecars = ["-wal", "-shm"].map(suffix => existsSync(live + suffix) ? readFileSync(live + suffix).length : null);
      const undoIds = readdirSync(join(root, "snapshots")).filter(name => name.endsWith("_preRestore.sqlite"));
      assert.equal(undoIds.length, 1);
      const undo = undoIds[0];
      assert.match(undo, /^db_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_preRestore\.sqlite$/);
      assert.deepEqual(rows(join(root, "snapshots", undo)), oldRows, "undo contains every old table");
      assert.deepEqual(rows(live), installedRows, "candidate main file installed table by table (WAL excluded)");
      assert.deepEqual(readFileSync(candidate), candidateBytes, "candidate retained byte-identically");
      assert(existsSync(join(root, "snapshots", stale)), "forced undo skips all retention");
       assert(!existsSync(live + ".incoming"));
       const postState = restorePostState(root, undo);
      if (test.ledger) {
        assert.equal(result.out, "");
        assert.match(result.err, /the database swap failed and the database may be incomplete/);
      } else {
        if (test.json) {
          const data = JSON.parse(result.out);
          assert.deepEqual(Object.keys(data), ["ok", "counts", "preRestoreSnapshot", "adminPasswordChanged", "viewerPasswordChanged"]);
          assert.equal(data.ok, true);
          assert.equal(data.adminPasswordChanged, test.hashes.includes("adminPasswordHash"));
          assert.equal(data.viewerPasswordChanged, test.hashes.includes("viewerPasswordHash"));
          assert.equal(data.preRestoreSnapshot.id, undo);
          assert.equal(data.preRestoreSnapshot.filename, undo);
          assert.equal(data.preRestoreSnapshot.reason, "preRestore");
          assert.equal(data.preRestoreSnapshot.sizeBytes, readFileSync(join(root, "snapshots", undo)).length);
          assert.equal(data.preRestoreSnapshot.createdAt, Date.parse(undo.slice(3, 27).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z/, "T$1:$2:$3.$4Z")));
          assert.equal(data.counts.settings, candidateRows.find(([name]) => name === "settings")![1].length);
          assert.deepEqual(Object.keys(data.counts), ["api_keys", "credential_health", "credentials", "migrations", "quota_windows", "request_logs", "settings", "virtual_models"]);
          for (const [table, count] of Object.entries(data.counts)) assert.equal(count, candidateRows.find(([name]) => name === table)![1].length);
          if (test.wal) {
            assert.equal(data.counts.settings, 4);
            assert.equal(rows(live).find(([name]) => name === "settings")![1].length, 3);
            assert.match(result.err, /settings\s+4\s+3/);
            console.log("candidate WAL hazard: preview/result settings=4; restored live settings=3; WAL-only row LOST");
          }
          data.preRestoreSnapshot.id = data.preRestoreSnapshot.filename = "<undo>";
          data.preRestoreSnapshot.createdAt = "<time>";
          result.out = JSON.stringify(data);
        } else {
          assert.match(result.out, new RegExp(`restored +${id.replaceAll(".", "\\.")}`));
          assert(result.out.includes(undo));
          result.out = result.out.replaceAll(undo, "<undo>");
        }
        // Restore the undo through the same public command, not by copying it.
        const roundtrip = await run(undo, false, true);
        assert.equal(roundtrip.code, 0, roundtrip.err);
        assert.deepEqual(rows(live), oldRows, "round trip restores every original table");
        assert.equal(readdirSync(join(root, "snapshots")).filter(name => name.endsWith("_preRestore.sqlite")).length, 2);
      }
      result.err = result.err.replaceAll(root, "<root>");
       results.push({ result, sidecars, postState });
      console.log(`${test.name} ${index === 0 ? "TS" : "Rust"}: exit=${result.code}, sidecars=${JSON.stringify(sidecars)}, undo retained, incoming absent`);
    }
    wal?.close();
    if (results.length === 2) assert.deepEqual(results[1], results[0], test.name);
  }
  console.log(`PASS ${cases.length} frozen swap characterizations${commands.length === 2 ? " with Rust parity" : " (TS only)"}; 5 round trips`);
  await verifyGoldenExits("db-restore-swap");
} finally { rmSync(base, { recursive: true, force: true }); }
