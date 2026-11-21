#!/usr/bin/env python3
"""A user-scope systemctl stand-in that really runs the unit's ExecStart.

State lives in $FAKE_SYSTEMD (pid file, log, calls). Only the verbs the CLI and
the migration use exist; anything else exits 1 so a new call is noticed.
"""
import os, pathlib, signal, subprocess, sys, time

state = pathlib.Path(os.environ['FAKE_SYSTEMD'])
state.mkdir(parents=True, exist_ok=True)
args = [a for a in sys.argv[1:] if a not in ('--user', '--no-block')]
no_block = '--no-block' in sys.argv[1:]
with open(state / 'calls', 'a') as f:
    f.write(' '.join(args) + '\n')
unit = pathlib.Path(os.environ['HOME']) / '.config/systemd/user/omnigateway.service'
pidfile = state / 'pid'

def pid():
    try:
        p = int(pidfile.read_text())
        os.kill(p, 0)
        if pathlib.Path(f'/proc/{p}/stat').read_text().split(')')[-1].split()[0] == 'Z':
            return None
        return p
    except (OSError, ValueError):
        return None

def directive(key, required=True):
    text = (state / 'loaded').read_text() if (state / 'loaded').exists() else unit.read_text()
    for line in text.splitlines():
        if line.startswith(key + '='):
            return line[len(key) + 1:]
    if required:
        raise SystemExit(f'no {key}')
    return None

def start():
    if pid():
        return
    # The manager's environment, as systemd --user hands it to a service.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'FAKE_SYSTEMD', 'XDG_STATE_HOME') if k in os.environ}
    for line in pathlib.Path(directive('EnvironmentFile')).read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    log = open(state / 'service.log', 'ab')
    p = subprocess.Popen(directive('ExecStart').split(' '), cwd=directive('WorkingDirectory'),
                         env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True)
    pidfile.write_text(str(p.pid))
    (state / 'starts').open('a').write(directive('ExecStart') + '\n')
    # ExecStartPost runs once the main process is up, with MAINPID set; a
    # non-zero exit fails the unit, which systemd then stops.
    post = directive('ExecStartPost', required=False)
    if post:
        time.sleep(0.3)
        r = subprocess.run(post.split(' '), cwd=directive('WorkingDirectory'),
                           env=env | {'MAINPID': str(p.pid)}, stdin=subprocess.DEVNULL,
                           stdout=log, stderr=log)
        (state / 'posts').open('a').write(f"{post} exit={r.returncode}\n")
        if r.returncode != 0:
            stop()

def stop():
    p = pid()
    if p:
        os.killpg(p, signal.SIGTERM)
        for _ in range(100):
            if not pid():
                break
            time.sleep(0.05)
    pidfile.unlink(missing_ok=True)

verb = args[0] if args else ''
if verb == 'show':
    p = pid()
    loaded = (state / 'loaded').read_text() if (state / 'loaded').exists() else unit.read_text()
    def loaded_directive(key):
        for line in loaded.splitlines():
            if line.startswith(key + '='):
                return line[len(key) + 1:]
        return ''
    argv = loaded_directive('ExecStart')
    print(f"ActiveState={'active' if p else 'inactive'}\nUnitFileState=enabled\nMainPID={p or 0}\n"
          f"DropInPaths=\nFragmentPath={unit}\n"
          f"NeedDaemonReload={'no' if loaded == unit.read_text() else 'yes'}\nEnvironment=\n"
          f"EnvironmentFiles={loaded_directive('EnvironmentFile')} (ignore_errors=no)\n"
          f"WorkingDirectory={loaded_directive('WorkingDirectory')}\n"
          f"ExecStart={{ path={argv.split(' ')[0]} ; argv[]={argv} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }}")
elif verb == 'is-active':
    print('active' if pid() else 'inactive')
    sys.exit(0 if pid() else 3)
elif verb == 'show-environment':
    # The manager's environment: what a real `systemd --user` would hand on.
    for k in ('HOME', 'PATH', 'XDG_STATE_HOME', 'FAKE_SYSTEMD'):
        if k in os.environ:
            print(f"{k}={os.environ[k]}")
elif verb == 'daemon-reload':
    (state / 'loaded').write_text(unit.read_text())
elif verb == 'enable':
    pass
elif verb == 'start':
    start()
elif verb == 'stop':
    stop()
elif verb == 'restart':
    if no_block:
        # Queued: returns now; the job runs once this caller (perhaps the
        # unit's own main process, about to be stopped) has gone on.
        subprocess.Popen([sys.executable, __file__, 'restart'], env=os.environ,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        stop(); start()
else:
    sys.exit(1)
