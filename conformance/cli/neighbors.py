from pathlib import Path
import os,subprocess,sqlite3,json,hashlib,collections
import tempfile, time, typed_state
import driver_env
L=Path(tempfile.mkdtemp(prefix='/tmp/opencode/cli-fix5/neighbors-'));base=L/'fixture';base.mkdir();root=base/'root';root.mkdir()
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
for t,c in [('virtual_models','id'),('virtual_models','strategy'),('virtual_models','is_alias'),('api_keys','id'),('api_keys','label'),('api_keys','prefix'),('api_keys','expires_at'),('credentials','id'),('credentials','label'),('credentials','tier'),('credentials','weight'),('credentials','expires_at'),('credentials','account_email'),('credentials','disabled_reason')]:
 for v in ['NULL','1','1.0',"X'80ff'"]:
  cases.append(('other',f'UPDATE {t} SET {c}={v}',reads+writes))
for t,c in [('credentials','provider_data'),('virtual_models','targets'),('api_keys','model_allowlist')]:
 for v in ['1e999','-1e999','-0.0','1e21','1e-7','9007199254740993','9223372036854775807','-9223372036854775808',"X''","X'80'","X'3132'","X'00'","CAST(X'7b2278223a22ff227d' AS TEXT)"]:
  cases.append(('numeric-blob',f'UPDATE {t} SET {c}={v}',reads+writes))
for value in ['[null]','[1,true,"x"]','[{"provider":1,"model":{},"tier":"x","weight":[]}]','"😀"','"\\ud800"','[{},{}]','['+','.join(['null']*1024)+']']:
 cases.append(('nested',"UPDATE virtual_models SET targets='"+value+"'",reads+writes))
for pos in ['a','q','z']:
 sql="DELETE FROM credentials; INSERT INTO credentials(id,provider,label,auth_type,provider_data,tier,enabled) VALUES('a','openai','a','oauth','{}',1,1),('q','openai','q','oauth','{}',1,1),('z','openai','z','oauth','{}',1,1); UPDATE credentials SET provider_data='broken' WHERE id='"+pos+"'"
 cases.append(('order',sql,[['setup','claude'],['setup','opencode','--dir',str(base)],['status']]))
 cases.append(('order',sql+"; UPDATE virtual_models SET targets='truncated'",[['setup','claude'],['setup','opencode','--dir',str(base)]]))
# Additional identity and multi-row probes inserted before results loop.
cases += [('identity',"UPDATE virtual_models SET id=1",[['models','show','1'],['models','rm','1','--yes']]),('alias',"UPDATE virtual_models SET is_alias=1.0",[['models','list'],['models','show','v']])]
for raw in ['broken','"cut','', '{}','[]','null','1','true','[null]','"\\ud800"']:
 sql="UPDATE credentials SET provider_data='"+raw+"'"
 cases.append(('setup-cells',sql,[['setup','claude'],['setup','opencode','--dir',str(base)],['status']]))
for sql in ["INSERT INTO virtual_models VALUES('a','broken','score',0); UPDATE virtual_models SET targets='cut' WHERE id='v'", "INSERT INTO virtual_models VALUES('z','broken','score',0); UPDATE virtual_models SET targets='cut' WHERE id='v'", "UPDATE credentials SET tier=1; INSERT INTO credentials(id,provider,label,auth_type,provider_data,tier,enabled) VALUES('a','openai','a','oauth','broken',1,1); UPDATE credentials SET provider_data='cut' WHERE id='q'"]:
 cases.append(('multirow',sql,[['setup','claude'],['status'],['models','list'],['models','put','v','-f',str(base/'model.json')]]))

cases.append(('extra-commands',"UPDATE credentials SET provider_data='broken'; UPDATE api_keys SET model_allowlist='broken'",[['keys','create'],['keys','show','k'],['keys','guardrail','k','--clear'],['settings','set','maxAttempts','3'],['credentials','set','q','--label','new'],['credentials','disable','q']]))
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
    after=(root/'omnigateway.db').read_bytes();d=sqlite3.connect(root/'omnigateway.db');d.text_factory=lambda b:b.decode('utf-8','backslashreplace');dump='\n'.join(d.iterdump());d.close()
    pair.append(dict(code=p.returncode,out=p.stdout.hex(),err=p.stderr.hex(),db_sha=hashlib.sha256(after).hexdigest(),unchanged=before==after,dump=dump,types=typed_state.snapshot(root/'omnigateway.db'),started=started,ended=ended))
   typed_state.no_panic(pair[1])
   equal=all(pair[0][k]==pair[1][k] for k in ['code','out','err']);results.append(dict(cls=cls,sql=sql,args=args+jf,ts=pair[0],rust=pair[1],equal=equal,db_equal=pair[0]['db_sha']==pair[1]['db_sha']))
(L/'neighbors.json').write_text(json.dumps(results,indent=2));print(len(results),sum(x['equal'] for x in results));print(collections.Counter(x['cls'] for x in results if not x['equal']))

# SQL dumps remove physical SQLite layout differences. Successful revoke
# timestamps are asserted as wall-clock instants, then compared as that class.
# Creation outputs/state contain independent random keys; these two cases and
# four unimplemented credential edits are explicit asserted exclusions.
import re, time
excluded=collections.Counter()
failures=[]
for r in results:
    args=r['args']
    if args[:2]==['keys','create']:
        assert r['ts']['code']==r['rust']['code']==0
        excluded['random-create']+=1
        continue
    if args[:2] in [['credentials','set'],['credentials','disable']]:
        assert r['rust']['code'] != 0
        excluded['unimplemented-credentials']+=1
        continue
    if not r['equal'] or not typed_state.equal([r['ts'],r['rust']],args): failures.append(r)
assert excluded=={'random-create':2,'unimplemented-credentials':4}, excluded
hist=collections.Counter('exit '+str(r['ts']['code']) for r in results)
print('evidence',L,'pairs',len(results),'failing',len(failures),'excluded',dict(excluded))
print('EXIT HISTOGRAM neighbors',json.dumps(hist))
(L/'failures.json').write_text(json.dumps(failures,indent=2))
assert hist==json.loads((repo/'conformance/cli/exit-histograms.json').read_text())['neighbors']
assert not failures, f'{len(failures)} deterministic parity mismatches'
