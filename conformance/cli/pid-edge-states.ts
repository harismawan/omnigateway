import { strict as assert } from "node:assert";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createStore, deriveKey } from "../../packages/store/src/index.ts";
import { frozenPostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const root=mkdtempSync('/tmp/opencode/e1-e5/db9-pid-');
const env={...process.env,HOME:root,XDG_STATE_HOME:join(root,'state'),OMNI_ENCRYPTION_KEY:'database-golden-secret',NO_COLOR:'1'};
const commands=[['bun','--no-env-file',resolve('apps/cli/src/index.ts')],[resolve(process.env.OMNI_CLI_BIN??'target/debug/omni')]];
try {
 const store=await createStore({path:join(root,'seed'),encryptionKey:await deriveKey(env.OMNI_ENCRYPTION_KEY)});store.close();
 const parent=join(root,'state/omnigateway'), pid=join(parent,'gateway.pid');mkdirSync(parent,{recursive:true});
 for(const kind of ['parent','loop','directory','file']) for(const command of [['status'],['status','--json'],['db','restore','db_2026-11-01T00-00-00-000Z_manual.sqlite','--yes']]) {
  const results=[];
  for(const cmd of commands) {
   copyFileSync(join(root,'seed'),join(root,'db'));
   if(kind==='directory')mkdirSync(pid);else if(kind==='loop')symlinkSync(pid,pid);else writeFileSync(pid,String(process.pid));
   if(kind==='parent')chmodSync(parent,0);if(kind==='file')chmodSync(pid,0);
   try {
    const p=goldenSpawn([...cmd,'--root',root,'--db','db',...command],{env,stdout:'pipe',stderr:'pipe'});
    const result={out:await new Response(p.stdout).text(),err:await new Response(p.stderr).text(),code:await p.exited,state:frozenPostState(root)};
    assert.equal(result.code,kind==='directory'||kind==='file'||command[0]==='db'?1:0);
    if(kind==='directory')assert.equal(result.err,'EISDIR: illegal operation on a directory, read\n');
    if(kind==='file')assert.match(result.err,/EACCES: permission denied, open/);
    if(command[0]==='db'&&(kind==='parent'||kind==='loop'))assert.match(result.err,/BAD_REQUEST: no such snapshot/);
    results.push(result);
   } finally {chmodSync(parent,0o700);if(kind==='file')chmodSync(pid,0o600);rmSync(pid,{recursive:true,force:true});}
  }
  assert.deepEqual(results[1],results[0],`${kind} ${command}`);
 }
 await verifyGoldenExits('pid-edge-states');
 console.log('PASS 12 pid edge-state comparisons');
} finally {rmSync(root,{recursive:true,force:true});}
