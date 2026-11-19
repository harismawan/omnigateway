#!/usr/bin/env python3
"""E4 ordinary-flow corpus. Run ONLY inside an unshare -Urn network namespace.

Usage: service.py <standalone-cli> <combined-gateway> <frozen-cli-index.ts>
All subprocess cwd/HOME/state/env files are private; systemctl is a recording stub.
"""
import json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time

cli, gateway, oracle = map(lambda p: str(pathlib.Path(p).resolve()), sys.argv[1:])
base = pathlib.Path(tempfile.mkdtemp(prefix='service-', dir='/tmp/opencode/e4'))
env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(base/'home'), 'TMPDIR': str(base), 'XDG_STATE_HOME': str(base/'state'), 'NO_COLOR': '1'}
root=base/'root'; root.mkdir(); pathlib.Path(env['HOME']).mkdir()
(root/'.env').write_text('OMNI_ENCRYPTION_KEY='+'a'*64+'\nOMNI_HOST=127.0.0.1\nOMNI_PORT=19034\n')
records=[]
def run(binary, args, code=0):
    command = [binary, *args] if binary != oracle else [shutil.which('bun'), '--no-env-file', oracle, *args]
    p=subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=25)
    records.append({'argv':command,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr})
    assert p.returncode==code,(command,p.returncode,p.stdout,p.stderr)
    return p
def both(args,code=0):
    a=run(cli,args,code); b=run(oracle,args,code)
    assert (a.stdout,a.stderr)==(b.stdout,b.stderr),(args,a,b)
    return a
