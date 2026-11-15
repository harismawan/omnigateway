// Missing live path: frozen first, then compare output and the whole root.
import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db17-missing-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
try {
 const seed=join(base,"seed"); const store=await createStore({path:seed,encryptionKey:await deriveKey("database-golden-secret")});store.close();
 const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")]];
 if(process.argv.includes("--compare"))commands.push([resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]);
 for(const kind of ["backup","undo"]) {
  const results=[];
  for(const [index,cmd] of commands.entries()) {
   const root=join(base,`${kind}-${index}`);mkdirSync(join(root,"snapshots"),{recursive:true});
   copyFileSync(seed,join(root,"snapshots",id));
   if(kind==="undo")copyFileSync(seed,join(root,"db"));
   const args=kind==="backup"?[...cmd,"--root",root,"--db","db","db","backup","--json"]:["python3",resolve("conformance/cli/pty.py"),"y",...cmd,"--root",root,"--db","db","db","restore",id,"--json"];
   const p=goldenSpawn(args,{env:{...process.env,HOME:root,XDG_STATE_HOME:join(root,"state"),NO_COLOR:"1",OMNI_ENCRYPTION_KEY:"database-golden-secret",PTY_NO_COLOR:"1",PTY_STDOUT_PIPE:"1",PTY_RESTORE_MUTATION:"remove",PTY_RESTORE_TARGET:join(root,"db")},stdout:"pipe",stderr:"pipe"});
   let out=await new Response(p.stdout).text(),err=await new Response(p.stderr).text(),code=await p.exited;
   if(kind==="undo"){assert.equal(err,"");const nested=JSON.parse(out);out=Buffer.from(nested.stdout,"hex").toString();err=Buffer.from(nested.bytes,"hex").toString();code=nested.code;}
   const undos=readdirSync(join(root,"snapshots")).filter(n=>n!==id);
   const normalize=(s:string)=>s.replaceAll(root,"<root>").replace(/db_[\dTZ-]+_(manual|preRestore)\.sqlite/g,"<snapshot>").replace(/"createdAt":\s*\d+/g,'"createdAt":0');
   const state=restorePostState(root,undos);
   // Backup boots a new database: migration timestamps differ by wall clock.
   // Keep its captured entries but compare file sets, modes and sizes only.
   const result={out:normalize(out),err:normalize(err),code,state:kind==="backup"?state.map(({bytes,...entry})=>({...entry,size:bytes?.length})):state};
   console.log(kind,index===0?"TS":"Rust",JSON.stringify({out:result.out,err:result.err,code}));results.push(result);
  }
  if(results.length===2)assert.deepEqual(results[1],results[0],kind);
 }
 await verifyGoldenExits("db-snapshot-missing");console.log("PASS missing-live comparisons");
} finally {rmSync(base,{recursive:true,force:true});}
