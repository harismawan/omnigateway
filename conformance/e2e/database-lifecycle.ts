#!/usr/bin/env bun
// A10 supported non-swap panel/lifecycle pair. Run under database-lifecycle-ns.sh.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
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
    if(JSON.stringify(canonical((listed.body as any).snapshots))!==JSON.stringify(canonical([snapshot]))) throw Error(`${name} list snapshot mismatch`);
    const download=await fetch(`http://127.0.0.1:18461/api/database/snapshots/${snapshot.id}/download`,{headers:{cookie}});
    const bytes=await download.arrayBuffer();
    if(download.status!==200 || download.headers.get("cache-control")!=="no-store" || download.headers.get("content-type")!=="application/octet-stream" || download.headers.get("content-disposition")!==`attachment; filename="${snapshot.id}"` || Number(download.headers.get("content-length"))!==bytes.byteLength || bytes.byteLength!==snapshot.sizeBytes || new TextDecoder().decode(bytes.slice(0,16))!=="SQLite format 3\0") throw Error(`${name} download mismatch`);
    results.push(await request(`/api/database/snapshots/${snapshot.id}`,"DELETE"));
    results.push(await request("/api/database/snapshots"));
    const vacuum=await request("/api/database/vacuum","POST");
    if(vacuum.status!==200 || (vacuum.body as any).ok!==true || (vacuum.body as any).durationMs<0 || (vacuum.body as any).reclaimedBytes<0) throw Error(`${name} vacuum ${JSON.stringify(vacuum)}`);
    const overview=await request("/api/database");
    if(overview.status!==200 || (overview.body as any).engine!=="sqlite" || (overview.body as any).retention.keepLatest!==3) throw Error(`${name} overview ${JSON.stringify(overview)}`);
    writeFileSync(join(root,"overview.json"),JSON.stringify(overview,null,2));
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
