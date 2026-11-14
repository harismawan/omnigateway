import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
import { databaseState } from "./database-state.ts";
const root = mkdtempSync("/tmp/opencode/e1-e5/db3-clear-");
const env = {...process.env, OMNI_ENCRYPTION_KEY:"database-golden-secret", NO_COLOR:"1"};
const store = await createStore({path:join(root,"seed"),encryptionKey:await deriveKey(env.OMNI_ENCRYPTION_KEY)}); store.close();
const commands = [["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]];
let count=0;
try {
 for (const kind of ["pipe","n","empty","bad","zero","rows","orphans","unremovable","yes","future"]) {
  const results=[];
  for (const cmd of commands) {
   for(const s of ["","-wal","-shm"]) rmSync(join(root,`db${s}`),{force:true});
   rmSync(join(root,"request_bodies"),{recursive:true,force:true}); copyFileSync(join(root,"seed"),join(root,"db"));
   mkdirSync(join(root,"request_bodies","aa"),{recursive:true});
   if(kind!=="zero") writeFileSync(join(root,"request_bodies","aa","body"),"body sentinel");
   const db=new Database(join(root,"db"));
   if(!["zero","orphans"].includes(kind)) db.run("INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,detail_state,truncated) VALUES ('old',1,'aa/body',13,'ready',0)");
   if(kind==="future") db.run("UPDATE request_bodies SET at = 8000000000000");
   db.close();
   const state=()=>({db:["","-wal","-shm"].map(s=>{try{return readFileSync(join(root,`db${s}`));}catch(e:any){if(e.code==="ENOENT")return null;throw e;}}),files:readdirSync(join(root,"request_bodies"),{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>[e.name,readFileSync(join(e.parentPath,e.name))])});
   const before=state(); const refusal=["pipe","n","empty","bad"].includes(kind);
   if(kind==="unremovable") chmodSync(join(root,"request_bodies","aa"),0o500);
   const tty=["n","empty","yes"].includes(kind);
   const args=[...cmd,"--root",root,"--db","db","db","clear-bodies",...(!tty&&kind!=="pipe"?["--yes"]:[]),...(["zero","orphans","unremovable"].includes(kind)?["--json"]:[])];
   const p=goldenSpawn(tty?["python3",resolve("conformance/cli/pty.py"),kind==="empty"?"":kind==="yes"?" YeS ":"n",...args]:args,{env:{...env,PTY_NO_COLOR:"1",...(kind==="bad"?{OMNI_ENCRYPTION_KEY:"short"}:{})},stdout:"pipe",stderr:"pipe"});
   let out=await new Response(p.stdout).text();const err=await new Response(p.stderr).text();let code=await p.exited;
   if(tty){const nested=JSON.parse(out);out=Buffer.from(nested.bytes,"hex").toString();code=nested.code;}
   assert.equal(code,refusal?1:0);if(refusal)assert.deepEqual(state(),before);
   if(kind==="unremovable"){assert.deepEqual(state().files,before.files);chmodSync(join(root,"request_bodies","aa"),0o700);}
   if(!refusal) {
    const removed=["zero","orphans","future"].includes(kind)?0:1;
    const orphans=["orphans","unremovable"].includes(kind)?1:0;
    if(["zero","orphans","unremovable"].includes(kind)) assert.deepEqual(JSON.parse(out),{removed,orphans});
    else assert(out.includes(`removed                 ${removed}`));
    assert.equal(state().files.length,["unremovable","future"].includes(kind)?1:0);
   }
   const check=new Database(join(root,"db"));const tables=databaseState(check);check.close();
   results.push({out,err,code,tables,files:state().files});
  }
  assert.deepEqual(results[1],results[0]);count++;
 }
 await verifyGoldenExits("db-clear-bodies");console.log(`PASS ${count} clear-bodies comparisons`);
} finally {try{chmodSync(join(root,"request_bodies","aa"),0o700);}catch{}rmSync(root,{recursive:true,force:true});}
