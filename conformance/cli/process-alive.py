"""Review part2/probe.py no-kill regression plus PID/systemctl boundaries."""
import os, pathlib, subprocess, json, shutil, tempfile, hashlib

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
        assert data['process']['running'] == running, (value,result)
        assert pidfile.exists() == retained, (value,result)
    assert results[0] == results[1], (value,results)
    count+=1
unit=root/'.config/systemd/user/omnigateway.service'
unit.parent.mkdir(parents=True)
unit.write_text('fixture')
for script in [None, '#!/bin/sh\necho failed >&2\nexit 3\n', '#!/bin/sh\nexit 1\n']:
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
    count+=1
print(f'PASS {count} process/PID/EPERM/systemctl comparisons ({root})')
