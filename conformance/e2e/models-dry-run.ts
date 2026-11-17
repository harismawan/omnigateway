// A12 black-box differential; private scratch and explicit child environments.
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
const { values:f }=parseArgs({options:{ts:{type:"string"},rust:{type:"string"},out:{type:"string"}}});
const root=f.out??"/tmp/opencode/a12/http"; mkdirSync(root,{recursive:true});
const work=mkdtempSync(`${root}/run-`);
const env={PATH:"/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin",HOME:work,XDG_CONFIG_HOME:work,XDG_STATE_HOME:work,OMNI_ENCRYPTION_KEY:"a12-private-synthetic-key-long-enough",OMNI_HOST:"127.0.0.1",OMNI_LOG_LEVEL:"warn",NO_COLOR:"1"};
async function start(bin:string,db:string,port:number,ts:boolean){
 const p=Bun.spawn([bin,...(ts?["--no-env-file"]:[])],{cwd:work,env:{...env,OMNI_ROOT:work,OMNI_DB_PATH:db,OMNI_PORT:String(port)},stdout:Bun.file(`${work}/${port}.log`),stderr:Bun.file(`${work}/${port}.err`)});
 for(let n=0;n<500;n++){try{await fetch(`http://127.0.0.1:${port}/api/status`);return p;}catch{await Bun.sleep(20);}}
 p.kill();throw Error("startup timeout");
}
async function req(port:number,path:string,body:any,cookie="",raw=false){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:"POST",headers:{"content-type":"application/json",cookie},body:raw?body:JSON.stringify(body)});
 const text=await r.text();let b:any;try{b=JSON.parse(text);}catch{b=text;}
 if(b?.rankedAt){if(Math.abs(b.rankedAt-Date.now())>120000)throw Error("invalid rankedAt");b.rankedAt="<now>";}
 return {status:r.status,type:r.headers.get("content-type"),body:b,cookie:(r.headers.get("set-cookie")??"").split(";")[0]};
}
const seed=`${work}/seed.db`;let p=await start(f.ts!,seed,19612,true);
await req(19612,"/api/setup",{password:"a12-password-long-enough"});p.kill();await p.exited;
const d=new Database(seed);
const strategies=["score","priority","weighted","roundRobin","mystery"];
const targets=[{provider:"openai",model:"gpt-4.1",tier:1,weight:1},{provider:"missing-plugin",model:"test",tier:2,weight:1},{provider:"kilo",model:"test",tier:1,weight:1}].map(t=>({...t,costPerMTok:{input:1,output:2},capabilities:{tools:true,images:true,reasoning:true}}));
for(const s of strategies)d.query("INSERT INTO virtual_models(id,targets,strategy) VALUES(?,?,?)").run(s,JSON.stringify(targets),s);
for(const [id,provider,disabled,expires] of [["ok","openai",0,null],["disabled","openai",1,null],["expired","openai",0,1],["expired-oauth","openai",0,1],["unhealthy","openai",0,null],["kilo","kilo",0,null],["plugin","missing-plugin",0,null]] as const)
 d.query("INSERT INTO credentials(id,provider,label,auth_type,enabled,expires_at,created_at,updated_at) VALUES(?,?,?,'apiKey',?,?,1,1)").run(id,provider,id,1-disabled,expires);
