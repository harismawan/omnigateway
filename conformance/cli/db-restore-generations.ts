// Additional swap observations: run frozen first; --compare adds Rust.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
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
   const start=Date.now();
   const p=goldenSpawn([...command,"--root",home,"--db","db","db","restore",id,"--yes","--json"],{env:{...process.env,HOME:home,XDG_STATE_HOME:join(home,"state"),OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
   const end=Date.now();
   assert.equal(code,0,err);
   const data=JSON.parse(out),undo=data.preRestoreSnapshot.id;
   assert.deepEqual(readFileSync(candidate),candidateBefore);
   const postState=restorePostState(home,undo);
   const db=new Database(live,{readonly:true});
   assert(db.query("PRAGMA table_info(api_keys)").all().some((c:any)=>c.name==="smart_routing"));
   const ledger=db.query("SELECT * FROM migrations ORDER BY id").all() as {id:number,applied_at:number}[];
   const ledgerPage=(db.query("SELECT rootpage FROM sqlite_master WHERE name='migrations'").get() as {rootpage:number}).rootpage;
   if(kind==="schema-21")assert.deepEqual(db.query("SELECT value FROM future_schema_fixture").all(),[{value:"future row"}]);
   db.close();
   if(writer) {
    const saved=new Database(join(home,"snapshots",undo),{readonly:true});
    assert.equal(saved.query("SELECT value FROM settings WHERE key='live-wal-only'").get().value,"undo must retain");saved.close();
   }
    if(kind==="schema-19") {
     const row=ledger.find(r=>r.id===20)!;
     assert(row.applied_at>=start && row.applied_at<=end,"migration timestamp inside command window");
     // Locate rowid 20's timestamp by decoding the SQLite table-leaf record,
     // rather than searching for coincidentally equal bytes or masking a page.
     const bytes=postState.find(e=>e.path==="db")!.bytes!;
     const pageSize=bytes.readUInt16BE(16)||65536, page=(ledgerPage-1)*pageSize;
     const header=page+(ledgerPage===1?100:0);
     assert.equal(bytes[header],13,"ledger is a table leaf");
     function varint(at:number):[number,number] {
      let value=0;
      for(let n=0;n<8;n++){const b=bytes[at++];value=value*128+(b&127);if(b<128)return [value,at];}
      return [value*256+bytes[at],at+1];
     }
     let timestampOffset:number|undefined;
     for(let i=0;i<bytes.readUInt16BE(header+3);i++) {
      const cell=page+bytes.readUInt16BE(header+8+i*2);
      const [length,next]=varint(cell),[rowid,record]=varint(next);
      if(rowid!==20)continue;
      const [headerLength,serials]=varint(record);
      const [idType,afterId]=varint(serials),[timeType,afterTime]=varint(afterId);
      assert.equal(idType,0);assert.equal(timeType,5,"six-byte timestamp");
      assert.equal(afterTime,record+headerLength);assert.equal(length,headerLength+6);
      timestampOffset=record+headerLength;
     }
     assert.notEqual(timestampOffset,undefined);
     assert.equal(bytes.readIntBE(timestampOffset!,6),row.applied_at);
     console.log(`schema-19 ${index===0?"TS":"Rust"}: timestamp bytes ${timestampOffset}–${timestampOffset!+5}, window ${start}..${end}, value ${row.applied_at}`);
     bytes.writeIntBE(0,timestampOffset!,6);
     row.applied_at=0;
    }
   data.preRestoreSnapshot.id=data.preRestoreSnapshot.filename="<undo>";data.preRestoreSnapshot.createdAt="<time>";
   results.push({data,err:err.replaceAll(home,"<root>"),code,postState,ledger});
   console.log(`${kind} ${index===0?"TS":"Rust"}: exit=${code}; candidate retained; ${kind==="live-wal"?"undo retains WAL-only row":kind==="schema-19"?"smart_routing column migrated":"future table and row retained"}`);
   writer?.close();
  }
  if(results.length===2) {
   const a=results[0].postState.find(e=>e.path==="db")!.bytes!,b=results[1].postState.find(e=>e.path==="db")!.bytes!;
   const offsets=Array.from({length:Math.max(a.length,b.length)},(_,i)=>i).filter(i=>a[i]!==b[i]);
   if(offsets.length)console.log(JSON.stringify({kind,entry:"live/db",offsets}));
   assert.deepEqual(results[1],results[0],kind);
  }
 }
  console.log("PASS 3 generation/live-WAL observations");
  await verifyGoldenExits("db-restore-generations");
} finally {rmSync(root,{recursive:true,force:true});}
