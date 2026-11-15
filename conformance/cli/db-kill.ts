// Observation tool, outside the pinned matrix. K3 is BEFORE copy, not mid-copy;
// K8 is reopen entry, not migration. Deeper schema-19 migration probe:
// /tmp/opencode/db-review/r3/conformance/cli/kill-migration.ts (reviewer evidence, not run here).
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { Database } from "bun:sqlite";
import { fileState } from "./db-file-state.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db17-kill-root-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]];
let different=false;
try {
 const seed=join(base,"seed");mkdirSync(join(seed,"snapshots"),{recursive:true});
 const store=await createStore({path:join(seed,"db"),encryptionKey:await deriveKey("database-golden-secret")});
 store.close();copyFileSync(join(seed,"db"),join(seed,"snapshots",id));
 const candidate=new Database(join(seed,"snapshots",id));candidate.run("PRAGMA journal_mode=DELETE");candidate.run("INSERT INTO settings (key,value) VALUES ('candidate','installed')");candidate.close();
 const walSource=join(base,"wal-source");copyFileSync(join(seed,"db"),walSource);
 const writer=new Database(walSource);writer.run("PRAGMA journal_mode=WAL");writer.run("PRAGMA wal_autocheckpoint=0");writer.run("INSERT INTO settings (key,value) VALUES ('live-wal','old')");
 for(const suffix of ["","-wal","-shm"])copyFileSync(walSource+suffix,join(seed,"db")+suffix);writer.close();
 const env={...process.env,OMNI_ENCRYPTION_KEY:"database-golden-secret",NO_COLOR:"1"};
 function capture(root:string){return fileState(root).map(({bytes,...entry})=>({...entry,path:entry.path.replace(/db_[\dTZ-]+_preRestore.sqlite/g,"<undo>"),size:bytes?.length,hex:bytes?.toString("hex")}));}
 function listing(state:ReturnType<typeof capture>){return state.map(({hex,...entry})=>entry);}
 for(const point of ["trace","K1","K2","K3","K4","K5","K6","K7","K8"]) {
  const results=[];
  const afters=[];
  const followResults=[];
  for(const [i,cmd] of commands.entries()) {
   const root=join(base,`${point}-${i}`);cpSync(seed,root,{recursive:true});
   const log=`/tmp/opencode/e1-e5/db17-kill-${point}-${i}`;
   const p=Bun.spawn(["python3",resolve("conformance/cli/db-kill-driver.py"),point,log,`/tmp/opencode/e1-e5/db17-kill-trace-${i}.trace`,...cmd,"--root",root,"--db","db","db","restore",id],{env:{...env,HOME:root,XDG_STATE_HOME:join(root,"state")},stdout:"pipe",stderr:"pipe"});
   const out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text();const code=await p.exited;
   console.log(point,i===0?"TS":"Rust",out.trim(),err.trim());
   if(code!==0||out.includes("not reached")){different=true;results.push(null);continue;}
   const state=capture(root);await Bun.write(log+".state.json",JSON.stringify(state));
   console.log("LIST",JSON.stringify(listing(state)));
   if(point==="trace"){results.push(state);continue;}
   const undo=readdirSync(join(root,"snapshots")).find(n=>n.endsWith("_preRestore.sqlite"));
   const follow=[];
   for(const args of [...(undo?[["db","restore",undo,"--yes","--json"]]:[]),["db","stats","--json"]]) {
    const f=Bun.spawn([...cmd,"--root",root,"--db","db",...args],{env:{...env,HOME:root,XDG_STATE_HOME:join(root,"state")},stdout:"pipe",stderr:"pipe"});
    const stdout=await new Response(f.stdout).text(),stderr=await new Response(f.stderr).text();const exit=await f.exited;follow.push(exit);console.log("FOLLOW",point,i,args,exit,stdout,stderr);
   }
   const after=capture(root);await Bun.write(log+".after.json",JSON.stringify(after));console.log("AFTER",JSON.stringify(listing(after)));
   console.log("FOLLOW SUMMARY",point,i,JSON.stringify(follow));afters.push(after);followResults.push(follow);
   results.push(state);
  }
  if(point!=="trace"&&results.every(Boolean)) {
   const sets=results.map(s=>JSON.stringify(s!.map(e=>[e.path,e.type])));
   const afterSets=afters.map(s=>JSON.stringify(s.map(e=>[e.path,e.type])));
   const equal=sets[0]===sets[1]&&afterSets[0]===afterSets[1];
   const sizes=results.map(s=>JSON.stringify(listing(s!)));
   const metadataEqual=sizes[0]===sizes[1]&&JSON.stringify(listing(afters[0]))===JSON.stringify(listing(afters[1]));
   const exitsEqual=JSON.stringify(followResults[0])===JSON.stringify(followResults[1]);
   console.log(`TABLE ${point} file-set-equal=${equal} sizes-and-modes-equal=${metadataEqual} follow-exits-equal=${exitsEqual}`);if(!equal||!metadataEqual||!exitsEqual){different=true;break;}
  }
 }
} finally {rmSync(base,{recursive:true,force:true});}
process.exitCode=different?1:0;
