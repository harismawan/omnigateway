#!/usr/bin/env bun
// Run inside an isolated loopback network namespace with a private HOME.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
const [binary, workArg, reference] = process.argv.slice(2);
if (!binary || !workArg) throw Error("binary work required");
const work = resolve(workArg); mkdirSync(work, {recursive:true});
const p = Bun.spawn([binary], {cwd:work, env:{...process.env, OMNI_ROOT:work,
  OMNI_DB_PATH:`${work}/omni.db`, OMNI_ENCRYPTION_KEY:"stream-test-encryption-key-0123456789",
  OMNI_HOST:"127.0.0.1", OMNI_PORT:"18771", OMNI_LOG_LEVEL:"warn"},
  stdout:Bun.file(`${work}/stdout`), stderr:Bun.file(`${work}/stderr`)});
try {
  for(let i=0;i<200;i++) { try { if((await fetch("http://127.0.0.1:18771/health")).ok) break; }catch{} await Bun.sleep(25); }
  const setup = await fetch("http://127.0.0.1:18771/api/setup", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"stream-test-password"})});
  const login = await fetch("http://127.0.0.1:18771/api/login", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:"stream-test-password"})});
  const cookie=login.headers.get("set-cookie")?.split(";")[0];
  if(!cookie) throw Error(`setup ${setup.status} login ${login.status} ${await login.text()}`);
  const api=async(path:string,body:unknown,method="POST")=>fetch(`http://127.0.0.1:18771${path}`,{method,headers:{"content-type":"application/json",cookie},body:JSON.stringify(body)});
  const vp=await api("/api/settings/viewer-password",{password:"stream-viewer-password"},"PUT");
  if(!vp.ok) throw Error(`viewer password ${vp.status} ${await vp.text()}`);
  const viewer=await api("/api/login",{password:"stream-viewer-password",mode:"viewer"});
  const viewerCookie=viewer.headers.get("set-cookie")?.split(";")[0];
  const keyResponse=await api("/api/keys",{label:"stream-test"});
  const keyData=await keyResponse.json() as any;
  writeFileSync(`${work}/key-shape.json`,JSON.stringify(Object.keys(keyData)));
  const client=await api("/api/client/login",{key:keyData.key});
  const clientCookie=client.headers.get("set-cookie")?.split(";")[0];
  if(!viewerCookie || !clientCookie) throw Error(`role sessions ${viewer.status} ${client.status} key ${keyResponse.status} ${JSON.stringify(keyData)}`);
  const upgrade="Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
  const text=(s:string)=>{const b=Buffer.from(s);if(b.length>125)throw Error("probe too long");return Buffer.concat([Buffer.from([0x81,0x80|b.length,1,2,3,4]),Buffer.from(b.map((v,i)=>v^[1,2,3,4][i%4]))]);};
  for(const [name,headers,extra] of [
    ["plain","",Buffer.alloc(0)], ["none",upgrade,Buffer.alloc(0)],
    ["bearer",upgrade+"Authorization: Bearer x\r\n",Buffer.alloc(0)],
    ["both",upgrade+`Authorization: Bearer x\r\nCookie: ${cookie}\r\n`,Buffer.alloc(0)],
    ["invalid",upgrade+"Cookie: omni_admin=invalid\r\n",Buffer.alloc(0)],
    ["success",upgrade+`Cookie: ${cookie}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n`,Buffer.alloc(0)],
    ["viewer",upgrade+`Cookie: ${viewerCookie}\r\n`,Buffer.alloc(0)],
    ["client",upgrade+`Cookie: ${clientCookie}\r\n`,Buffer.alloc(0)],
    ["bad-version",upgrade.replace("Version: 13","Version: 12")+`Cookie: ${cookie}\r\n`,Buffer.alloc(0)],
    ["missing-key",upgrade.replace("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n","")+`Cookie: ${cookie}\r\n`,Buffer.alloc(0)],
    ["oversize",upgrade+`Cookie: ${cookie}\r\n`,Buffer.from([0x81,0xff,0,0,0,0,1,0,0,1,1,2,3,4])],
    ...[
      ["malformed","wat",cookie],
      ["no-source",JSON.stringify({type:"subscribe",topic:"stream:absent",id:"s"}),cookie],
      ["denied",JSON.stringify({type:"subscribe",topic:"res:settings"}),clientCookie],
      ["subscribe",JSON.stringify({type:"subscribe",topic:"res:logs",id:"s"}),cookie],
      ["unsubscribe",JSON.stringify({type:"unsubscribe",topic:"res:logs",id:"u"}),cookie],
      ["read-only",JSON.stringify({type:"send",topic:"res:logs",payload:{}}),cookie],
    ].map(([n,s,c])=>[n,upgrade+`Cookie: ${c}\r\n`,text(s)] as const),
  ] as const) {
    const result=await new Promise<Buffer>((yes,no)=>{
      const chunks:Buffer[]=[]; let sent=false;
      const s=connect(18771,"127.0.0.1",()=>s.write(`GET /api/stream HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`));
      s.on("data",b=>{chunks.push(b); const all=Buffer.concat(chunks); if(all.includes(Buffer.from("\r\n\r\n"))) {
        if(extra.length && !sent){ sent=true; s.write(extra); return; }
        if(!extra.length || all.indexOf(Buffer.from("\r\n\r\n"))+4<all.length) { s.destroy(); yes(all); }
      }}); s.on("error",no); s.on("end",()=>yes(Buffer.concat(chunks)));
      s.setTimeout(3000,()=>{s.destroy();yes(Buffer.concat(chunks));});
    });
    writeFileSync(`${work}/${name}.raw`,result);
    console.log(name,JSON.stringify(result.toString("latin1").replace(/omni_admin=[^;\r]+/g,"omni_admin=<token>")));
  }
  await api("/api/logout",{});
  const revoked=await new Promise<Buffer>((yes,no)=>{const chunks:Buffer[]=[];const s=connect(18771,"127.0.0.1",()=>s.write(`GET /api/stream HTTP/1.1\r\nHost: localhost\r\n${upgrade}Cookie: ${cookie}\r\n\r\n`));s.on("data",b=>{chunks.push(b);s.destroy();yes(Buffer.concat(chunks));});s.on("error",no);});
  writeFileSync(`${work}/revoked.raw`,revoked);if(!revoked.toString().startsWith("HTTP/1.1 401"))throw Error("revoked session upgraded");
  if(reference) {
    for(const name of ["plain","none","bearer","both","invalid","success","viewer","client","bad-version","missing-key","oversize","revoked","malformed","no-source","denied","subscribe","unsubscribe","read-only"]) {
      const canonical=(b:Buffer)=>{
        const at=b.indexOf("\r\n\r\n");if(at<0)throw Error("missing response head");
        const lines=b.subarray(0,at).toString("latin1").split("\r\n");
        // HTTP header names are case insensitive. Keep and disclose raw evidence.
        const head=lines.slice(1).map(s=>s.replace(/^([^:]+):/,(a,n)=>n.toLowerCase()+":")).filter(s=>!s.startsWith("date:")).sort();
        // Hyper emits CL:0 on Bun's header-only version rejection.
        if(name==="bad-version") {const i=head.indexOf("content-length: 0");if(i>=0)head.splice(i,1);}
        return [lines[0],head,b.subarray(at+4).toString("hex")];
      };
      const a=canonical(readFileSync(`${reference}/${name}.raw`)), b=canonical(readFileSync(`${work}/${name}.raw`));
      if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`${name}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    }
    console.log("18 paired status/header/body/frame comparisons pass; raw header casing and bad-version CL:0 deviations retained");
  }
} finally { p.kill("SIGTERM"); await p.exited; }
