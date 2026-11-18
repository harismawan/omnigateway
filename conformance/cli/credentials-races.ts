/** Deterministic loopback races and statement-failure oracle. Run via credentials-ns.sh. */
import { Database } from 'bun:sqlite';
import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual as eq } from 'node:util';
import { deriveKey, encrypt, decrypt } from '../../packages/store/src/encryption.ts';
const [binary,work] = process.argv.slice(2).map(p=>resolve(p));
const env = {PATH:process.env.PATH!,HOME:join(work!,'home'),TMPDIR:join(work!,'tmp'),OMNI_ENCRYPTION_KEY:'review-secret-long-enough',NO_COLOR:'1',NODE_EXTRA_CA_CERTS:join(work!,'cert.pem'),SSL_CERT_FILE:join(work!,'cert.pem')};
const key=await deriveKey(env.OMNI_ENCRYPTION_KEY);
const began=Date.now();
const ts=['bun','--no-env-file','apps/cli/src/index.ts'];
let held: (()=>void)[] = [], arrival: (()=>void)|undefined, wait=false, serial=0;
const stub=Bun.serve({hostname:'127.0.0.1',port:443,tls:{cert:Bun.file(join(work!,'cert.pem')),key:Bun.file(join(work!,'key.pem'))},async fetch(req){
  const body=await req.text(); const n=++serial;
  if(wait) { wait=false; await new Promise<void>(r=>{held.push(r);arrival?.();}); }
  const claims=Buffer.from(JSON.stringify({email:`email-${n}@test`, 'https://api.openai.com/auth':{chatgpt_account_id:`account-${n}`}})).toString('base64url');
  return Response.json({access_token:`access-${n}`,refresh_token:`refresh-${n}`,id_token:`a.${claims}.b`,account:{email_address:`email-${n}@test`}});
}});
function start(command:string[],root:string,args:string[],input='') {
  const dynamic=input==='@';
  const p=Bun.spawn([...command,'--root',root,...args],{env,stdin:dynamic?'pipe':new Response(input),stdout:'pipe',stderr:'pipe'});
  const done=(async()=>{
    let err=''; for await(const chunk of p.stderr){err+=new TextDecoder().decode(chunk);if(dynamic&&err.includes('state=')){const state=new URL(err.match(/  (https:\/\/[^\n]+)/)![1]!).searchParams.get('state');(p.stdin as any).end(`code#${state}`);}}
    return {code:await p.exited,out:await new Response(p.stdout).text(),err:err.replace(/(code_challenge=)[^&\n]+/g,'$1<challenge>').replace(/(state=)[^&\n]+/g,'$1<state>')};
  })(); return {p,done};
}
async function snapshot(file:string,raw=false){
  const db=new Database(file); const rows:any[]=[];
  for(const row of db.query('select * from credentials order by rowid').all() as any[]){
    const typed:any={};for(const k of Object.keys(row))typed[k]=db.query(`select typeof("${k}") t from credentials where rowid=(select rowid from credentials where id=?)`).get(row.id);
    for(const k of ['access_token','refresh_token','api_key','id_token'])if(!raw&&row[k]!==null)row[k]=await decrypt(key,row[k]);
    if(!raw&&row.id!=='neighbor'){
      for(const k of ['created_at','updated_at'])if(row[k]>2){if(row[k]<began||row[k]>Date.now())throw Error('clock outside run');row[k]='<clock>';}
      const data=JSON.parse(row.provider_data);if(data.installationId&&data.installationId!=='11111111-1111-4111-8111-111111111111')data.installationId='<uuid>';
      if(data.idSalt&&data.idSalt!=='a'.repeat(64))data.idSalt='<salt>';row.provider_data=JSON.stringify(data);
      if(row.id!=='c')row.id='<uuid>';
    }
    rows.push({row,typed});
  }db.close();return rows;
}
const results:any[]=[];
try{
for(const provider of ['openai','anthropic','antigravity'])for(const scenario of ['overlap','deleted','external-winner'])for(const json of [false,true]){
 const pair:any[]=[];
 for(const [i,cmd] of [ts,[binary!]].entries()){
  serial=0; const root=join(work!,`race-${provider}-${scenario}-${json}-${i}`);mkdirSync(root);const file=join(root,'omnigateway.db');copyFileSync(join(work!,'seed/omnigateway.db'),file);
  const d=new Database(file);d.run("INSERT INTO credentials(id,provider,label,auth_type,refresh_token,provider_data,created_at,updated_at) VALUES('c',?,'race','oauth',?,?,1,2)",[provider,await encrypt(key,'old'),JSON.stringify({installationId:'11111111-1111-4111-8111-111111111111',idSalt:'a'.repeat(64),keep:true})]);
  d.run("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('neighbor','openai','untouched','apiKey',1,2)");
  let notify!:()=>void;const arrived=new Promise<void>(r=>notify=r);arrival=notify;wait=true;
  const args=['credentials','refresh','c',...(json?['--json']:[])];const first=start(cmd,root,args);await arrived;
  let second:any=null;
  if(scenario==='overlap')second=await start(cmd,root,args).done;
  else if(scenario==='deleted')d.run("DELETE FROM credentials WHERE id='c'");
  else d.run("UPDATE credentials SET token_version=7,access_token=?,refresh_token=?,account_email='winner@test',provider_data='{}' WHERE id='c'",[await encrypt(key,'winner-access'),await encrypt(key,'winner-refresh')]);
  const before=await snapshot(file);const exactBefore=await snapshot(file,true);held.shift()!();const firstResult=await first.done;
  const after=await snapshot(file);d.close();
  const exactStable=eq(exactBefore,await snapshot(file,true));
  if(i===0&&!eq(before,after))throw Error('frozen stale write');
  pair.push({first:firstResult,second,before,after,exactStable});
 }
 results.push({provider,scenario,json,equal:eq(pair[0],pair[1]),pair});
}
for(const scenario of ['full-insert','insert-rejected','after-insert-rejected','no-update','reconnect-failure'])for(const json of [false,true]){
 const pair:any[]=[];
 for(const [i,cmd] of [ts,[binary!]].entries()){
  serial=0;const root=join(work!,`atomic-${scenario}-${json}-${i}`);mkdirSync(root);const file=join(root,'omnigateway.db');copyFileSync(join(work!,'seed/omnigateway.db'),file);
  const d=new Database(file);d.run("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('neighbor','openai','untouched','apiKey',1,2)");
  if(scenario==='reconnect-failure')d.run("INSERT INTO credentials(id,provider,label,auth_type,enabled,disabled_reason,created_at,updated_at) VALUES('c','anthropic','keep','oauth',0,'manual',1,2)");
  if(scenario==='full-insert')d.run("CREATE TRIGGER require_full BEFORE INSERT ON credentials WHEN NEW.access_token IS NULL BEGIN SELECT RAISE(ABORT,'incomplete credential'); END");
  if(scenario==='insert-rejected')d.run("CREATE TRIGGER reject_insert BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT,'fixture insert rejected'); END");
  if(scenario==='after-insert-rejected')d.run("CREATE TRIGGER reject_insert AFTER INSERT ON credentials BEGIN SELECT RAISE(ABORT,'fixture insert rejected'); END");
  if(scenario==='no-update'||scenario==='reconnect-failure')d.run("CREATE TRIGGER reject_metadata BEFORE UPDATE OF provider_data ON credentials BEGIN SELECT RAISE(ABORT,'fixture metadata rejected'); END");
  const before=await snapshot(file);const exactBefore=await snapshot(file,true);const output=await start(cmd,root,['connect','anthropic',...(scenario==='reconnect-failure'?['--credential','c']:[]),...(json?['--json']:[])],'@').done;
  output.out=output.out.replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g,'<uuid>');
  const after=await snapshot(file);const exactAfter=await snapshot(file,true);d.close();
  if(!eq(exactBefore.filter(v=>v.row.id==='neighbor'),exactAfter.filter(v=>v.row.id==='neighbor')))throw Error('neighbor changed');
  if(scenario.includes('rejected')&&!eq(exactBefore,exactAfter))throw Error('rejected insert changed cells');
  if(i===0&&scenario.includes('rejected')&&!eq(before,after))throw Error('frozen partial insert');
  pair.push({output,before,after});
 }
 results.push({scenario,json,equal:eq(pair[0],pair[1]),pair});
}
await Bun.write(join(work!,'races-results.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify({racePairs:results.length,equal:results.filter(r=>r.equal).length,failed:results.filter(r=>!r.equal).map(({provider,scenario,json})=>({provider,scenario,json}))}));
if(results.some(r=>!r.equal))process.exitCode=1;
}finally{stub.stop(true);}