try:
    both(['stop','--system'],2); both(['restart','--system'],2)
    both(['stop','--json']); both(['service','uninstall','--yes','--json'])
    stale=base/'state/omnigateway/gateway.pid';stale.parent.mkdir(parents=True,exist_ok=True);stale.write_text('2147483647\n')
    both(['stop','--json']);assert not stale.exists()
    both(['service','uninstall'],1)
    for answer,expected in [('n',1),('yes',0)]:
        master,slave=os.openpty()
        p=subprocess.Popen([cli,'service','uninstall','--json'],cwd=root,env=env,stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        os.close(slave);os.write(master,(answer+'\n').encode())
        out,err=p.communicate(timeout=10);os.close(master)
        records.append({'tty_answer':answer,'exit':p.returncode,'stdout':out,'stderr':err})
        assert p.returncode==expected and '[y/N]' in err
        if expected: assert err.endswith('cancelled\n')
    both(['start','--help']); both(['doctor','--help'])
    fresh=run(cli,['doctor','--json']); d=json.loads(fresh.stdout)
    assert d['rootSource']=='cwd' and d['usageRollup'] is None and d['plugins'] == []
    assert 'a'*64 not in fresh.stdout and d['warnings']
    frozen=json.loads(run(oracle,['doctor','--json']).stdout)
    for key in ['root','rootSource','envFile','databasePath','databaseExists','encryptionKey','configError','usageRollup','unitInstalled','supervisor','running','consoleSource','danglingPins','missingProviders','danglingCredentials','guardrail','smartRouter']:
        assert d[key]==frozen[key],(key,d[key],frozen[key])
    plugin=root/'plugins/test';plugin.mkdir(parents=True)
    (plugin/'omni-plugin.json').write_text(json.dumps({'id':'test','name':'Test','version':'1.0.0','api':3,'capabilities':[],'server':'index.js'}))
    marker=base/'executed-plugin'
    (plugin/'index.js').write_text('require("fs").writeFileSync('+json.dumps(str(marker))+',"bad")')
    metadata=json.loads(run(cli,['doctor','--json']).stdout)
    assert metadata['plugins'][0]['id']=='test' and metadata['plugins'][0]['loadable'] is False
    assert metadata['orphanPluginTables'] is None and not marker.exists()
    # root file wins ambient settings; explicit root suppresses ambient DB.
    env['OMNI_DB_PATH']='ambient.db'
    warned=json.loads(run(cli,['doctor','--root',str(root),'--json']).stdout)
    assert warned['databasePath']==str(root/'omnigateway.db') and any('ignoring OMNI_DB_PATH=ambient.db' in w for w in warned['warnings'])
    del env['OMNI_DB_PATH']
    # Release archive identity, with omni -> omnigateway; standalone companion too.
    release=base/'release'; release.mkdir()
    shutil.copy2(gateway,release/'omnigateway'); (release/'omni').symlink_to('omnigateway')
    release_cli=str(release/'omni')
    d=json.loads(run(release_cli,['doctor','--json']).stdout)
    assert d['gatewayEntrypoint']==str(release/'omnigateway')
    # Injected supervisor; never invoke host systemctl.
    stub=base/'bin'; stub.mkdir(); calls=base/'calls'
    (stub/'systemctl').write_text('#!/bin/sh\necho "$*" >> "'+str(calls)+'"\ncase "$*" in *is-active*) echo active;; *MainPID*) echo 0;; esac\nexit 0\n')
    (stub/'systemctl').chmod(0o755); env['PATH']=str(stub)+':'+env['PATH']
    installed=json.loads(run(release_cli,['service','install','--enable','--json']).stdout)
    unit=pathlib.Path(installed['path']); text=unit.read_text()
    assert 'ExecStart='+str(release/'omnigateway') in text
    assert 'EnvironmentFile='+str(root/'.env') in text and 'Restart=on-failure' in text
    assert installed['reloaded'] and installed['enabled']
    run(release_cli,['service','install'],1)
    original_stub=(stub/'systemctl').read_text()
    (stub/'systemctl').write_text(original_stub.replace('exit 0','exit 1'))
    failed_reload=json.loads(run(release_cli,['service','install','--force','--enable','--json']).stdout)
    assert failed_reload['reloaded'] is False and failed_reload['enabled'] is False
    (stub/'systemctl').write_text(original_stub)
    run(release_cli,['service','install','--force','--json'])
    supervised=subprocess.Popen([str(release/'omnigateway')],cwd=root,env=env|{'OMNI_ENCRYPTION_KEY':'a'*64,'OMNI_HOST':'127.0.0.1','OMNI_PORT':'19034'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        systemd=json.loads(run(release_cli,['start','--json']).stdout)
        assert systemd=={'supervisor':'systemd','pid':None,'healthy':True}
        assert not (base/'state/omnigateway/gateway.pid').exists()
        before=len(calls.read_text())
        restarted=json.loads(run(release_cli,['restart','--json']).stdout)
        assert restarted==systemd
        actions=[s for s in calls.read_text()[before:].splitlines() if s in ['--user stop omnigateway.service','--user start omnigateway.service']]
        assert actions==['--user stop omnigateway.service','--user start omnigateway.service']
    finally:
        supervised.terminate(); assert supervised.wait(timeout=10)==0
    both(['stop','--json'])
    # Frozen install has a TS ExecStart: compare policy, not executable spelling.
    run(release_cli,['service','uninstall','--yes','--json'])
    assert not unit.exists() and 'disable --now omnigateway.service' in calls.read_text()
    # Selected-root environment handed to children, not ambient DB; --db is CLI-only.
    childdir=base/'env-child';childdir.mkdir();shutil.copy2(cli,childdir/'omni')
    child=childdir/'omnigateway';child.write_text('#!/bin/sh\nprintf "%s|%s|%s" "$PWD" "$OMNI_ENCRYPTION_KEY" "${OMNI_DB_PATH-unset}"\n');child.chmod(0o755)
    env['OMNI_DB_PATH']='ambient.db'
    observed=run(str(childdir/'omni'),['start','--foreground','--root',str(root)])
    assert observed.stdout==str(root)+'|'+'a'*64+'|unset'
    observed=run(str(childdir/'omni'),['start','--foreground','--root',str(root),'--db','cli-only.db'])
    assert observed.stdout.endswith('|ambient.db')
    del env['OMNI_DB_PATH']
    # Actual isolated gateway process: resolved root .env is the only source of key/port.
    started=json.loads(run(release_cli,['start','--json']).stdout)
    assert started['healthy'] and started['supervisor']=='pidfile'
    reused=json.loads(run(release_cli,['start','--json']).stdout); assert reused['pid']==started['pid']
    run(cli,['db','restore','anything'],1)
    restarted=json.loads(run(release_cli,['restart','--json']).stdout)
    assert restarted['healthy'] and restarted['pid']!=started['pid']
    doctor=json.loads(run(release_cli,['doctor','--json']).stdout)
    assert doctor['usageRollup']=='ok (0 hourly buckets)' and doctor['danglingPins']==[] and doctor['guardrail']['keysWithPolicy']==0
    # Audit is report-only and orphaned rollup buckets count as disagreements.
    import sqlite3
    with sqlite3.connect(root/'omnigateway.db') as db:
        db.execute("INSERT INTO usage_rollup(api_key_id,hour,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ('orphan',1,2,0,0,0,0,0)")
    for binary in [release_cli,oracle,release_cli]:
        audit=json.loads(run(binary,['doctor','--json']).stdout)
        assert audit['usageRollup']=='1 of 0 hourly buckets disagree with request_logs'
    with sqlite3.connect(root/'omnigateway.db') as db:
        db.execute("INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES ('c','custom','private','apiKey','{\"endpointId\":\"one\"}',0,0)")
        target={'provider':'custom','model':'local','endpointId':'two','credentialId':'c','tier':1,'weight':1,'costPerMTok':{'input':0,'output':0},'capabilities':{'tools':True,'images':True,'reasoning':True}}
        db.execute("INSERT INTO virtual_models(id,targets,strategy,is_alias) VALUES ('pin',?,'score',0)",[json.dumps([target])])
    for binary in [release_cli,oracle]:
        diagnostic=json.loads(run(binary,['doctor','--json']).stdout)
        assert diagnostic['danglingPins']==['pin/local → c']
    run(release_cli,['stop','--json']); both(['stop','--json'])
    # Foreground ownership on a real gateway: signals only our child, no synthetic JSON.
    p=subprocess.Popen([release_cli,'start','--foreground','--json'],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    import urllib.request
    for attempt in range(100):
        try:
            with urllib.request.urlopen('http://127.0.0.1:19034/health',timeout=0.2) as response:
                if response.status==200: break
        except OSError: time.sleep(0.1)
    else: raise AssertionError('foreground did not become ready')
    children=pathlib.Path(f'/proc/{p.pid}/task/{p.pid}/children').read_text().split()
    assert len(children)==1,children
    os.kill(int(children[0]),signal.SIGTERM)
    out,err=p.communicate(timeout=10)
    records.append({'foreground_exit':p.returncode,'stdout':out,'stderr':err})
    assert p.returncode==0 and not out.startswith('{'),(out,err)
    assert not (base/'state/omnigateway/gateway.pid').exists()
    # Companion script for deterministic silent child exit ownership.
    standalone=base/'standalone';standalone.mkdir();shutil.copy2(cli,standalone/'omni')
    run(str(standalone/'omni'),['start','--foreground'],1)
    companion=standalone/'omnigateway';companion.write_text('#!/bin/sh\nexit 0\n');companion.chmod(0o755)
    assert run(str(standalone/'omni'),['start','--foreground','--json']).stdout==''
    companion.write_text('#!/bin/sh\nexit 7\n')
    failure=run(str(standalone/'omni'),['start','--foreground','--json'],3)
    assert failure.stdout=='' and failure.stderr=='gateway exited with code 7\n'
    # Ordinary unhealthy daemon reports success shape plus exit 3, never an error envelope.
    companion.write_text('#!/bin/sh\nexit 0\n')
    unhealthy=run(str(standalone/'omni'),['start','--json'],3)
    assert json.loads(unhealthy.stdout)['healthy'] is False
    assert unhealthy.stderr=='gateway did not become healthy\n'
    broken=base/'broken';broken.mkdir();(broken/'.env').write_text('OMNI_PORT=bad\n')
    diagnostic=json.loads(run(cli,['doctor','--root',str(broken),'--json']).stdout)
    assert diagnostic['configError'] is not None and diagnostic['usageRollup'] is None
    assert diagnostic['danglingPins'] is None and diagnostic['guardrail'] is None
    print('E4 supported service corpus passed; evidence',base)
finally:
    # Only kill pidfile processes created in this private state directory.
    pidfile=base/'state/omnigateway/gateway.pid'
    if pidfile.exists():
        try: os.kill(int(pidfile.read_text()),signal.SIGTERM)
        except ProcessLookupError: pass
    (base/'commands.json').write_text(json.dumps(records,indent=2))
