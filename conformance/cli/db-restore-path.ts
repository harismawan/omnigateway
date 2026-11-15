import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { frozenPostState, restorePostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db15-path-");
const id="db_2026-11-01T00-00-00-000Z_manual.sqlite";
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")]];
if(process.argv.includes("--compare"))commands.push([resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]);
try {
 const seed=join(base,"seed");const store=await createStore({path:seed,encryptionKey:await deriveKey("database-golden-secret")});store.close();
 for(const kind of ["outside","inside","dangling","directory"]) {
  const results=[];
  for(const [index,command] of commands.entries()) {
   const root=join(base,`${kind}-${index}`),snapshots=join(root,"snapshots"),candidate=join(snapshots,id);
   mkdirSync(snapshots,{recursive:true});copyFileSync(seed,join(root,"db"));copyFileSync(seed,candidate);
   copyFileSync(seed,join(root,"replacement"));copyFileSync(seed,join(snapshots,"other.sqlite"));
   const source=kind==="inside"?"other.sqlite":kind==="dangling"?"absent.sqlite":"../replacement";
   const p=goldenSpawn(["python3",resolve("conformance/cli/pty.py"),"y",...command,"--root",root,"--db","db","db","restore",id,"--json"],{env:{...process.env,HOME:root,XDG_STATE_HOME:join(root,"state"),OMNI_ENCRYPTION_KEY:"database-golden-secret",PTY_NO_COLOR:"1",PTY_STDOUT_PIPE:"1",PTY_RESTORE_MUTATION:kind==="directory"?"directory":"symlink",PTY_RESTORE_TARGET:candidate,PTY_RESTORE_SOURCE:source},stdout:"pipe",stderr:"pipe"});
   const [text,stderr]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);await p.exited;assert.equal(stderr,"");
   const nested=JSON.parse(text);let out=Buffer.from(nested.stdout,"hex").toString(),err=Buffer.from(nested.bytes,"hex").toString();const code=nested.code;
   const undos=readdirSync(snapshots).filter(n=>n.endsWith("_preRestore.sqlite"));
   const state=undos.length?restorePostState(root,undos[0]):frozenPostState(root);
   console.log(`${kind} ${index===0?"TS":"Rust"}: exit=${code}, undos=${undos.length}, stderr=${JSON.stringify(err.replaceAll(root,"<root>"))}`);
   assert.equal(code,kind==="inside"?0:1);assert.equal(undos.length,kind==="inside"?1:0);
   if(kind==="outside")assert(err.includes("BAD_REQUEST: invalid snapshot id"));
   if(kind==="inside"){const data=JSON.parse(out);data.preRestoreSnapshot.id=data.preRestoreSnapshot.filename="<undo>";data.preRestoreSnapshot.createdAt="<time>";out=JSON.stringify(data);}
   err=err.replaceAll(root,"<root>").replace(/db_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_preRestore\.sqlite/g,"<undo>");results.push({out,err,code,state});
  }
  if(results.length===2)assert.deepEqual(results[1],results[0],kind);
 }
 await verifyGoldenExits("db-restore-path");console.log("PASS 4 post-confirmation path comparisons");
} finally {rmSync(base,{recursive:true,force:true});}
