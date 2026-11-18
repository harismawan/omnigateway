/** Namespace-only CLI refresh oracle; compare bytes and every typed stored cell. */
import { Database } from 'bun:sqlite';
import { mkdirSync, copyFileSync } from 'node:fs';
import { isDeepStrictEqual as eq } from 'node:util';
import { resolve, join } from 'node:path';
import { deriveKey, encrypt, decrypt } from '../../packages/store/src/encryption.ts';
const [binary, work] = process.argv.slice(2).map(p => resolve(p));
const env = { PATH: process.env.PATH!, HOME: join(work!, 'home'), TMPDIR: join(work!, 'tmp'), OMNI_ENCRYPTION_KEY: 'review-secret-long-enough', NO_COLOR: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', NODE_EXTRA_CA_CERTS: join(work!, 'cert.pem'), SSL_CERT_FILE: join(work!, 'cert.pem') };
const key = await deriveKey(env.OMNI_ENCRYPTION_KEY);
const ts = ['bun', '--no-env-file', 'apps/cli/src/index.ts'];
const seed = join(work!, 'seed'); mkdirSync(seed);
async function call(command: string[], root: string, args: string[], input = '') {
  const dynamic = input.startsWith('@');
  const p = Bun.spawn([...command, '--root', root, ...args], { env, stdin: dynamic ? 'pipe' : new Response(input), stdout: 'pipe', stderr: 'pipe' });
  async function stderr() {
    let err = '', sent = false;
    for await (const chunk of p.stderr) {
      err += new TextDecoder().decode(chunk);
      if (dynamic && !sent && err.includes('state=')) {
        const uri = err.match(/  (https:\/\/[^\n]+)/)![1]!;
        const state = new URL(uri).searchParams.get('state');
        const provider = args[1];
        const code = input === '@callback' ? `${provider === 'openai' ? 'http://localhost:1455/auth/callback' : 'https://antigravity.google/oauth-callback'}?code=code&state=${state}` : `code#${state}`;
        (p.stdin as any).write(code); (p.stdin as any).end(); sent = true;
      }
    }
    return err;
  }
  let [out, err, code] = await Promise.all([new Response(p.stdout).text(), stderr(), p.exited]);
  // Only the PKCE challenge and state in authorization instructions are random.
  if (args[0] === 'connect') err = err.replace(/(code_challenge=)[^&\n]+/g,'$1<challenge>').replace(/(state=)[^&\n]+/g,'$1<state>');
  return { out, err, code };
}
if ((await call(ts, seed, ['credentials','list'])).code) throw Error('seed failed');
let mode = 'success', requests: string[] = [];
const stub = Bun.listen<{ bytes: Buffer }>({ hostname: '127.0.0.1', port: 443, tls: { cert: Bun.file(join(work!, 'cert.pem')), key: Bun.file(join(work!, 'key.pem')) }, socket: {
  open(s) { s.data = { bytes: Buffer.alloc(0) }; },
  data(s, chunk) {
    s.data.bytes = Buffer.concat([s.data.bytes, chunk]); const end = s.data.bytes.indexOf('\r\n\r\n'); if (end < 0) return;
    const head = s.data.bytes.subarray(0,end).toString(), length = Number(head.match(/content-length: (\d+)/i)?.[1] ?? 0);
    if (s.data.bytes.length < end + 4 + length) return;
    requests.push(s.data.bytes.toString());
    if (mode === 'close') { s.end(); return; }
    if (mode === 'truncated') { s.end('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{'); return; }
    const status = mode === 'auth' ? 401 : mode === 'upstream' ? 503 : 200;
    const body = head.includes('/oauth2/v1/userinfo') ? '{"email":"fixture@example.test"}' : head.includes(':loadCodeAssist') ? '{"cloudaicompanionProject":"fixture-project","currentTier":{"id":"fixture-tier"}}' : mode === 'invalid' ? 'invalid' : status !== 200 ? '{"error":"invalid_grant"}' : '{"access_token":"new-access","refresh_token":"new-refresh"}';
    s.end(`HTTP/1.1 ${status} OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  }
} });
async function snapshot(file: string, started: number, ended: number, connectedId?: string) {
  const d = new Database(file); const rows: any[] = [];
  for (const table of ['credentials','credential_health','virtual_models']) {
    const columns = (d.query(`pragma table_info(${table})`).all() as any[]).map(r => r.name);
    for (const row of d.query(`select *, ${columns.map(c => `typeof("${c}") as "type:${c}"`).join(',')} from ${table} order by rowid`).all() as any[]) {
      for (const c of columns) {
        if (table === 'credentials' && (row.id === 'c' || row.id === connectedId) && ['created_at','updated_at','disabled_at'].includes(c) && row[c] !== null && row[c] > 2) {
          if (!(row[c] >= started && row[c] <= ended)) throw Error('clock outside execution'); row[c] = '<clock>';
        }
        if (table === 'credentials' && (row.id === 'c' || row.id === connectedId) && ['access_token','refresh_token','api_key','id_token'].includes(c) && row[c] !== null) row[c] = await decrypt(key,row[c]);
        if (table === 'credentials' && row.id === connectedId && c === 'provider_data' && row.provider === 'openai') {
          const data = JSON.parse(row[c]);
          if (!/^[0-9a-f-]{36}$/.test(data.installationId) || !/^[0-9a-f]{64}$/.test(data.idSalt)) throw Error('invalid generated identity');
          data.installationId='<uuid>'; data.idSalt='<salt>'; row[c]=JSON.stringify(data);
        }
      }
      if (row.id === connectedId) row.id = '<uuid>';
      rows.push({table,row});
    }
  }
  d.close(); return rows;
}
const results: any[] = [];
try {
  for (const provider of ['openai','anthropic','antigravity']) for (const scenario of ['success','auth','upstream','invalid','close','truncated','no-token','missing']) for (const json of [false,true]) {
    const pair: any[] = [];
    for (const [index, command] of [ts,[binary!]].entries()) {
      mode = scenario; requests = [];
      const root = join(work!,`${provider}-${scenario}-${json}-${index}`); mkdirSync(root); const file = join(root,'omnigateway.db'); copyFileSync(join(seed,'omnigateway.db'),file);
      const d = new Database(file);
      d.run("INSERT INTO credentials(id,provider,label,auth_type,refresh_token,provider_data,created_at,updated_at) VALUES('c',?,'account','oauth',?,?,1,2)",[provider,scenario === 'no-token' ? null : await encrypt(key,'old-refresh'),JSON.stringify({installationId:'11111111-1111-4111-8111-111111111111',idSalt:'a'.repeat(64),neighbor:true})]);
      d.run("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('neighbor','openai','neighbor','apiKey',1,2)"); d.close();
      const started = Date.now(); const output = await call(command,root,['credentials','refresh',scenario === 'missing' ? 'missing' : 'c',...(json ? ['--json'] : [])]);
      pair.push({...output,rows: await snapshot(file,started,Date.now()),requests});
    }
    results.push({provider,scenario,json,equal:eq(pair[0],pair[1]),pair});
  }
  for (const provider of ['openai','anthropic','antigravity']) for (const scenario of ['success','reconnect','callback','auth','upstream','invalid','close','truncated','wrong-state','wrong-callback','missing-callback-state','bad-reconnect']) for (const json of [false,true]) {
    if (provider === 'anthropic' && scenario.includes('callback')) continue;
    const pair: any[] = [];
    for (const [index, command] of [ts,[binary!]].entries()) {
      mode = scenario; requests = [];
      const root = join(work!,`connect-${provider}-${scenario}-${json}-${index}`); mkdirSync(root); const file = join(root,'omnigateway.db'); copyFileSync(join(seed,'omnigateway.db'),file);
      if (scenario === 'reconnect') {
        const d = new Database(file); d.run("INSERT INTO credentials(id,provider,label,auth_type,enabled,tier,weight,provider_data,disabled_reason,disabled_at,token_version,created_at,updated_at) VALUES('c',?,'preserve label','oauth',0,4,2,'{\"old\":true}','manual',2,5,1,2)",[provider]); d.close();
      }
      const input = ['success','reconnect'].includes(scenario) ? '@code' : scenario === 'callback' ? '@callback' : scenario === 'wrong-state' ? 'code#wrong' : scenario === 'wrong-callback' ? 'https://wrong.test/callback?code=c&state=s' : scenario === 'missing-callback-state' ? (provider === 'openai' ? 'http://localhost:1455/auth/callback?code=c' : 'https://antigravity.google/oauth-callback?code=c') : 'code';
      const started = Date.now(); const output = await call(command,root,['connect',provider,...(scenario === 'bad-reconnect' ? ['--credential','missing'] : scenario === 'reconnect' ? ['--credential',' c ','--label','ignored'] : ['--label',' chosen ']),...(json ? ['--json'] : [])], input);
      // Verify request fields independently; compare only protocol-invariant fields.
      const normalized = requests.map(raw => {
        const [head,body] = raw.split('\r\n\r\n');
        if (!head!.includes('/token')) return {path:head!.split('\r\n')[0],body};
        if (!body) throw Error('missing exchange body');
        const fields = provider === 'anthropic' ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
        if (!/^[A-Za-z0-9_-]{43}$/.test(fields.code_verifier)) throw Error('invalid verifier');
        fields.code_verifier = '<verifier>'; if (fields.state) fields.state = '<state>';
        return {path:head!.split('\r\n')[0],fields};
      });
      const id = output.code === 0 ? scenario === 'reconnect' ? 'c' : output.out.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/)![0] : undefined;
      if (id && id !== 'c') output.out = output.out.replace(id,'<uuid>');
      pair.push({...output,rows: await snapshot(file,started,Date.now(),id),requests:normalized});
    }
    results.push({provider,scenario:'connect-'+scenario,json,equal:eq(pair[0],pair[1]),pair});
  }
  await Bun.write(join(work!,'results.json'),JSON.stringify(results,null,2));
  const failed = results.filter(r=>!r.equal); console.log(JSON.stringify({pairs:results.length,equal:results.length-failed.length,failed:failed.map(({provider,scenario,json})=>({provider,scenario,json}))})); process.exitCode = failed.length ? 1 : 0;
} finally { stub.stop(true); }
