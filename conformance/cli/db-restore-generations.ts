// Additional swap observations: run frozen first; --compare adds Rust.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { restorePostState } from "./db-file-state.ts";
const root=mkdtempSync("/tmp/opencode/e1-e5/db13-generations-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")]];
if(process.argv.includes("--compare"))commands.push([resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]);
try {
 const seed=join(root,"seed");
 const store=await createStore({path:seed,encryptionKey:await deriveKey("database-golden-secret")});store.close();
 for(const kind of ["live-wal","schema-19","schema-21"]) {
  if(process.env.RESTORE_CASE && process.env.RESTORE_CASE!==kind)continue;
  const results=[];
  for(const [index,command] of commands.entries()) {
   const home=join(root,`${kind}-${index}`);mkdirSync(join(home,"snapshots"),{recursive:true});
   const live=join(home,"db"),candidate=join(home,"snapshots",id);
   copyFileSync(seed,live);copyFileSync(seed,candidate);
   const incoming=new Database(candidate);
   incoming.run("PRAGMA journal_mode=DELETE");
   if(kind==="schema-19") {
    incoming.run("ALTER TABLE api_keys DROP COLUMN smart_routing");
    incoming.run("DELETE FROM migrations WHERE id=20");
    assert.equal(incoming.query("SELECT max(id) AS id FROM migrations").get().id,19);
   }
   if(kind==="schema-21") {
    incoming.run("CREATE TABLE future_schema_fixture (value TEXT)");
    incoming.run("INSERT INTO future_schema_fixture VALUES ('future row')");
    incoming.run("INSERT INTO migrations (id,applied_at) VALUES (21,1)");
   }
   incoming.close();
   const candidateBefore=readFileSync(candidate);
   let writer:Database|undefined;
   if(kind==="live-wal") {
    writer=new Database(live);writer.run("PRAGMA journal_mode=WAL");writer.run("PRAGMA wal_autocheckpoint=0");
    writer.run("INSERT INTO settings (key,value) VALUES ('live-wal-only','undo must retain')");
    assert(readFileSync(live+"-wal").length>0);
   }
   const p=Bun.spawn([...command,"--root",home,"--db","db","db","restore",id,"--yes","--json"],{env:{...process.env,HOME:home,XDG_STATE_HOME:join(home,"state"),OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   assert.equal(code,0,err);
   const data=JSON.parse(out),undo=data.preRestoreSnapshot.id;
   assert.deepEqual(readFileSync(candidate),candidateBefore);
   const db=new Database(live,{readonly:true});
   assert(db.query("PRAGMA table_info(api_keys)").all().some((c:any)=>c.name==="smart_routing"));
   if(kind==="schema-19")console.log("migration 20",JSON.stringify(db.query("SELECT * FROM migrations WHERE id=20").get()));
   if(kind==="schema-21")assert.deepEqual(db.query("SELECT value FROM future_schema_fixture").all(),[{value:"future row"}]);
   db.close();
   if(writer) {
    const saved=new Database(join(home,"snapshots",undo),{readonly:true});
    assert.equal(saved.query("SELECT value FROM settings WHERE key='live-wal-only'").get().value,"undo must retain");saved.close();
   }
   const postState=restorePostState(home,undo);
   data.preRestoreSnapshot.id=data.preRestoreSnapshot.filename="<undo>";data.preRestoreSnapshot.createdAt="<time>";
   results.push({data,err:err.replaceAll(home,"<root>"),code,postState});
   console.log(`${kind} ${index===0?"TS":"Rust"}: exit=${code}; candidate retained; ${kind==="live-wal"?"undo retains WAL-only row":kind==="schema-19"?"smart_routing column migrated":"future table and row retained"}`);
   writer?.close();
  }
  if(results.length===2) {
   const a=results[0].postState.live[0] as Buffer,b=results[1].postState.live[0] as Buffer;
   const offsets=Array.from({length:Math.max(a.length,b.length)},(_,i)=>i).filter(i=>a[i]!==b[i]);
   if(offsets.length)console.log(JSON.stringify({kind,entry:"live/db",offsets}));
   assert.deepEqual(results[1],results[0],kind);
  }
 }
 console.log("PASS 3 generation/live-WAL observations");
} finally {rmSync(root,{recursive:true,force:true});}
