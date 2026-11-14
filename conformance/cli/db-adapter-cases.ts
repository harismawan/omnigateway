import { strict as assert } from "node:assert";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goldenSpawn } from "./exit-gate.ts";

export async function adapterCases(commands: string[][], seed: string, env: Record<string,string|undefined>, operation: "backup"|"restore") {
 const root=mkdtempSync("/tmp/opencode/e1-e5/db-adapter-");
 const dir=join(root,"snapshots"), id="db_2000-01-01T00-00-00-000Z_manual.sqlite";
 let count=0;
 try {
  for(const kind of operation==="backup"?["unreadable"]:["inaccessible","loop","long"]) {
   const results=[];
   for(const cmd of commands) {
    rmSync(dir,{recursive:true,force:true}); mkdirSync(dir);
    for(const s of ["","-wal","-shm"])rmSync(join(root,"db")+s,{force:true});
    copyFileSync(seed,join(root,"db"));
    const input=kind==="long"?id.replace("manual","a".repeat(300)):id;
    if(kind==="loop")symlinkSync(id,join(dir,id));
    else writeFileSync(join(dir,id),"retention sentinel");
    const mode=kind==="unreadable"?0o300:kind==="inaccessible"?0:0o700;
    const run=async(args:string[])=>{
     const p=goldenSpawn([...cmd,"--root",root,"--db","db","db",...args],{env,stdout:"pipe",stderr:"pipe"});
     return {out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text(),code:await p.exited};
    };
    chmodSync(dir,mode);
    let listing, result;
    try {
     listing=await run(["snapshots","--json"]);
     result=await run(operation==="backup"?["backup","--json"]:["restore",input]);
    } finally {chmodSync(dir,0o700);}
    assert.equal(listing.code,0,kind);
    if(operation==="backup") {
     assert.equal(result.code,0,kind);
     const data=JSON.parse(result.out);
     assert.equal(readFileSync(join(dir,id),"utf8"),"retention sentinel");
     assert.equal(readdirSync(dir).length,2);
     assert(readFileSync(join(dir,data.id)).length>0);
     data.id=data.filename="<id>";data.createdAt="<time>";result.out=JSON.stringify(data);
    } else {
     assert.equal(result.code,1,kind);
     assert.match(result.err,/BAD_REQUEST: no such snapshot/,kind);
    }
    results.push({listing,result});
   }
   assert.deepEqual(results[1],results[0],kind); count++;
  }
 } finally {try{chmodSync(dir,0o700);}catch{}rmSync(root,{recursive:true,force:true});}
 return count;
}
