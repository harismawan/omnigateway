// Deliberately Rust-only: the accepted D4 path must not contact a server.
import "./driver-env.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileState } from "./db-file-state.ts";
const root=mkdtempSync("/tmp/opencode/e1-e5/db21-boundary-");
try {
 for(const args of [["--to=postgres://user:secret@127.0.0.1:1/db","--yes"],["--to","postgres-invalid","-y"]]) {
  const before=fileState(root);
  const p=Bun.spawn([resolve(process.env.OMNI_CLI_BIN??"target/debug/omni"),"--root",root,"--db","db","db","migrate","--json",...args],{env:{...process.env,HOME:root,XDG_STATE_HOME:join(root,"state"),OMNI_ENCRYPTION_KEY:"",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
  assert.equal(await p.exited,1);assert.equal(await new Response(p.stdout).text(),"");
  assert.equal(await new Response(p.stderr).text(),"db migrate --to is not yet available in the Rust CLI\n");
  assert.deepEqual(fileState(root),before);
 }
 console.log("PASS 2 Rust-only accepted D4 boundary refusals; exit 1=2");
} finally {rmSync(root,{recursive:true,force:true});}
