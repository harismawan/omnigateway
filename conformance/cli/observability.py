"""Representative E3 local-store corpus. Run in unshare -Urn; no external traffic.

OMNI_CLI_BIN selects candidate; E3_ORACLE_ROOT selects frozen source checkout.
All stdout/stderr/exit comparisons are exact (no normalization).
"""
import hashlib, json, os, pathlib, signal, sqlite3, subprocess, tempfile, time
repo=pathlib.Path.cwd(); oracle=pathlib.Path(os.environ.get('E3_ORACLE_ROOT',str(repo)))
binary=os.environ['OMNI_CLI_BIN']; evidence=pathlib.Path(tempfile.mkdtemp(prefix='corpus-',dir='/tmp/opencode/e3'))
home=evidence/'home'; home.mkdir(); root=home/'root'; root.mkdir(); tmp=evidence/'tmp';tmp.mkdir()
env=dict(PATH=os.environ['PATH'], HOME=str(home),TMPDIR=str(tmp),XDG_STATE_HOME=str(home/'state'),OMNI_ENCRYPTION_KEY='e3-fixture-encryption-key',NO_COLOR='1',TZ='UTC',BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
commands=[['bun','--no-env-file',str(oracle/'apps/cli/src/index.ts')],[binary]]
def call(command,args,extra=None,tty=False):
    argv=command+['--root',str(root)]+args
    childenv=env| (extra or {})
    if tty:
        argv=['python3',str(repo/'conformance/cli/pty.py'),'']+argv
        childenv.pop('NO_COLOR',None)
    p=subprocess.run(argv,env=childenv,capture_output=True,timeout=30,cwd=home)
    return dict(code=p.returncode,out=p.stdout.decode(),err=p.stderr.decode())
seed=call(commands[0],['usage','--json']);assert seed['code']==0,seed
subprocess.run(['bun','--no-env-file',str(repo/'conformance/cli/observability-fixture.ts'),str(root/'omnigateway.db')],env=env,check=True,cwd=home)
with sqlite3.connect(root/'omnigateway.db') as db:
    rel,size,digest=db.execute("SELECT rel_path,size_bytes,sha256 FROM request_bodies WHERE request_id='body-ready'").fetchone()
artifact=next(p for p in root.rglob(pathlib.Path(rel).name) if p.is_file())
encrypted=artifact.read_bytes();assert len(encrypted)==size and hashlib.sha256(encrypted).hexdigest()==digest
assert b'intended body output' not in encrypted
results=[]; failures=[]
def pair(label,args,extra=None,tty=False):
    got=[call(c,args,extra,tty) for c in commands];results.append(dict(label=label,args=args,pair=got));
    if got[0]!=got[1]: failures.append(results[-1])
    return got
for args in [['logs'],['usage'],['usage','--json'],['logs','--json'],['quota'],['quota','--json'],['bodies','absent'],['bodies','body-ready'],['bodies','body-ready','--full'],['bodies','body-ready','--json'],['console'],['console','--json'],['logs','--service']]:pair('empty/'+ '/'.join(args),args)
with sqlite3.connect(root/'omnigateway.db') as db:
    db.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('c','openai','account','oauth',1,1)")
    db.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('g','antigravity','unknown','oauth',2,2)")
    db.execute("INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES('c','fiveHour',0,25,100,100000,1)")
    db.execute("INSERT INTO request_bodies(request_id,at,rel_path,size_bytes,detail_state) VALUES('body-missing',1000,'lost',12,'ready')")
    for i in range(25):db.execute("INSERT INTO request_logs(id,at,api_key_id,requested_model,resolved_provider,resolved_model,credential_id,attempts,status,error_code,input_tokens,output_tokens,duration_ms,cost_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(f'log-{i:03}',1000+i//2,'key','alias' if i%2 else 'other','openai','resolved','c',1,500 if i%3==0 else 200,'UPSTREAM' if i%3==0 else None,10,20,50,0.0123))
    # Ordinary export crosses the 500-row page boundary.
    for i in range(501):db.execute("INSERT INTO request_logs(id,at,requested_model,resolved_provider,resolved_model,status,duration_ms) VALUES(?,?,'export','openai','resolved',200,1)",(f'export-{i:03}',2000+i))
for args in [['logs'],['logs','--json','-n','3'],['logs','--failed','--model','alias'],['logs','--account','c','--key','key','--since','1000','--until','1010'],['logs','--requested-model','other'],['logs','--resolved-model','resolved','--error-code','UPSTREAM'],['usage','--until','3000'],['usage','--by','provider','--split','model','--until','3000','--json'],['usage','--grain','daily','--by','day','--until','3000'],['quota'],['quota','--json'],['bodies','body-missing']]:pair('populated/'+ '/'.join(args),args)
now=int(time.time()*1000)
with sqlite3.connect(root/'omnigateway.db') as db:
    db.execute("UPDATE quota_windows SET resets_at=?,observed_at=? WHERE credential_id='c'",(now+3600000,now-1000))
    db.execute("INSERT INTO quota_samples(credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms) VALUES('c','fiveHour',20,100,?,?,NULL)",(now+3600000,now-2000))
pair('quota/fresh-history',['quota','--json'])
pair('json-follow-is-once',['logs','--follow','--json'])
pair('body/wrong-key',['bodies','body-ready'],{'OMNI_ENCRYPTION_KEY':'different-fixture-encryption-key'})
subprocess.run(['bun','--no-env-file',str(repo/'conformance/cli/observability-fixture.ts'),str(root/'omnigateway.db')],env=env,check=True,cwd=home)
pair('db/permission',['logs','--db',str(evidence/'nonexistent'/'db')])
page=pair('cursor-first',['logs','--json','-n','3'])[0];cursor=json.loads(page['out'])['nextCursor'];assert cursor
pair('cursor-next',['logs','--json','-n','3','--cursor',cursor])
for fmt in ['csv','jsonl']:
    got=pair('export/'+fmt,['logs','export','--since','2000','--until','3000','--format',fmt,'--json'])
    assert len(got[0]['out'].splitlines())==(502 if fmt=='csv' else 501)
    if got[1]['code']==0:assert 'export-000' in got[1]['out'] and 'export-500' in got[1]['out']
    (evidence/('export.'+fmt)).write_text(got[1]['out'])
log=evidence/'console.log';log.write_text('runtime notice\n2026-01-01T00:00:00.000Z INFO  ready  port=1\n2026-01-01T00:00:01.000Z ERROR failed  code=UPSTREAM\n')
for args in [['console'],['console','--json'],['console','--level','error','-n','1'],['console','--json','--level','warn'],['logs','--service','--json']]:pair('file/'+ '/'.join(args),args,{'OMNI_LOG_FILE':str(log)})
for args in [['logs','-n','2'],['bodies','body-ready'],['console']]:pair('tty/'+ '/'.join(args),args,{'OMNI_LOG_FILE':str(log)},True)
unit=home/'.config/systemd/user/omnigateway.service';unit.parent.mkdir(parents=True);unit.write_text('[Service]\n')
binpath=evidence/'bin';binpath.mkdir();journal=binpath/'journalctl';journal.write_text('#!/bin/sh\nprintf \'2026-01-01T00:00:00.000Z WARN  journal line\\n\'\n');journal.chmod(0o755)
pair('journal/json',['console','--json'],{'PATH':str(binpath)+':'+env['PATH']})
pair('journal/human',['console'],{'PATH':str(binpath)+':'+env['PATH']})
pair('configured-file-wins-journal',['console','--json'],{'PATH':str(binpath)+':'+env['PATH'],'OMNI_LOG_FILE':str(log)})
unit.unlink()
for args in [['bodies'],['quota','refresh'],['quota','refresh','c','--all'],['quota','resets','absent'],['quota','reset','absent','--yes'],['quota','resets','g'],['quota','reset','g','--yes'],['usage','--grain','bad'],['logs','export','--since','0'],['logs','--since','not a time'],['console','--level','bad'],['logs','-n','bad']]:pair('error/'+ '/'.join(args),args)
# One normal follow delta and SIGINT per command, including same-millisecond IDs.
for command in ['logs','console']:
    followed=[]
    for index,c in enumerate(commands):
        if command=='logs':
            with sqlite3.connect(root/'omnigateway.db') as db:db.execute("DELETE FROM request_logs WHERE id LIKE 'zz-follow%'")
        else:log.write_text('2026-01-01T00:00:00.000Z INFO  initial\n')
        p=subprocess.Popen(c+['--root',str(root),command,'--follow','-n','2'],env=env|{'OMNI_LOG_FILE':str(log)},stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=home)
        time.sleep(1)
        if command=='logs':
            with sqlite3.connect(root/'omnigateway.db') as db:
                for n in range(5):db.execute("INSERT INTO request_logs(id,at,requested_model,resolved_provider,resolved_model,status,duration_ms) VALUES(?,2500,?,'openai','resolved',200,1)",(f'zz-follow-{n}',f'delta-{n}'))
        else:
            with log.open('a') as f:f.write('2026-01-01T00:00:01.000Z WARN  delta\n')
        time.sleep(2.2);p.send_signal(signal.SIGINT);out,err=p.communicate(timeout=10)
        followed.append(dict(code=p.returncode,out=out.decode(),err=err.decode()))
    results.append(dict(label='follow/'+command,pair=followed))
    # Unix signal exit spelling differs in Bun and Rust; assert both terminate by SIGINT.
    if not (all(r['code'] in [-signal.SIGINT,130] and 'delta' in r['out'] for r in followed) and followed[0]['out']==followed[1]['out'] and followed[0]['err']==followed[1]['err']):failures.append(results[-1])
(evidence/'results.json').write_text(json.dumps(results,indent=2));(evidence/'failures.json').write_text(json.dumps(failures,indent=2))
print(json.dumps(dict(evidence=str(evidence),cases=len(results),failures=len(failures),binary_sha256=hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest())))
assert not failures, failures[:2]
