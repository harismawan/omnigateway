import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { frozenPostState } from "./db-file-state.ts";
import { goldenSpawn, verifyGoldenExits } from "./exit-gate.ts";
const base=mkdtempSync("/tmp/opencode/e1-e5/db22-ledger-"),root=join(base,"root");
const dir=resolve("packages/store/src/sqlite/migrations"),sqls=readdirSync(dir).sort().map(n=>readFileSync(join(dir,n),"utf8"));
const commands=[["bun","--no-env-file",resolve("apps/cli/src/index.ts")],[resolve(process.env.OMNI_CLI_BIN??"target/debug/omni")]];
const cells=["CAST(X'ff' AS TEXT)","'1'","NULL","X'31'","1","1.0","1.5","0.0","-0.0","1e999","-1e999","9223372036854775807","-9223372036854775808","9007199254740993","0.9999999999999999","1.0000000000000002","21","1,1","NULL,21,'1',X'ff'"];
const cases=[...cells.flatMap(cell=>[ {cell,prefix:0}, {cell,prefix:20} ]),...[1,5,9,19,20].map(prefix=>({cell:"",prefix})),{cell:"partial",prefix:20}];
let failures=0;
try {
 for(const fixture of cases){
  const results=[];
  for(const cmd of commands){
   rmSync(root,{recursive:true,force:true});mkdirSync(root);
   const path=join(root,"db"),db=new Database(path);
   db.run("PRAGMA journal_mode=WAL;CREATE TABLE migrations(id,applied_at)");
   for(let i=0;i<fixture.prefix;i++){db.run(sqls[i]);db.run("INSERT INTO migrations VALUES (?,1)",[i+1]);}
   if(fixture.prefix){
    db.run("INSERT INTO credentials(id,provider,label,auth_type,api_key,created_at,updated_at) VALUES('cred','p','retained','api_key','opaque encrypted bytes',1,1)");
    db.run("INSERT INTO request_logs(id,at,api_key_id,requested_model,resolved_provider,resolved_model,credential_id,status,duration_ms,cost_usd,input_tokens) VALUES('log',1000,'key','m','p','m','c',200,12,1.25,7)");
   }
   if(fixture.cell==="partial")db.run("DELETE FROM migrations WHERE id>=19; ALTER TABLE api_keys DROP COLUMN guardrail_policy");
   else if(fixture.cell){db.run("DELETE FROM migrations");for(const cell of fixture.cell.split(','))db.run(`INSERT INTO migrations VALUES (${cell},1)`);}
   const before=db.query("SELECT rowid,hex(id) AS raw,typeof(id) AS type,applied_at FROM migrations ORDER BY rowid").all();db.close();
   const start=Date.now(),p=goldenSpawn([...cmd,"--root",root,"--db","db","db","migrate","--json"],{env:{...process.env,HOME:root,XDG_STATE_HOME:join(root,"state"),OMNI_ENCRYPTION_KEY:"database-golden-secret",OMNI_DAY_OFFSET_MINUTES:"0",NO_COLOR:"1"},stdout:"pipe",stderr:"pipe"});
   const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]),end=Date.now();
   const state=frozenPostState(root); // Capture before inspection, including failures.
   const check=new Database(path,{readonly:true}),rows=check.query("SELECT rowid,hex(id) AS raw,typeof(id) AS type,applied_at FROM migrations ORDER BY rowid").all() as any[];
   assert.deepEqual(rows.slice(0,before.length),before,"all prior cells retained exactly");
   const pageNo=check.query("SELECT rootpage FROM sqlite_master WHERE name='migrations'").get().rootpage as number;
   if(code===0){assert.deepEqual(JSON.parse(out),{path,created:false});assert.equal(err,"");}
   if(fixture.prefix){assert.equal(check.query("SELECT api_key FROM credentials").get().api_key,"opaque encrypted bytes");assert.equal(check.query("SELECT input_tokens FROM request_logs").get().input_tokens,7);}
   check.close();
   const bytes=state.find(e=>e.path==="db")!.bytes!,page=(pageNo-1)*(bytes.readUInt16BE(16)||65536),header=page+(pageNo===1?100:0);
   const varint=(at:number):[number,number]=>{let v=0;for(let n=0;n<8;n++){const b=bytes[at++];v=v*128+(b&127);if(b<128)return [v,at];}return [v*256+bytes[at],at+1];};
   assert.equal(bytes[header],13);
   // Only newly committed ledger timestamps, decoded from their actual record.
   for(let i=0;i<bytes.readUInt16BE(header+3);i++){
    const [len,next]=varint(page+bytes.readUInt16BE(header+8+i*2)),[rowid,record]=varint(next),row=rows.find(r=>r.rowid===rowid)!;
    if(row.applied_at===1)continue;
    assert(row.applied_at>=start&&row.applied_at<=end);
    const [hlen,s]=varint(record),[idType,t]=varint(s),[timeType,last]=varint(t);
    assert([1,9].includes(idType));assert.equal(timeType,5);assert.equal(last,record+hlen);const size=idType===9?0:1;
    assert.equal(len,hlen+size+6);assert.equal(bytes.readIntBE(record+hlen+size,6),row.applied_at);bytes.writeIntBE(0,record+hlen+size,6);
   }
   results.push({out,err,code,state});
  }
  try{assert.deepEqual(results[1],results[0]);console.log(`PASS ${JSON.stringify(fixture)} exit=${results[0].code}`);}catch{failures++;console.log(`FAILED ${JSON.stringify(fixture)}`,results.map(({state,...r})=>r));}
 }
 await verifyGoldenExits("db-migrate-ledger");console.log(`${cases.length} comparisons; ${failures} failed`);assert.equal(failures,0);
} finally {rmSync(base,{recursive:true,force:true});}
