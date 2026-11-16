"""Frozen stored-cell corpus: full streams and exits, no normalization."""
import pathlib, subprocess, os, sqlite3, json, tempfile, collections
import driver_env

base = pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/cli-fix5/c-cells-'))
repo = pathlib.Path.cwd()
env = {k:v for k,v in os.environ.items() if not k.startswith('OMNI_')}
env.update(HOME=str(base), XDG_STATE_HOME=str(base/'state'), OMNI_ENCRYPTION_KEY='review-secret-long-enough', NO_COLOR='1')
cmds = [['bun','--no-env-file',str(repo/'apps/cli/src/index.ts')],[os.environ['OMNI_CLI_BIN']]]
root = base/'seed'; root.mkdir()
subprocess.run(cmds[0]+['--root',str(root),'status','--json'],env=env,capture_output=True,check=True)
db = sqlite3.connect(root/'omnigateway.db')
db.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('q','openai','quota','oauth',1,1)")
db.execute("INSERT INTO api_keys(id,label,prefix,hash,created_at) VALUES('k','k','p','h',1)")
db.execute("INSERT INTO virtual_models VALUES('v','[]','weighted',0)")
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('settings','{}')")
db.commit()
for table in ['credentials','api_keys','virtual_models','settings']:
    cols=[r[1] for r in db.execute('pragma table_info('+table+')')]
    rows=list(db.execute('select * from '+table))
    db.execute('drop table '+table)
    db.execute('create table '+table+'('+','.join('"'+c+'"'+(' PRIMARY KEY' if c in ['id','key'] else '') for c in cols)+')')
    db.executemany('insert into '+table+' values('+','.join('?' for c in cols)+')',rows)
db.commit(); db.close(); seed=(root/'omnigateway.db').read_bytes()
cases={'truncated':'"canary_review','bare':'broken','empty':'','object':'{}','array':'[]','null':None,'integer':1,'real':1.5,'blob':b'{}','blobnum':b'1','invalidutf':b'"\xff"'}
commands=[['keys','list'],['keys','revoke','k','--yes'],['keys','smart-routing','k','--on'],['keys','limits','k','--set','requests:1h=1'],['keys','expiry','k','--never'],['keys','models','k','--all'],['keys','guardrail','k','--clear'],['models','list'],['models','show','v'],['models','rm','v','--yes'],['models','put','v','-f',str(base/'model.json')],['models','put','v','--from-catalog','openai:gpt-4o'],['setup','claude'],['setup','opencode','--dir',str(base)],['status'],['status','--json'],['settings','get'],['keys','limits','k'],['models','put','v','--from-catalog','kimi:k3']]
(base/'model.json').write_text(json.dumps(dict(id='v',targets=[dict(provider='openai',model='gpt-4o',tier=1,weight=1,costPerMTok=dict(input=0,output=1),capabilities=dict(tools=True,images=False,reasoning=True))],strategy='score',isAlias=False)))
results=[]
for table,col in [('credentials','provider_data'),('api_keys','model_allowlist'),('virtual_models','targets'),('api_keys','limits'),('settings','value')]:
    for label,value in cases.items():
        for args in commands:
            pair=[]
            for cmd in cmds:
                (root/'omnigateway.db').write_bytes(seed)
                d=sqlite3.connect(root/'omnigateway.db')
                d.execute('update '+table+' set '+col+('=cast(? as text)' if label=='invalidutf' else '=?'),[value])
                d.commit(); d.close()
                p=subprocess.run(cmd+['--root',str(root)]+args,env=env,capture_output=True,timeout=20)
                pair.append(dict(code=p.returncode,out=p.stdout.hex(),err=p.stderr.hex()))
            results.append(dict(table=table,column=col,cell=label,args=args,ts=pair[0],rust=pair[1],equal=pair[0]==pair[1]))
(base/'results.json').write_text(json.dumps(results,indent=2))
print('evidence',base)
print('pairs',len(results),'equal',sum(r['equal'] for r in results),'different',sum(not r['equal'] for r in results))
for key in ['cell','column']:
    print(key,json.dumps(dict(collections.Counter(r[key] for r in results if not r['equal']))))
counts=collections.Counter('exit '+str(r['ts']['code']) for r in results)
print('EXIT HISTOGRAM stored-cells',json.dumps(counts))
assert counts == json.loads((repo/'conformance/cli/exit-histograms.json').read_text())['stored-cells']
assert all(r['equal'] for r in results), 'stored cell differences'
