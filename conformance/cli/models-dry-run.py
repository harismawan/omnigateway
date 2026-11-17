"""A12 local DB dry-run stdout/stderr/exit differential (rankedAt validated)."""
import driver_env
import itertools, json, os, pathlib, shutil, subprocess, tempfile, time

scratch = pathlib.Path('/tmp/opencode/a12/cli')
scratch.mkdir(parents=True, exist_ok=True)
work = pathlib.Path(tempfile.mkdtemp(dir=scratch))
home = work/'home'
home.mkdir()
env = dict(PATH=os.environ['PATH'], HOME=str(home), XDG_STATE_HOME=str(home/'state'),
           XDG_CONFIG_HOME=str(home/'config'), OMNI_ENCRYPTION_KEY='a12-private-synthetic-key-long-enough', NO_COLOR='1', BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
commands = [['bun','--no-env-file',str(pathlib.Path.cwd()/'apps/cli/src/index.ts')], [os.environ['OMNI_CLI_BIN']]]
# Reuse the exact HTTP matrix's identical seeded DB, not either gateway's modified copy.
seeds = sorted(pathlib.Path('/tmp/opencode/a12/http').glob('run-*/seed.db'), key=lambda p:p.stat().st_mtime)
seed = seeds[-1].read_bytes()
cases = []
for model in ['score','priority','weighted','roundRobin','gpt-4.1','unknown']:
    for bits in itertools.product([False,True], repeat=3):
        for js in [False,True]:
            cases.append(['models','dry-run',model]+[f'--{f}' for f,b in zip(['tools','images','reasoning'],bits) if b]+(['--json'] if js else []))
cases += [['models','dry-run'],['models','dry-run','--json'],['models','dry-run','score','--tools=false'],['models','dry-run','score','--wat']]
rows=[]
for args in cases:
    pair=[]
    for command in commands:
        (home/'omnigateway.db').write_bytes(seed)
        p=subprocess.run(command+['--root',str(home)]+args,env=env,capture_output=True,timeout=30)
        out=p.stdout.decode(); err=p.stderr.decode()
        if '--json' in args and p.returncode==0:
            body=json.loads(out)
            assert abs(body['rankedAt']-time.time()*1000)<120000
            body['rankedAt']='<now>'
            out=json.dumps(body,ensure_ascii=False)
        pair.append(dict(code=p.returncode,out=out,err=err))
    rows.append(dict(args=args,pair=pair,equal=pair[0]==pair[1]))
(work/'rows.json').write_text(json.dumps(rows,indent=2))
failures=[r for r in rows if not r['equal']]
print(json.dumps(dict(cases=len(rows),failures=len(failures),work=str(work))))
raise SystemExit(bool(failures))
