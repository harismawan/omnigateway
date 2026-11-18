#!/usr/bin/env bun
/** Run inside unshare -Urn, loopback up. No external providers or user config. */
import { Database } from "bun:sqlite";
import { mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { request as nodeRequest } from "node:http";
// Normal body-upload latency separates the frozen dispatch clock from HTTP.
async function delayedRequest(url:string, headers:Record<string,string>, body:string):Promise<Response> {
 return await new Promise((resolve,reject)=>{
  const req=nodeRequest(url,{method:"POST",headers:{...headers,"content-length":String(Buffer.byteLength(body))}},res=>{
   const chunks:Buffer[]=[];res.on("data",x=>chunks.push(x));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode!})));
  });
  req.on("error",reject);req.flushHeaders();setTimeout(()=>req.end(body),250);
 });
}
const { values: f } = parseArgs({ options: Object.fromEntries(["ts", "rust", "out", "cert", "key"].map(k => [k, {type:"string" as const}])) });
for (const k of ["ts","rust","out","cert","key"]) if (!f[k]) throw Error(`missing ${k}`);
const out=resolve(f.out!); mkdirSync(out,{recursive:true});
const seed=join(out,"seed"); mkdirSync(seed); mkdirSync(join(out,"home")); mkdirSync(join(out,"tmp"));
const env={ HOME:join(out,"home"), TMPDIR:join(out,"tmp"), PATH:"/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin",
  NODE_EXTRA_CA_CERTS:resolve(f.cert!),SSL_CERT_FILE:resolve(f.cert!), OMNI_ROOT:seed, OMNI_DB_PATH:join(seed,"omnigateway.db"),
  OMNI_ENCRYPTION_KEY:"otlp-fixture-encryption-key-0123456789",OMNI_HOST:"127.0.0.1",OMNI_LOG_LEVEL:"warn",OMNI_STATIC_DIR:join(out,"absent"),OMNI_VERSION:"fixture" };
