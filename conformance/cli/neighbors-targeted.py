from pathlib import Path
s=Path('conformance/cli/neighbors.py').read_text().split('cases=[]')[0]
exec(s)
tests=[("UPDATE virtual_models SET id=1",['models','list','--json']), ("UPDATE virtual_models SET id=1",['models','show','1','--json']), ("UPDATE virtual_models SET is_alias=1.0",['models','list','--json']), ("UPDATE virtual_models SET strategy=NULL",['models','list','--json']), ("UPDATE virtual_models SET targets='[null]'",['setup','claude']), ("UPDATE api_keys SET label=1",['keys','list','--json']), ("UPDATE virtual_models SET targets='[null]'",['models','put','v','-f',str(base/'model.json')]), ("UPDATE virtual_models SET id=1",['models','rm','1','--yes'])]
rs=[]
for sql,args in tests:
 pair=[]
 for cmd in cmds:
  (root/'omnigateway.db').write_bytes(seed);d=sqlite3.connect(root/'omnigateway.db');d.executescript(sql);d.commit();d.close();before=(root/'omnigateway.db').read_bytes()
  p=subprocess.run(cmd+['--root',str(root)]+args,env=env,capture_output=True);after=(root/'omnigateway.db').read_bytes()
  pair.append(dict(code=p.returncode,out=p.stdout.hex(),err=p.stderr.hex(),unchanged=before==after))
 rs.append(dict(sql=sql,args=args,ts=pair[0],rust=pair[1]));print(json.dumps(rs[-1]))
(L/'targeted.json').write_text(json.dumps(rs,indent=2))
assert all(r['ts']==r['rust'] for r in rs)
