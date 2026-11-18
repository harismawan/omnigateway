#!/usr/bin/env bun
// A10 supported non-swap panel/lifecycle pair. Run under database-lifecycle-ns.sh.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { deriveKey, encrypt } from "../../packages/store/src/encryption.ts";
const { values } = parseArgs({options:{ts:{type:"string"},rust:{type:"string"},out:{type:"string"}}});
if (!values.ts || !values.rust || !values.out) throw Error("--ts --rust --out required");
const out = resolve(values.out);
mkdirSync(out,{recursive:true});
const work = mkdtempSync(join(out,"fixtures-"));
const password = "a10-normal-admin-password";
type Exchange = {status:number; type:string|null; body:unknown};
async function run(binary:string, name:string):Promise<Exchange[]> {
  const root = join(work,name);
  mkdirSync(root);
  const child = Bun.spawn([resolve(binary)],{
    cwd:root,
    env:{PATH:process.env.PATH!,HOME:root,TMPDIR:root,OMNI_ROOT:root,OMNI_DB_PATH:join(root,"db.sqlite"),OMNI_ENCRYPTION_KEY:"a10-isolated-encryption-key-0123456789",OMNI_HOST:"127.0.0.1",OMNI_PORT:"18461",OMNI_LOG_LEVEL:"warn",OMNI_DAY_OFFSET_MINUTES:"0"},
    stdout:Bun.file(join(root,"stdout.log")),stderr:Bun.file(join(root,"stderr.log")),
  });
  let cookie = "";
  const results:Exchange[] = [];
  async function request(path:string, method="GET", body?:unknown, authenticated=true) {
    const response = await fetch(`http://127.0.0.1:18461${path}`,{
      method,headers:{...(authenticated&&cookie?{cookie}:{}),...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
    const token = response.headers.get("set-cookie");
    if(token) cookie=token.split(";")[0]!;
    return {status:response.status,type:response.headers.get("content-type"),body:await response.json()};
  }
  try {
    let ready=false;
    for(let attempt=0;attempt<200;attempt++) {
      try {await fetch("http://127.0.0.1:18461/health");ready=true;break;} catch {await Bun.sleep(25);}
    }
    if(!ready) throw Error(`${name} startup failed`);
    results.push(await request("/api/lifecycle","GET",undefined,false));
    results.push(await request("/api/database/snapshots","GET",undefined,false));
    const setup=await request("/api/setup","POST",{password});
    if(setup.status!==200) throw Error(`${name} setup ${JSON.stringify(setup)}`);
    const apiKey="sk-a10-local-inference";
    const seed=new Database(join(root,"db.sqlite"));
    seed.run("INSERT INTO api_keys(id,hash,prefix,label,created_at) VALUES('a10-key',?,'sk-a10','a10',0)",[new Bun.CryptoHasher("sha256").update(apiKey).digest("hex")]);
    seed.run("INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,weight,provider_data,api_key,created_at,updated_at) VALUES('a10-credential','custom','a10','apiKey',1,1,1,?,?,0,0)",[JSON.stringify({endpointId:"a10",origin:"http://127.0.0.1:18462",protocol:"chat_completions"}),await encrypt(await deriveKey("a10-isolated-encryption-key-0123456789"),"sk-private-stub")]);
    seed.run("INSERT INTO virtual_models(id,targets,strategy) VALUES('a10-model',?,'priority')",[JSON.stringify([{provider:"custom",endpointId:"a10",model:"up",tier:1,weight:1,costPerMTok:{input:1,output:1},capabilities:{tools:true,images:true,reasoning:true}}])]);
    seed.close();
    await Bun.sleep(1100);
    const lifecycle=await request("/api/lifecycle");
    const capability=lifecycle.body as Record<string,unknown>;
    if(typeof capability.version!=="string") throw Error("version missing");
    // Build-generated version only; all capability fields remain compared.
    capability.version="<build-version>";
    results.push(lifecycle);
    results.push(await request("/api/database/snapshots"));
    results.push(await request("/api/database/retention","PUT",{keepLatest:3,maxAgeDays:30}));
    results.push(await request("/api/database/bodies","DELETE"));
    const created=await request("/api/database/snapshots","POST");
    const snapshot=created.body as {id:string;sizeBytes:number;reason:string};
    if(created.status!==200 || !/^db_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_manual\.sqlite$/.test(snapshot.id) || snapshot.reason!=="manual" || snapshot.sizeBytes<=0) throw Error(`${name} snapshot ${JSON.stringify(created)}`);
    const listed=await request("/api/database/snapshots");
    if(JSON.stringify(canonical((listed.body as {snapshots:unknown[]}).snapshots))!==JSON.stringify(canonical([snapshot]))) throw Error(`${name} list snapshot mismatch`);
    const download=await fetch(`http://127.0.0.1:18461/api/database/snapshots/${snapshot.id}/download`,{headers:{cookie}});
    const bytes=await download.arrayBuffer();
    if(download.status!==200 || download.headers.get("cache-control")!=="no-store" || download.headers.get("content-type")!=="application/octet-stream" || download.headers.get("content-disposition")!==`attachment; filename="${snapshot.id}"` || Number(download.headers.get("content-length"))!==bytes.byteLength || bytes.byteLength!==snapshot.sizeBytes || new TextDecoder().decode(bytes.slice(0,16))!=="SQLite format 3\0") throw Error(`${name} download mismatch`);
    await request("/api/database/retention","PUT",{keepLatest:7,maxAgeDays:40});
    const pushed:Record<string,unknown>[]=[];
    const ws=new WebSocket("ws://127.0.0.1:18461/api/stream",{headers:{cookie}});
    ws.addEventListener("message",event=>{pushed.push(JSON.parse(String(event.data)) as Record<string,unknown>);});
    await new Promise<void>((resolve,reject)=>{ws.addEventListener("open",()=>resolve(),{once:true});ws.addEventListener("error",()=>reject(Error("stream connection failed")),{once:true});});
    ws.send(JSON.stringify({type:"subscribe",topic:"res:keys"}));
    await Bun.sleep(100);
    let arrived!:()=>void;
    let release!:()=>void;
    const entering=new Promise<void>(resolve=>{arrived=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const upstream=Bun.serve({hostname:"127.0.0.1",port:18462,async fetch(){arrived();await gate;return new Response('data: {"id":"a10-upstream","model":"up","choices":[{"index":0,"delta":{"role":"assistant","content":"a10 answer"},"finish_reason":null}]}\n\ndata: {"id":"a10-upstream","model":"up","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});}});
    const infer=()=>fetch("http://127.0.0.1:18461/v1/chat/completions",{method:"POST",headers:{authorization:`Bearer ${apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:"a10-model",messages:[{role:"user",content:"hello"}]})});
    let restored:Exchange;
    try {
      const ongoing=infer().then(async r=>({status:r.status,body:await r.json()}));
      await Promise.race([entering,Bun.sleep(5000).then(()=>{throw Error(`${name} inference did not reach local stub`);})]);
      const removed=await request("/api/models/a10-model","DELETE");
      if(removed.status!==200) throw Error(`${name} remove routing model ${JSON.stringify(removed)}`);
      await Bun.sleep(700);
      let swapDone=false;
      const swapping=request(`/api/database/snapshots/${snapshot.id}/restore`,"POST").then(r=>{swapDone=true;return r;});
      let refused:Response|undefined;
      for(let i=0;i<30;i++){
        const r=await fetch("http://127.0.0.1:18461/v1/models",{headers:{authorization:`Bearer ${apiKey}`}});
        if(r.status===503){refused=r;break;} await r.text();await Bun.sleep(25);
      }
      if(!refused || refused.headers.get("retry-after")!=="5" || swapDone) throw Error(`${name} quiesce admission/drain`);
      await refused.text();
      if((await request("/api/lifecycle")).status!==200) throw Error(`${name} admin unavailable during drain`);
      release();
      const finished=await ongoing;
      if(finished.status!==200) throw Error(`${name} ongoing inference failed ${JSON.stringify(finished)}`);
      restored=await swapping;
      await Bun.sleep(100);
      if(!pushed.some(event=>event.topic==="res:*")) throw Error(`${name} missing global invalidation ${JSON.stringify(pushed)}`);
      const resumed=await infer();
      if(resumed.status!==200) throw Error(`${name} routing did not resume`);
      await resumed.text();
    } finally {ws.close();release();await upstream.stop(true);}
    const restoreBody=restored.body as Record<string,unknown>;
    if(restored.status!==200 || restoreBody.ok!==true || restoreBody.adminPasswordChanged!==false) throw Error(`${name} restore ${JSON.stringify(restored)}`);
    const afterRestore=await request("/api/database/snapshots");
    if(afterRestore.status!==200) throw Error(`${name} auth handle stale`);
    const restoredOverview=await request("/api/database");
    if((restoredOverview.body as {retention:{keepLatest:number}}).retention.keepLatest!==3) throw Error(`${name} stale control store`);
    const imported=await fetch("http://127.0.0.1:18461/api/database/import",{method:"POST",headers:{cookie,"content-type":"application/octet-stream"},body:bytes});
    const importBody=await imported.json() as Record<string,unknown>;
    if(imported.status!==200 || importBody.ok!==true || importBody.adminPasswordChanged!==false) throw Error(`${name} import ${JSON.stringify(importBody)}`);
    const invalid=await fetch("http://127.0.0.1:18461/api/database/import",{method:"POST",headers:{cookie,"content-type":"application/octet-stream"},body:"ordinary invalid database"});
    results.push({status:invalid.status,type:invalid.headers.get("content-type"),body:await invalid.json()});
    if(invalid.status!==400) throw Error(`${name} ordinary import refusal`);
    results.push(await request(`/api/database/snapshots/${snapshot.id}`,"DELETE"));
    const remaining=await request("/api/database/snapshots");
    for(const entry of (remaining.body as {snapshots:{id:string}[]}).snapshots) await request(`/api/database/snapshots/${entry.id}`,"DELETE");
    results.push(await request("/api/database/snapshots"));
    const vacuum=await request("/api/database/vacuum","POST");
    if(vacuum.status!==200 || (vacuum.body as {ok:boolean;durationMs:number;reclaimedBytes:number}).ok!==true || (vacuum.body as {ok:boolean;durationMs:number;reclaimedBytes:number}).durationMs<0 || (vacuum.body as {ok:boolean;durationMs:number;reclaimedBytes:number}).reclaimedBytes<0) throw Error(`${name} vacuum ${JSON.stringify(vacuum)}`);
    const overview=await request("/api/database");
    if(overview.status!==200 || (overview.body as {engine:string;retention:{keepLatest:number}}).engine!=="sqlite" || (overview.body as {engine:string;retention:{keepLatest:number}}).retention.keepLatest!==3) throw Error(`${name} overview ${JSON.stringify(overview)}`);
    writeFileSync(join(root,"overview.json"),JSON.stringify(overview,null,2));
    const importedPath=join(root,"changed-password.sqlite");
    writeFileSync(importedPath,new Uint8Array(bytes));
    const candidate=new Database(importedPath);
    const newPassword="a10-replaced-admin-password";
    candidate.run("UPDATE settings SET value=? WHERE key='adminPasswordHash'",[await Bun.password.hash(newPassword,{algorithm:"argon2id",memoryCost:19456,timeCost:2})]);
    candidate.close();
    const changed=await fetch("http://127.0.0.1:18461/api/database/import",{method:"POST",headers:{cookie,"content-type":"application/octet-stream"},body:Bun.file(importedPath)});
    const changedBody=await changed.json() as {ok:boolean;adminPasswordChanged:boolean};
    if(changed.status!==200 || !changedBody.adminPasswordChanged) throw Error(`${name} password swap ${JSON.stringify(changedBody)}`);
    const expired=await request("/api/lifecycle");
    if(expired.status!==401) throw Error(`${name} sessions survived changed password`);
    const relogin=await request("/api/login","POST",{password:newPassword});
    if(relogin.status!==200 || (await request("/api/lifecycle")).status!==200) throw Error(`${name} reopened auth store`);
    writeFileSync(join(root,"exchanges.json"),JSON.stringify(results,null,2));
    return results;
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}
const ts=await run(values.ts,"ts");
const rust=await run(values.rust,"rust");
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
if(JSON.stringify(canonical(ts))!==JSON.stringify(canonical(rust))) throw Error(`pair mismatch; retained ${work}`);
console.log(`PASS ${ts.length} paired exchanges; overview assertions; retained ${work}`);