async function cli(args:string[], input?:string) {
 const p=Bun.spawn(["bun","--no-env-file","apps/cli/src/index.ts","--root",seed,"--json",...args],{cwd:resolve(import.meta.dir,"../.."),env,stdin:input?new TextEncoder().encode(input):"ignore",stdout:"pipe",stderr:"pipe"});
 const [o,e]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]); if(await p.exited)throw Error(e); return JSON.parse(o);
}
await cli(["credentials","add-key","anthropic","--label","fixture"],"provider-secret\n");
await cli(["credentials","add-key","anthropic","--label","fallback"],"provider-secret-2\n");
await Bun.write(join(seed,"model.json"),JSON.stringify({id:"fixture",strategy:"priority",isAlias:false,targets:[{provider:"anthropic",model:"claude-opus-5-5",tier:1,weight:1,costPerMTok:{input:4,output:20},capabilities:{tools:true,images:true,reasoning:true}}]}));
await cli(["models","put","fixture","-f",join(seed,"model.json")]);
const key=(await cli(["keys","create","--label","fixture"])).key;
const sse='event: message_start\ndata: {"message":{"id":"fixed","model":"claude-opus-5-5","usage":{"input_tokens":10}}}\n\nevent: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"hello"}}\n\nevent: content_block_stop\ndata: {"index":0}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {}\n\n';
let failNext=false;
const upstream=Bun.serve({hostname:"127.0.0.1",port:443,tls:{cert:Bun.file(f.cert!),key:Bun.file(f.key!)},fetch:()=>{if(failNext){failNext=false;return Response.json({error:{type:"overloaded_error",message:"fixture"}},{status:503})}return new Response(sse,{headers:{"content-type":"text/event-stream"}})}});
let received:any[]=[];
const collector=Bun.serve({hostname:"127.0.0.1",port:4318,async fetch(r){ const body=await r.json(); received.push({path:new URL(r.url).pathname,content:r.headers.get("content-type"),auth:r.headers.get("x-collector"),body}); return new Response(null,{status:200}); }});
async function until(fn:()=>Promise<boolean>|boolean, label:string) { const end=Date.now()+12000; do {if(await fn())return;await Bun.sleep(25);}while(Date.now()<end);throw Error(label); }
const inbound="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
async function run(binary:string,label:string) {
 received=[];const root=join(out,label);mkdirSync(root);copyFileSync(env.OMNI_DB_PATH,join(root,"omni.db"));
 const p=Bun.spawn([resolve(binary)],{cwd:root,env:{...env,OMNI_ROOT:root,OMNI_DB_PATH:join(root,"omni.db"),OMNI_PORT:"8800",OMNI_OTLP_ENDPOINT:"http://127.0.0.1:4318///",OMNI_OTLP_HEADERS:"x-collector=fixture",OMNI_TRACE_SAMPLE:"0"},stdout:Bun.file(join(root,"stdout")),stderr:Bun.file(join(root,"stderr"))});
 try {
 await until(async()=>{try{return(await fetch("http://127.0.0.1:8800/health")).ok}catch{return false}},"boot");
 for(const [surface,stream] of [["messages",false],["chat/completions",true],["responses",false]] as const) {
 const body={model:"fixture",stream,max_tokens:64,...(surface==="responses"?{input:"private prompt"}:{messages:[{role:"user",content:"private prompt"}]})};
 const r=await delayedRequest(`http://127.0.0.1:8800/v1/${surface}`,{authorization:`Bearer ${key}`,"content-type":"application/json",traceparent:inbound},JSON.stringify(body));await r.text();if(r.status!==200)throw Error(`response ${r.status}`);
 }
 // Representative precommit failover, then an authentication error root.
 failNext=true;
 const retry=await fetch("http://127.0.0.1:8800/v1/messages",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json",traceparent:inbound},body:JSON.stringify({model:"fixture",max_tokens:64,messages:[{role:"user",content:"private prompt"}]})});await retry.text();if(retry.status!==200)throw Error("failover response");
 const denied=await fetch("http://127.0.0.1:8800/v1/messages",{method:"POST",headers:{authorization:"Bearer invalid","content-type":"application/json",traceparent:inbound},body:"{}"});await denied.text();if(denied.status!==401)throw Error("auth response");
 // Unsampled inbound and absent header both suppress tracing at local sample0.
 for(const tp of [inbound.replace(/01$/,"00"),null]) {
 const r=await fetch("http://127.0.0.1:8800/v1/messages",{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json",...(tp?{traceparent:tp}:{})},body:JSON.stringify({model:"fixture",max_tokens:64,messages:[{role:"user",content:"private prompt"}]})});await r.text();
 }
 await until(()=>received.flatMap(x=>x.body.resourceSpans).length>=5,"collector export missing (base-red expected)");
 const resources=received.flatMap(x=>x.body.resourceSpans);if(resources.length!==5)throw Error("sampling count");
 await Bun.write(join(root,"raw.json"),JSON.stringify(received,null,2));
 for(const r of received)if(r.path!=="/v1/traces"||r.content!=="application/json"||r.auth!=="fixture")throw Error("collector HTTP contract");
 const normalized=resources.map((r:any,index:number)=>{
 const spans=r.scopeSpans[0].spans;const ids=spans.map((s:any)=>s.spanId);const start=BigInt(spans[0].startTimeUnixNano);
 const expected=index===3?7:index===4?1:5;
 if(spans.length!==expected)throw Error(`span count ${spans.length} expected ${expected}`);
 if(index<3) {
 // Frozen dispatch times exclude upload/auth; HTTP keeps actual wall time.
 // Bound the stub dispatch to <125ms, distinctly below the 250ms upload.
 const offset=(s:any,key:string)=>Number(BigInt(s[key])-start)/1e6;
 for(const s of spans.filter((s:any)=>s.name!=="provider.http")) {
  if(offset(s,"endTimeUnixNano")>=125)throw Error(`${label} ${s.name}: dispatch/root clock includes upload delay`);
 }
 const http=spans.find((s:any)=>s.name==="provider.http");
 if(offset(http,"startTimeUnixNano")<200)throw Error(`${label}: HTTP clock lost upload delay`);
 const attempt=spans.find((s:any)=>s.name==="dispatch.attempt");
 const commit=spans.find((s:any)=>s.name==="stream.commit");
 if(offset(commit,"startTimeUnixNano")<offset(attempt,"startTimeUnixNano")||offset(commit,"endTimeUnixNano")>offset(attempt,"endTimeUnixNano"))throw Error("dispatch clock ordering");
 }
 for(const s of spans) {
 if(!/^[0-9a-f]{16}$/.test(s.spanId)||s.traceId!==inbound.split('-')[1])throw Error("ids");
 const a=BigInt(s.startTimeUnixNano),b=BigInt(s.endTimeUnixNano);if(b<a||a<start||b-start>10_000_000_000n)throw Error("duration boundary");
 }
 if(new Set(ids).size!==expected||spans[0].parentSpanId!==inbound.split('-')[2])throw Error("root topology");
 if(expected>1&&(spans[1].parentSpanId!==ids[0]||spans[2].parentSpanId!==ids[0]||spans[3].parentSpanId!==ids[2]))throw Error("attempt topology");
 if(expected===5&&spans[4].parentSpanId!==ids[2])throw Error("commit topology");
 if(expected===7&&(spans[4].parentSpanId!==ids[0]||spans[5].parentSpanId!==ids[4]||spans[6].parentSpanId!==ids[4]||spans[2].status.code!==2))throw Error("failover topology/status");
 if(expected===1&&spans[0].status.code!==2)throw Error("error status");
 return {resource:r.resource,spans:spans.map((s:any)=>({name:s.name,parent:ids.indexOf(s.parentSpanId),attributes:s.attributes,status:s.status}))};
 });
 if(JSON.stringify(normalized).includes("private prompt")||JSON.stringify(normalized).includes("provider-secret"))throw Error("secret export");
 await Bun.write(join(root,"raw.json"),JSON.stringify(received,null,2));return normalized;
 }finally{p.kill("SIGTERM");await p.exited;}
}
try{const a=await run(f.ts!,"ts"),b=await run(f.rust!,"rust");await Bun.write(join(out,"normalized.json"),JSON.stringify({a,b},null,2));if(!isDeepStrictEqual(a,b))throw Error("semantic difference");console.log("PASS 5 paired traces / 23 spans, failover/auth, sampling, topology, duration, allowlist, HTTP");}finally{collector.stop(true);upstream.stop(true);}
