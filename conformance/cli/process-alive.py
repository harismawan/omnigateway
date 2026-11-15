"""Review part2/probe.py no-kill regression plus PID/systemctl boundaries."""
import os, pathlib, subprocess, json, shutil, tempfile, hashlib
import driver_env

root = pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/e1-e5/process-'))
repo = pathlib.Path.cwd()
binary = pathlib.Path(os.environ['OMNI_CLI_BIN']).resolve()
commands = [[shutil.which('bun'), '--no-env-file', str(repo/'apps/cli/src/index.ts')], [str(binary)]]
(root/'manifest.json').write_text(json.dumps({'commit': subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(), 'binary': str(binary), 'sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}))
state = root/'state/omnigateway'
state.mkdir(parents=True)
pidfile = state/'gateway.pid'
env = {**os.environ, 'HOME':str(root), 'XDG_STATE_HOME':str(root/'state'), 'PATH':'/nonexistent', 'OMNI_ENCRYPTION_KEY':'password-golden-secret'}
count = 0
for value, running, retained in [(str(os.getpid()),True,True), ('2147483647',False,False), ('1',False,False), ('0',False,True), ('-1',False,True), ('abc',False,True), ('1e100',False,False), ('4294967296',False,False)]:
    # PID1 belongs to root; this unprivileged runner must observe EPERM.
    if value == '1':
        try: os.kill(1,0)
        except PermissionError: pass
        else: raise AssertionError('EPERM fixture requires inaccessible PID1')
    results=[]
    for cmd in commands:
        pidfile.write_text(value)
        p=subprocess.run(cmd+['--root',str(root),'status','--json'],env=env,capture_output=True)
        result=(p.returncode,p.stdout,p.stderr,pidfile.exists())
        results.append(result)
        assert p.returncode == 0, result
        data=json.loads(p.stdout)
        assert data['storeError'] is None, data
        assert data['process']['running'] == running, (value,result)
        assert pidfile.exists() == retained, (value,result)
    assert results[0] == results[1], (value,results)
    count+=1
unit=root/'.config/systemd/user/omnigateway.service'
unit.parent.mkdir(parents=True)
unit.write_text('fixture')
for script, expected in [(None, None), ('#!/bin/sh\necho failed >&2\nexit 3\n', 'failed'), ('#!/bin/sh\nexit 1\n', 'unknown'), ('#!/bin/sh\necho surprising\nexit 7\n', 'surprising')]:
    bindir=root/'bin'
    bindir.mkdir(exist_ok=True)
    if script is not None:
        exe=bindir/'systemctl'; exe.write_text(script); exe.chmod(0o755)
    results=[]
    for cmd in commands:
        p=subprocess.run(cmd+['--root',str(root),'status','--json'],env={**env,'PATH':str(bindir)},capture_output=True)
        results.append((p.returncode,p.stdout,p.stderr))
    assert results[0] == results[1], results
    assert results[0][0] == (1 if script is None else 0)
    if script is not None: assert json.loads(results[0][1])['storeError'] is None
    if expected is None:
        assert results[0][1] == b''
        assert results[0][2] == b'Executable not found in $PATH: "systemctl"\n'
    else:
        process=json.loads(results[0][1])['process']
        assert process['supervisor'] == 'systemd'
        assert process['state'] == expected
        assert process['running'] is False
        assert process['pid'] is None
    count+=1
print(f'PASS {count} process/PID/EPERM/systemctl comparisons ({root})')
trace=root/'systemctl-args'
exe.write_text('#!/bin/sh\nprintf "%s|%s\\n" "$*" "$INHERITED_SENTINEL" >> "$TRACE"\ncase "$*" in *is-active*) echo active;; *show*) echo 123;; esac\n')
for cmd in commands:
    trace.unlink(missing_ok=True)
    p=subprocess.run(cmd+['--root',str(root),'status','--json'],env={**env,'PATH':str(bindir),'TRACE':str(trace),'INHERITED_SENTINEL':'present'},capture_output=True)
    assert p.returncode == 0, p.stderr
    data=json.loads(p.stdout)
    assert data['storeError'] is None, data
    process=data['process']
    assert process['running'] is True and process['pid'] == 123
    assert trace.read_text().splitlines() == ['--user is-active omnigateway.service|present', '--user show omnigateway.service --property=MainPID --value|present']
print('PASS systemctl inherited environment and exact user arguments')
