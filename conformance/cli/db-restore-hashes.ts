import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db15-hashes-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")]];
if(process.argv.includes("--compare"))commands.push([resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]);
const cases: [string,string|null,string|null,boolean][]=[
 ["blob-text","'abc'","X'616263'",true],["blob-blob","X'616263'","X'616263'",true],
 ["text-text","'abc'","'abc'",false],["integer-text","42","'42'",true],
 ["missing-present",null,"'abc'",true],["integer-real","42","42.0",false],
 ["real-real","1.5","1.5",false],["null-missing","NULL",null,false],
];
try {
 const seed=join(base,"seed");const store=await createStore({path:seed,encryptionKey:await deriveKey("database-golden-secret")});store.close();
 // Preserve SQLite storage classes, including NULL, rather than TEXT affinity coercion.
 const db=new Database(seed);db.run("DROP TABLE settings");db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value)");db.close();
 for(const [kind,before,after,changed] of cases)for(const json of [true,false]) {
  const results=[];
  for(const [index,command] of commands.entries()) {
   const root=join(base,`${kind}-${json}-${index}`),snapshots=join(root,"snapshots");mkdirSync(snapshots,{recursive:true});
   for(const [path,value] of [[join(root,"db"),before],[join(snapshots,id),after]] as const){copyFileSync(seed,path);const db=new Database(path);if(value!==null)db.run(`INSERT INTO settings VALUES ('adminPasswordHash',${value}),('viewerPasswordHash',${value})`);db.close();}
   const p=goldenSpawn([...command,"--root",root,"--db","db","db","restore",id,"--yes",...(json?["--json"]:[])],{env:{...process.env,HOME:root,XDG_STATE_HOME:join(root,"state"),OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
   let [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);const code=await p.exited;
   console.log(`${kind} ${json?"json":"human"} ${index===0?"TS":"Rust"}: exit=${code}, stdout=${JSON.stringify(out)}, stderr=${JSON.stringify(err)}`);
   assert.equal(code,0);const undos=readdirSync(snapshots).filter(n=>n.endsWith("_preRestore.sqlite"));assert.equal(undos.length,1);
   const state=restorePostState(root,undos[0]);
   if(json){const data=JSON.parse(out);assert.equal(data.adminPasswordChanged,changed);assert.equal(data.viewerPasswordChanged,changed);data.preRestoreSnapshot.id=data.preRestoreSnapshot.filename="<undo>";data.preRestoreSnapshot.createdAt="<time>";out=JSON.stringify(data);}
   out=out.replaceAll(root,"<root>").replaceAll(undos[0],"<undo>");err=err.replaceAll(root,"<root>").replaceAll(undos[0],"<undo>");results.push({out,err,code,state});
  }
  if(results.length===2)assert.deepEqual(results[1],results[0],kind);
 }
 await verifyGoldenExits("db-restore-hashes");console.log("PASS 16 hash comparisons");
} finally {rmSync(base,{recursive:true,force:true});}