d.run("UPDATE credentials SET auth_type='oauth' WHERE id='expired-oauth'");
d.run("INSERT INTO credential_health(credential_id,model,breaker_state,consecutive_failures,opened_at,rate_limited_until) VALUES('unhealthy','gpt-4.1','open',5,4102444800000,4102444800000)");
d.close();const rows:any[]=[];const children=[];
try{
 for(const [i,bin] of [f.ts!,f.rust!].entries()){copyFileSync(seed,`${work}/${i}.db`);children.push(await start(bin,`${work}/${i}.db`,19612+i,i===0));}
 const cookies=[];const viewers=[];
 for(const port of [19612,19613]){
  const cookie=(await req(port,"/api/login",{password:"a12-password-long-enough"})).cookie;cookies.push(cookie);
  await fetch(`http://127.0.0.1:${port}/api/settings/viewer-password`,{method:"PUT",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({password:"a12-viewer-long-enough"})});
  viewers.push((await req(port,"/api/login",{password:"a12-viewer-long-enough",mode:"viewer"})).cookie);
 }
 const bodies=[{},...Array.from({length:8},(_,n)=>({tools:!!(n&1),images:!!(n&2),reasoning:!!(n&4)})),[],null,{extra:1},{tools:"yes"},{images:1},{reasoning:null}];
 for(const id of [...strategies,"gpt-4.1","unknown"])for(const body of bodies)for(const auth of ["none","viewer","operator"]){
  const pair=await Promise.all([19612,19613].map((port,i)=>req(port,`/api/models/${id}/dry-run`,body,auth==="operator"?cookies[i]:auth==="viewer"?viewers[i]:"")));
  pair.forEach(x=>delete (x as any).cookie);rows.push({id,body,auth,pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])});
 }
 for(const raw of ["{","no-json",""]){const pair=await Promise.all([19612,19613].map((port,i)=>req(port,"/api/models/score/dry-run",raw,cookies[i],true)));pair.forEach(x=>delete (x as any).cookie);rows.push({raw,pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])});}
 // Fresh stored rows; reset each case rather than accumulating mutations.
 const dbs=[0,1].map(i=>new Database(`${work}/${i}.db`));
 const cases=[
 ...['tier','weight','costPerMTok.input','costPerMTok.output','costPerMTok.cacheRead'].flatMap(field=>["'2'","'oops'",'NULL',"'1e400'","'-0'","json('[2]')","json('{}')"].map(value=>`UPDATE virtual_models SET targets=json_set(targets,'$[0].${field}',${value}) WHERE id='score'`)),
 ...["weight='2'","weight='oops'","weight=x'32'","weight=1e400","weight=-0.0","expires_at='oops'","disabled_at='oops'","expires_at='1e400'"].map(x=>`UPDATE credentials SET ${x} WHERE id='${x.startsWith('weight')?'ok':'expired-oauth'}'`),
 "INSERT INTO virtual_models(id,targets,strategy) VALUES('broken','{}','score')",
 "INSERT INTO virtual_models(id,targets,strategy) VALUES('broken','not-json','score')",
 "UPDATE virtual_models SET targets=json_set(targets,'$[0].tier','2') WHERE id='score'",
 "UPDATE virtual_models SET targets=json_set(targets,'$[0].capabilities.tools',1) WHERE id='score'",
 "UPDATE virtual_models SET strategy=x'73636f7265' WHERE id='score'",
 ...["tier='oops'","label=x'6162'","expires_at=1.5","disabled_at=1.5","provider_data=x'7b7d'","provider_data='null'"].map(x=>`UPDATE credentials SET ${x} WHERE id='ok'`),
 "UPDATE credential_health SET credential_id=x'6162'",
 ...[
 ['virtual_models','targets',"id='score'"],['virtual_models','strategy',"id='score'"],
 ...['tier','label','expires_at','disabled_at','provider_data','enabled'].map(c=>['credentials',c,"id='ok'"]),
 ...['credential_id','model','breaker_state','consecutive_failures','opened_at','rate_limited_until'].map(c=>['credential_health',c,'1']),
 ].flatMap(([table,column,where])=>['1','1.5','-0.0',"'oops'","'2'","x'6162'",'NULL'].map(value=>`UPDATE ${table} SET ${column}=${value} WHERE ${where}`)),
 ];
 for(const sql of cases){
  let rejected=false;
  for(const db of dbs){db.run('PRAGMA foreign_keys=OFF');try{db.run(sql);}catch(e){rejected=true;}}
  if(rejected){rows.push({sql,constraintRejected:true,equal:true});continue;}
  const pair=await Promise.all([19612,19613].map((port,i)=>req(port,'/api/models/score/dry-run',{},cookies[i])));pair.forEach(x=>delete (x as any).cookie);
  rows.push({sql,pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])});
  for(const db of dbs){db.run(`ATTACH DATABASE '${seed}' AS original`);for(const t of ['credentials','credential_health','virtual_models']){db.run(`DELETE FROM ${t}`);db.run(`INSERT INTO ${t} SELECT * FROM original.${t}`);}db.run('DETACH DATABASE original');}
 }
 // Reviewer's discriminating heterogeneous matrix: 318 rows including auth/schema.
 const heterogeneous=[
 {provider:'openai',model:'gpt-4.1',tier:2,weight:2,costPerMTok:{input:2,output:4},capabilities:{tools:false,images:true,reasoning:false}},
 {provider:'openai',model:'gpt-4.2',tier:3,weight:3,costPerMTok:{input:0.1,output:0.2},capabilities:{tools:true,images:false,reasoning:true}},
 {provider:'kilo',model:'test',tier:1,weight:0.5,costPerMTok:{input:1,output:1},capabilities:{tools:true,images:true,reasoning:true}},
 {provider:'missing',model:'test',tier:1,weight:1,costPerMTok:{input:1,output:1},capabilities:{tools:true,images:true,reasoning:true}}];
 for(const db of dbs){db.query('UPDATE virtual_models SET targets=?').run(JSON.stringify(heterogeneous));db.run("INSERT INTO credential_health VALUES('ok','gpt-4.1','halfOpen',2,1,NULL)");db.run("INSERT INTO credential_health VALUES('ok','gpt-4.2','closed',1,NULL,NULL)");}
 for(const id of [...strategies,'gpt-4.1','unknown'])for(const body of bodies)for(const auth of ['none','viewer','operator']){
 const pair=await Promise.all([19612,19613].map((port,i)=>req(port,`/api/models/${id}/dry-run`,body,auth==='operator'?cookies[i]:auth==='viewer'?viewers[i]:'')));pair.forEach(x=>delete (x as any).cookie);rows.push({matrix:'heterogeneous',id,body,auth,pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])});}
 for(const raw of ['{','no-json','']){const pair=await Promise.all([19612,19613].map((port,i)=>req(port,'/api/models/score/dry-run',raw,cookies[i],true)));pair.forEach(x=>delete (x as any).cookie);rows.push({matrix:'heterogeneous',raw,pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])});}
 for(const db of dbs)db.close();
}finally{for(const child of children)child.kill();await Promise.all(children.map(p=>p.exited));}
// Review's live discrimination: poison exists before boot; no provider traffic.
const liveChildren=[];
try{
 for(const [i,bin] of [f.ts!,f.rust!].entries()){
  const file=`${work}/live-${i}.db`;copyFileSync(seed,file);const db=new Database(file);
  db.run('UPDATE credentials SET enabled=0');db.run("INSERT INTO virtual_models(id,targets,strategy) VALUES('broken','{}','score')");db.close();
  liveChildren.push(await start(bin,file,19612+i,i===0));
 }
 const pair=[];
 for(const port of [19612,19613]){
  const cookie=(await req(port,'/api/login',{password:'a12-password-long-enough'})).cookie;
  const created=await req(port,'/api/keys',{},cookie);
  const live=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${created.body.key}`},body:JSON.stringify({model:'score',messages:[{role:'user',content:'hi'}],stream:false})});
  const dry=await req(port,'/api/models/score/dry-run',{},cookie);delete (dry as any).cookie;
  pair.push({live:{status:live.status,body:await live.text()},dry});
 }
 rows.push({identity:'live-unrelated-poison',pair,equal:JSON.stringify(pair[0])===JSON.stringify(pair[1])&&pair.every(p=>p.live.status===503&&p.dry.status===200)});
}finally{for(const p of liveChildren)p.kill();await Promise.all(liveChildren.map(p=>p.exited));}
const manifest=JSON.parse(readFileSync(new URL('./models-dry-run-accepted.json',import.meta.url),'utf8'));
function differences(a:any,b:any,path=''):string[]{
 if(JSON.stringify(a)===JSON.stringify(b))return [];
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return [path];
 if(JSON.stringify(Object.keys(a))!==JSON.stringify(Object.keys(b)))return [path];
 return Object.keys(a).flatMap(k=>differences(a[k],b[k],`${path}/${k}`));
}
for(const row of rows.filter(r=>!r.equal)){
 const entry=manifest.rows.find((e:any)=>e.identity===row.sql);
 const paths=differences(row.pair[0],row.pair[1]);
 row.differences=paths;
 row.accepted=!!entry && JSON.stringify(entry.statuses)===JSON.stringify(row.pair.map((p:any)=>p.status)) && paths.every(p=>entry.paths.includes(p));
}
writeFileSync(`${work}/rows.json`,JSON.stringify(rows,null,2));const failures=rows.filter(r=>!r.equal&&!r.accepted);console.log(JSON.stringify({rows:rows.length,accepted:rows.filter(r=>r.accepted).length,failures:failures.length,work}));process.exit(failures.length?1:0);
