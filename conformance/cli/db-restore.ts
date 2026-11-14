import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const root = mkdtempSync("/tmp/opencode/e1-e5/db5-restore-");
const env = {...process.env, HOME:root, XDG_STATE_HOME:join(root,"state"), OMNI_ENCRYPTION_KEY:"database-golden-secret", NO_COLOR:"1"};
const store = await createStore({path:join(root,"seed"),encryptionKey:await deriveKey(env.OMNI_ENCRYPTION_KEY)}); store.close();
const commands = [["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN ?? "target/debug/omni")]];
const unit=join(root,".config/systemd/user/omnigateway.service");
mkdirSync(join(root,".config/systemd/user"),{recursive:true});
mkdirSync(join(root,"state/omnigateway"),{recursive:true});
mkdirSync(join(root,"bin"));mkdirSync(join(root,"snapshots"));
writeFileSync(join(root,"snapshots/sentinel"),"snapshot sentinel");
writeFileSync(join(root,"bin/systemctl"),'#!/bin/sh\ncase "$*" in *is-active*) echo active;; *) echo 0;; esac\n',{mode:0o755});
const state=()=>({live:["","-wal","-shm"].map(s=>{try{return readFileSync(join(root,`db${s}`));}catch(e:any){if(e.code==="ENOENT")return null;throw e;}}),snapshots:readdirSync(join(root,"snapshots")).map(n=>[n,readFileSync(join(root,"snapshots",n))])});
let count=0;
try {
 for(const kind of ["missing","pid","supervisor"]){
  const results=[];
  for(const cmd of commands){
   copyFileSync(join(root,"seed"),join(root,"db"));
   rmSync(unit,{force:true});rmSync(join(root,"state/omnigateway/gateway.pid"),{force:true});
   if(kind==="pid")writeFileSync(join(root,"state/omnigateway/gateway.pid"),String(process.pid));
   if(kind==="supervisor")writeFileSync(unit,"fixture");
   const before=state();
   const p=goldenSpawn([...cmd,"--root",root,"--db","db","db","restore",...(kind==="missing"?[]:["absent"])],{env:{...env,PATH:`${root}/bin:${process.env.PATH}`},stdout:"pipe",stderr:"pipe"});
   const result={out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text(),code:await p.exited};
   assert.equal(result.code,kind==="missing"?2:1);assert.deepEqual(state(),before);results.push(result);
  }
  assert.deepEqual(results[1],results[0]);count++;
 }
 await verifyGoldenExits("db-restore");console.log(`PASS ${count} restore comparisons`);
} finally {rmSync(root,{recursive:true,force:true});}
