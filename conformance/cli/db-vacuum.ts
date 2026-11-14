import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const root=mkdtempSync("/tmp/opencode/e1-e5/db-vacuum-");
const env={...process.env,OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"};
const store=await createStore({path:join(root,"seed"),encryptionKey:await deriveKey(env.OMNI_ENCRYPTION_KEY)});store.close();
const seed=new Database(join(root,"seed"));
seed.run("CREATE TABLE fixture(value BLOB)");seed.run("INSERT INTO fixture VALUES (zeroblob(100000))");seed.run("DELETE FROM fixture");seed.close();
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]];
let count=0;
try {
 for(const bad of [true,false]) for(const json of [false,true]) {
  const results=[];
  for(const cmd of commands) {
   for(const suffix of ["","-wal","-shm"]) rmSync(join(root,`db${suffix}`),{force:true});
   copyFileSync(join(root,"seed"),join(root,"db"));const before=readFileSync(join(root,"db"));
   const p=goldenSpawn([...cmd,"--root",root,"--db","db","db","vacuum",...(json?["--json"]:[])],{env:{...env,...(bad?{OMNI_ENCRYPTION_KEY:"short"}:{})},stdout:"pipe",stderr:"pipe"});
   let out=await new Response(p.stdout).text();const err=await new Response(p.stderr).text();const code=await p.exited;
   assert.equal(code,bad?1:0);
   if(bad) assert.deepEqual(readFileSync(join(root,"db")),before);
   else {
    assert(readFileSync(join(root,"db")).length<before.length);
    if(json) {const data=JSON.parse(out);assert(data.durationMs>=0);assert(data.reclaimedBytes>0);data.durationMs="<duration>";out=JSON.stringify(data);}
    else {assert.match(out,/took +\d+ ms/);out=out.replace(/(took +)\d+ ms/,"$1<duration> ms");}
   }
   results.push({out,err,code});
  }
  assert.deepEqual(results[1],results[0]);count++;
 }
 await verifyGoldenExits("db-vacuum");console.log(`PASS ${count} vacuum comparisons`);
} finally {rmSync(root,{recursive:true,force:true});}
