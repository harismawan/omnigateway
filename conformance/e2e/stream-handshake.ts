#!/usr/bin/env bun
// Run inside an isolated loopback network namespace with a private HOME.
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
const [binary, workArg] = process.argv.slice(2);
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
  const upgrade="Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
  for(const [name,headers,extra] of [
    ["plain","",Buffer.alloc(0)], ["none",upgrade,Buffer.alloc(0)],
    ["bearer",upgrade+"Authorization: Bearer x\r\n",Buffer.alloc(0)],
    ["both",upgrade+`Authorization: Bearer x\r\nCookie: ${cookie}\r\n`,Buffer.alloc(0)],
    ["invalid",upgrade+"Cookie: omni_admin=invalid\r\n",Buffer.alloc(0)],
    ["success",upgrade+`Cookie: ${cookie}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n`,Buffer.alloc(0)],
    ["oversize",upgrade+`Cookie: ${cookie}\r\n`,Buffer.from([0x81,0xff,0,0,0,0,1,0,0,1,1,2,3,4])],
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
} finally { p.kill("SIGTERM"); await p.exited; }
