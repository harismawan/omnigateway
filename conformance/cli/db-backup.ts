import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const root = mkdtempSync("/tmp/opencode/e1-e5/db-backup-");
const env = { ...process.env, OMNI_ENCRYPTION_KEY: "database-golden-secret", NO_COLOR: "1" };
const store = await createStore({ path: join(root,"seed"), encryptionKey: await deriveKey(env.OMNI_ENCRYPTION_KEY) });
store.close();
const commands = [["bun", "--no-env-file", resolve("apps/cli/src/index.ts")], [resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]];
let count = 0;
try {
  for (const kind of ["file", "unwritable"]) {
    const results = [];
    for (const cmd of commands) {
      rmSync(join(root,"snapshots"), {recursive:true,force:true});
      copyFileSync(join(root,"seed"),join(root,"db"));
      if (kind === "file") writeFileSync(join(root,"snapshots"), "sentinel");
      else { mkdirSync(join(root,"snapshots")); chmodSync(join(root,"snapshots"),0o500); }
      const state = () => ["", "-wal", "-shm"].map(suffix => {
        try { return readFileSync(join(root,`db${suffix}`)); } catch (e: any) { if(e.code === "ENOENT") return null; throw e; }
      });
      const before = state();
      const p = goldenSpawn([...cmd,"--root",root,"--db","db","db","backup"],{env,stdout:"pipe",stderr:"pipe"});
      const out = await new Response(p.stdout).text();
      const err = (await new Response(p.stderr).text()).replace(/db_[\dTZ-]+_manual\.sqlite/g,"<id>");
      const code = await p.exited;
      assert.equal(code,1); assert.deepEqual(state(),before);
      if(kind === "file") assert.equal(readFileSync(join(root,"snapshots"),"utf8"),"sentinel");
      else { assert.deepEqual(readdirSync(join(root,"snapshots")),[]); chmodSync(join(root,"snapshots"),0o700); }
      results.push({out,err,code});
    }
    assert.deepEqual(results[1],results[0]); count++;
  }
  for (const bad of [true, false]) for (const json of [false, true]) {
    const results = [];
    for (const cmd of commands) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root,`db${suffix}`), {force:true});
      rmSync(join(root,"snapshots"), {recursive:true,force:true});
      copyFileSync(join(root,"seed"),join(root,"db"));
      mkdirSync(join(root,"snapshots"));
      writeFileSync(join(root,"snapshots","unmanaged"), "keep");
      writeFileSync(join(root,"snapshots","db_2000-01-01T00-00-00-000Z_manual.sqlite"), "old");
      writeFileSync(join(root,"snapshots","db_2025-02-30T00-00-00-000Z_manual.sqlite"), "overflow date");
      writeFileSync(join(root,"snapshots","db_2000-01-02T00-00-00-000Z_preRestore.sqlite"), "undo");
      const before = readFileSync(join(root,"db"));
      const p = goldenSpawn([...cmd,"--root",root,"--db","db","db","backup",...(json?["--json"]:[])],{env:{...env,...(bad?{OMNI_ENCRYPTION_KEY:"short"}:{})},stdout:"pipe",stderr:"pipe"});
      let out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      const code = await p.exited;
      assert.equal(code,bad?1:0);
      let snapshotRows;
      if (bad) {
        assert.deepEqual(readFileSync(join(root,"db")), before);
        for(const suffix of ["-wal","-shm"]) assert(!readdirSync(root).includes(`db${suffix}`));
      } else {
        const ids = readdirSync(join(root,"snapshots")).filter(x=>x.endsWith("_manual.sqlite"));
        assert.equal(ids.length,1);
        assert(readdirSync(join(root,"snapshots")).includes("db_2000-01-02T00-00-00-000Z_preRestore.sqlite"));
        assert.equal(readFileSync(join(root,"snapshots","unmanaged"),"utf8"),"keep");
        const db = new Database(join(root,"snapshots",ids[0]),{readonly:true});
        assert.equal((db.query("PRAGMA quick_check").get() as any).quick_check,"ok");
        snapshotRows = db.query("SELECT * FROM settings ORDER BY key").all();
        db.close();
        if(json) { const data=JSON.parse(out); assert.equal(data.id,ids[0]); assert.equal(typeof data.createdAt,"number"); data.id=data.filename="<id>";data.createdAt="<time>";out=JSON.stringify(data); }
        else out=out.replace(/db_[\dTZ-]+_manual\.sqlite/g,"<id>").replace(/(taken +)[^\n]+/,"$1<time>");
      }
      results.push({out,err,code,snapshotRows});
    }
    assert.deepEqual(results[1],results[0]); count++;
  }
  await verifyGoldenExits("db-backup");
  console.log(`PASS ${count} backup comparisons`);
} finally { rmSync(root,{recursive:true,force:true}); }
