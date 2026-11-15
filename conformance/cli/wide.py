from pathlib import Path
import os,subprocess,sqlite3,json,hashlib,collections
import driver_env, typed_state, tempfile, time
L=Path(tempfile.mkdtemp(prefix='/tmp/opencode/cli-fix5/wide-'));base=L/'fixture';base.mkdir();root=base/'root';root.mkdir()
repo=Path.cwd();env={'PATH':os.environ['PATH'],'HOME':str(base),'XDG_STATE_HOME':str(base/'state'),'OMNI_ENCRYPTION_KEY':'review-secret-long-enough','NO_COLOR':'1','BUN_RUNTIME_TRANSPILER_CACHE_PATH':'0'}
cmds=[['bun','--no-env-file',str(repo/'apps/cli/src/index.ts')],[os.environ['OMNI_CLI_BIN']]]
subprocess.run(cmds[0]+['--root',str(root),'status','--json'],env=env,capture_output=True,check=True)
d=sqlite3.connect(root/'omnigateway.db');d.executescript("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('q','openai','quota','oauth',1,1); INSERT INTO api_keys(id,label,prefix,hash,created_at) VALUES('k','k','p','h',1); INSERT INTO virtual_models VALUES('v','[]','weighted',0); INSERT OR REPLACE INTO settings VALUES('settings','{}');")
for t in ['credentials','api_keys','virtual_models','settings']:
 cols=[r[1] for r in d.execute('pragma table_info('+t+')')];rows=list(d.execute('select * from '+t));d.execute('drop table '+t);d.execute('create table '+t+'('+','.join('"'+c+'"'+(' PRIMARY KEY' if c in ['id','key'] else '') for c in cols)+')');d.executemany('insert into '+t+' values('+','.join('?' for c in cols)+')',rows)
d.commit();d.close();seed=(root/'omnigateway.db').read_bytes()
model=dict(id='v',targets=[dict(provider='openai',model='gpt-4o',tier=1,weight=1,costPerMTok=dict(input=0,output=1),capabilities=dict(tools=True,images=False,reasoning=True))],strategy='score',isAlias=False);(base/'model.json').write_text(json.dumps(model))
reads=[['keys','list'],['keys','limits','k'],['keys','models','k'],['keys','expiry','k'],['keys','guardrail','k'],['models','list'],['models','show','v'],['setup','claude'],['setup','opencode','--dir',str(base)],['status'],['settings','get']]
writes=[['models','put','v','-f',str(base/'model.json')],['models','rm','v','--yes'],['keys','models','k','--all'],['keys','limits','k','--set','requests:1h=1'],['keys','expiry','k','--never'],['keys','revoke','k','--yes'],['keys','smart-routing','k','--on']]
cases=[]
for t in ['api_keys','credentials','virtual_models']:
 d=sqlite3.connect(root/'omnigateway.db');cols=[r[1] for r in d.execute('pragma table_info('+t+')')];d.close()
 commands=reads+writes+[['keys','guardrail','k','--clear']]
 if t=='credentials': commands=[['status'],['setup','claude'],['models','put','v','-f',str(base/'model.json')]]
 if t=='virtual_models':commands=[['models','list'],['models','show','v'],['models','rm','v','--yes'],['setup','claude']]
 for col in cols:
  for v in ['NULL','2','1.5',"'1'","X'80ff'","CAST(X'ff' AS TEXT)"]:
   cases.append((t+':'+col,f'UPDATE {t} SET "{col}"={v}',commands))
for col in ['id','label','prefix','created_at','expires_at','revoked_at']:
 for v in ['-0.0','1e21','1e-7','9007199254740993','9223372036854775807','-9223372036854775808','1e999','-1e999',"X''","X'6b'"]:
  cases.append(('edges',f'UPDATE api_keys SET {col}={v}',[['keys','list'],['keys','expiry','k'],['keys','revoke','k','--yes']]))
for t in ['api_keys','virtual_models']:
 for v in ['1',"X'31'",'NULL']:
  sql=f'UPDATE {t} SET id={v}'
  commands=[['keys','expiry','1'],['keys','revoke','1','--yes']] if t=='api_keys' else [['models','show','1'],['models','rm','1','--yes']]
  cases.append(('lookups',sql,commands))
for raw in ['null','1','true','"x"','[]','{}','{"provider":null}','{"provider":[],"model":{}}']:
 for val in ['['+raw+',{}]','[{},'+raw+']','[{},'+raw+',{}]']:
  cases.append(('setup-shapes',"UPDATE virtual_models SET targets='"+val+"'",[['setup','claude'],['setup','opencode','--dir',str(base)]]))
for sql in ["UPDATE api_keys SET label=NULL,model_allowlist='broken'", "UPDATE api_keys SET revoked_at='x',limits='broken'", "UPDATE credentials SET provider=NULL,provider_data='broken'", "UPDATE virtual_models SET id=NULL,targets='broken'"]:
 cases.append(('two-cells',sql,reads+writes))
results=[]
for cls,sql,commands in cases:
 for args in commands:
  for jf in [[],['--json']]:
   pair=[]
   for cmd in cmds:
    (root/'omnigateway.db').write_bytes(seed);d=sqlite3.connect(root/'omnigateway.db');d.executescript(sql);d.commit();d.close();before=(root/'omnigateway.db').read_bytes()
    started=time.time()*1000
    p=subprocess.run(cmd+['--root',str(root)]+args+jf,env=env,capture_output=True,timeout=20)
    ended=time.time()*1000
    after=(root/'omnigateway.db').read_bytes();d=sqlite3.connect(root/'omnigateway.db');d.text_factory=lambda b:b.decode('utf-8','backslashreplace');dump='\n'.join(d.iterdump());types={t:[list(row) for row in d.execute('SELECT '+','.join('typeof("'+c+'"),hex("'+c+'")' for c in [v[1] for v in d.execute('pragma table_info("'+t+'")')])+' FROM "'+t+'"')] for t in ['api_keys','credentials','virtual_models','settings']};d.close()
    pair.append(dict(code=p.returncode,out=p.stdout.hex(),err=p.stderr.hex(),db_sha=hashlib.sha256(after).hexdigest(),unchanged=before==after,dump=dump,types=typed_state.snapshot(root/'omnigateway.db'),started=started,ended=ended))
   typed_state.no_panic(pair[1])
   equal=all(pair[0][k]==pair[1][k] for k in ['code','out','err']);results.append(dict(cls=cls,sql=sql,args=args+jf,ts=pair[0],rust=pair[1],equal=equal,db_equal=pair[0]['db_sha']==pair[1]['db_sha']))
(L/'wide.json').write_text(json.dumps(results,indent=2));print(len(results),sum(x['equal'] for x in results));print(collections.Counter(x['cls'] for x in results if not x['equal']))
failures=[r for r in results if not r['equal'] or not typed_state.equal([r['ts'],r['rust']],r['args'])]
hist=collections.Counter('exit '+str(r['ts']['code']) for r in results)
print('evidence',L,'pairs',len(results),'failing',len(failures))
print('EXIT HISTOGRAM wide',json.dumps(hist))
(L/'failures.json').write_text(json.dumps(failures,indent=2))
assert hist==json.loads((repo/'conformance/cli/exit-histograms.json').read_text())['wide']
assert not failures, f'{len(failures)} deterministic parity mismatches'
