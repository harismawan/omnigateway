"""A12 local DB dry-run stdout/stderr/exit differential (rankedAt validated)."""
import driver_env
import itertools, json, os, pathlib, shutil, subprocess, tempfile, time, sqlite3

scratch = pathlib.Path('/tmp/opencode/a12/cli')
scratch.mkdir(parents=True, exist_ok=True)
work = pathlib.Path(tempfile.mkdtemp(dir=scratch))
home = work/'home'
home.mkdir()
env = dict(PATH=os.environ['PATH'], HOME=str(home), XDG_STATE_HOME=str(home/'state'),
           XDG_CONFIG_HOME=str(home/'config'), OMNI_ENCRYPTION_KEY='a12-private-synthetic-key-long-enough', NO_COLOR='1', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
commands = [['bun','--no-env-file',str(pathlib.Path.cwd()/'apps/cli/src/index.ts')], [os.environ['OMNI_CLI_BIN']]]
# Hermetic schema and seed, independent of HTTP evidence directories.
subprocess.run(commands[0]+['--root',str(home),'status','--json'],env=env,capture_output=True,check=True)
db=sqlite3.connect(home/'omnigateway.db')
targets=[dict(provider=p,model=m,tier=t,weight=1,costPerMTok=dict(input=1,output=2),capabilities=dict(tools=True,images=True,reasoning=True)) for p,m,t in [('openai','gpt-4.1',1),('missing-plugin','test',2),('kilo','test',1)]]
for s in ['score','priority','weighted','roundRobin']:
    db.execute('INSERT INTO virtual_models(id,targets,strategy) VALUES(?,?,?)',(s,json.dumps(targets),s))
for id,p,enabled,expiry in [('ok','openai',1,None),('disabled','openai',0,None),('expired','openai',1,1),('expired-oauth','openai',1,1),('unhealthy','openai',1,None),('kilo','kilo',1,None),('plugin','missing-plugin',1,None)]:
    db.execute("INSERT INTO credentials(id,provider,label,auth_type,enabled,expires_at,created_at,updated_at) VALUES(?,?,?,'apiKey',?,?,1,1)",(id,p,id,enabled,expiry))
db.execute("UPDATE credentials SET auth_type='oauth' WHERE id='expired-oauth'")
db.execute("INSERT INTO credential_health VALUES('unhealthy','gpt-4.1','open',5,4102444800000,4102444800000)")
db.commit();db.close()
seed=(home/'omnigateway.db').read_bytes()
cases = []
for model in ['score','priority','weighted','roundRobin','gpt-4.1','unknown']:
    for bits in itertools.product([False,True], repeat=3):
        for js in [False,True]:
            cases.append(['models','dry-run',model]+[f'--{f}' for f,b in zip(['tools','images','reasoning'],bits) if b]+(['--json'] if js else []))
cases += [['models','dry-run'],['models','dry-run','--json'],['models','dry-run','score','--tools=false'],['models','dry-run','score','--wat']]
stored=[None,"INSERT INTO virtual_models(id,targets,strategy) VALUES('broken','{}','score')","UPDATE credentials SET tier='oops' WHERE id='ok'","UPDATE virtual_models SET targets=json_set(targets,'$[0].tier','2') WHERE id='score'","UPDATE virtual_models SET targets='[]'","UPDATE credentials SET api_key='garbage' WHERE id='ok'"]
rows=[]
for args,sql in [(a,None) for a in cases]+[(['models','dry-run','score']+(['--json'] if js else []),sql) for sql in stored for js in [False,True]]:
    pair=[]
    for command in commands:
        (home/'omnigateway.db').write_bytes(seed)
        if sql:
            db=sqlite3.connect(home/'omnigateway.db');db.execute(sql);db.commit();db.close()
        p=subprocess.run(command+['--root',str(home)]+args,env=env,capture_output=True,timeout=30)
        out=p.stdout.decode(); err=p.stderr.decode()
        if '--json' in args and p.returncode==0:
            body=json.loads(out)
            assert abs(body['rankedAt']-time.time()*1000)<120000
            body['rankedAt']='<now>'
            out=json.dumps(body,ensure_ascii=False)
        pair.append(dict(code=p.returncode,out=out,err=err))
    rows.append(dict(args=args,sql=sql,pair=pair,equal=pair[0]==pair[1]))
(work/'rows.json').write_text(json.dumps(rows,indent=2))
manifest=json.loads((pathlib.Path.cwd()/'conformance/e2e/models-dry-run-accepted.json').read_text())
for r in rows:
    if r['equal'] or '--json' not in r['args']: continue
    entry=next((e for e in manifest['rows'] if e['identity']=='cli:'+str(r['sql'])),None)
    if not entry or [p['code'] for p in r['pair']]!=entry['statuses']: continue
    a,b=[json.loads(p['out']) for p in r['pair']]
    for path in entry['paths']:
        def remove(obj):
            parts=path.strip('/').split('/')
            for k in parts[:-1]: obj=obj[int(k)] if isinstance(obj,list) else obj[k]
            obj[parts[-1]]='<accepted-render>'
        remove(a);remove(b)
    r['accepted']=a==b and r['pair'][0]['err']==r['pair'][1]['err']
failures=[r for r in rows if not r['equal'] and not r.get('accepted')]
(work/'rows.json').write_text(json.dumps(rows,indent=2))
print(json.dumps(dict(cases=len(rows),accepted=sum(bool(r.get('accepted')) for r in rows),failures=len(failures),work=str(work))))
raise SystemExit(bool(failures))
