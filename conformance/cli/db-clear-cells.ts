import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
import { frozenPostState } from "./db-file-state.ts";
const root=mkdtempSync("/tmp/opencode/e1-e5/db19-clear-");
const env={...process.env,OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"};
const store=await createStore({path:join(root,"seed"),encryptionKey:await deriveKey(env.OMNI_ENCRYPTION_KEY)});store.close();
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]];
let count=0,failures=0;
try {
 for(const column of ["request_id","rel_path","future-path"]) {
  for(const sql of ["CAST(X'ff' AS TEXT)","CAST(X'fe' AS TEXT)","CAST(X'efbfbd' AS TEXT)","CAST(X'e282' AS TEXT)","CAST(X'eda080' AS TEXT)","'body'",...(column==="future-path"?["X'626f6479'","X'efbfbd'","12","NULL"]:[])]) {
   const results=[];
   for(const cmd of commands) {
    rmSync(join(root,"request_bodies"),{recursive:true,force:true});mkdirSync(join(root,"request_bodies"));
    for(const s of ["","-wal","-shm"])rmSync(join(root,`db${s}`),{force:true});
    copyFileSync(join(root,"seed"),join(root,"db"));
    for(const name of ["body","�","���","12"])writeFileSync(join(root,"request_bodies",name),"claim");
    const db=new Database(join(root,"db"));db.run("INSERT INTO request_bodies(request_id,at,rel_path) VALUES('id',1,'body')");
    db.run(`UPDATE request_bodies SET ${column==="request_id"?column:"rel_path"}=${sql}`);
    if(column==="future-path")db.run("UPDATE request_bodies SET at=8000000000000");db.close();
    const p=goldenSpawn([...cmd,"--root",root,"--db","db","db","clear-bodies","--yes","--json"],{env,stdout:"pipe",stderr:"pipe"});
    const out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text(),code=await p.exited;
    const state=frozenPostState(root); // Before any inspection handle, whole root.
    const check=new Database(join(root,"db"));
    const rows=check.query("SELECT hex(request_id) AS id,typeof(request_id) AS idType,at,hex(rel_path) AS path,typeof(rel_path) AS pathType FROM request_bodies ORDER BY request_id").all();check.close();
    results.push({out,err,code,state,rows});
   }
   try {assert.deepEqual(results[1],results[0]);console.log(`PASS ${column} ${sql}`);}catch {console.log(`FAILED ${column} ${sql}`,results.map(({state,...r})=>r));failures++;}count++;
  }
 }
 await verifyGoldenExits("db-clear-cells");console.log(`${count} histogram rows; ${failures} failed`);assert.equal(failures,0);
} finally {rmSync(root,{recursive:true,force:true});}
