"""Independent review probe.py/quota.py malformed-row cases."""
import os, pathlib, subprocess, sqlite3, json, shutil, tempfile, hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/e1-e5/status-rows-'))
binary=pathlib.Path(os.environ['OMNI_CLI_BIN']).resolve()
commands=[[shutil.which('bun'),'--no-env-file',str(pathlib.Path.cwd()/'apps/cli/src/index.ts')],[str(binary)]]
env={**os.environ,'HOME':str(root),'XDG_STATE_HOME':str(root/'state'),'OMNI_ENCRYPTION_KEY':'password-golden-secret'}
(root/'manifest.json').write_text(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(),'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}))
subprocess.run(commands[0]+['--root',str(root),'status','--json'],env=env,capture_output=True,check=True)
db=sqlite3.connect(root/'omnigateway.db')
db.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES ('q','openai','quota','oauth',1,1)")
for bad in [True,False]:
    db.execute("UPDATE credentials SET provider_data=?",['{' if bad else '{}'])
    db.execute('DELETE FROM quota_windows')
    if not bad: db.execute("INSERT INTO quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at) VALUES ('q','fiveHour',0,'bad',100,1,1)")
    db.commit()
    before=list(db.iterdump()); results=[]
    for cmd in commands:
        p=subprocess.run(cmd+['--root',str(root),'status','--json'],env=env,capture_output=True)
        results.append((p.returncode,p.stdout,p.stderr))
        assert list(db.iterdump())==before
        if bad:
            assert p.returncode==1 and p.stdout==b'' and p.stderr==b"JSON Parse error: Expected '}'\n",results
        else:
            assert p.returncode==0 and p.stderr==b'',results
            assert json.loads(p.stdout)['credentials'][0]['quota'][0]['used']=='bad'
    assert results[0]==results[1]
print(f'PASS 2 malformed status row/whole-DB comparisons ({root})')
