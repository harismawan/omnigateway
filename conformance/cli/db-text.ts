// Lenient SQLite TEXT reads in inspection, stats and retention.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db18-text-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
try {
 const seed=join(base,"seed"),store=await createStore({path:seed,encryptionKey:await deriveKey("database-golden-secret")});store.close();
 const d=new Database(seed);d.run("CREATE TABLE z (value)");
 d.run("INSERT INTO settings VALUES ('settings',CAST(X'7b2278223a22ff227d' AS TEXT))");d.close();
 const mutation=Bun.spawnSync(["python3","-c","import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA writable_schema=ON'); c.execute(\"UPDATE sqlite_master SET name=CAST(X'ff' AS TEXT),tbl_name=CAST(X'ff' AS TEXT),sql=CAST(X'435245415445205441424c452022ff22202876616c756529' AS TEXT) WHERE name='z'\"); c.commit(); c.close()",seed]);assert.equal(mutation.exitCode,0,mutation.stderr.toString());
 for(const verb of ["backup","stats","restore"]) {
  const results=[];
  for(const [i,cmd] of [["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]].entries()) {
   const root=join(base,`${verb}-${i}`);mkdirSync(join(root,"snapshots"),{recursive:true});copyFileSync(seed,join(root,"db"));copyFileSync(seed,join(root,"snapshots",id));
   const p=goldenSpawn([...cmd,"--root",root,"--db","db","db",verb,...(verb==="restore"?[id,"--yes"]:[]),"--json"],{env:{...process.env,HOME:root,OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
   let out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text();const code=await p.exited;console.log(verb,i,code,out,err);assert.equal(code,0);
   const data=JSON.parse(out);if(verb==="stats")data.freeDiskBytes=0;
   const normalize=(s:string)=>s.replaceAll(root,"<root>").replace(/db_[\dTZ-]+_(manual|preRestore)\.sqlite/g,"<snapshot>").replace(/"createdAt":\d+/g,'"createdAt":0');
   results.push({out:normalize(JSON.stringify(data)),err:normalize(err),code,state:restorePostState(root,readdirSync(join(root,"snapshots")).filter(n=>n!==id))});
  }
  assert.deepEqual(results[1],results[0],verb);
 }
 await verifyGoldenExits("db-text");console.log("PASS 3 invalid schema/retention TEXT comparisons");
} finally {rmSync(base,{recursive:true,force:true});}
