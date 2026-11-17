"""Frozen credentials read commands: byte output and typed-cell parity."""
from pathlib import Path
import collections, json, os, sqlite3, subprocess, tempfile
import driver_env, typed_state

repo = Path.cwd()
scratch = Path('/tmp/opencode/e2')
scratch.mkdir(exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix='credentials-', dir=scratch))
home = evidence / 'home'
root = home / 'root'
root.mkdir(parents=True)
env = dict(PATH=os.environ['PATH'], HOME=str(home), XDG_STATE_HOME=str(home/'state'),
           OMNI_ENCRYPTION_KEY='review-secret-long-enough', NO_COLOR='1',
           BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
commands = [['bun', '--no-env-file', str(repo/'apps/cli/src/index.ts')], [os.environ['OMNI_CLI_BIN']]]
subprocess.run(commands[0]+['--root', str(root), 'credentials', 'list', '--json'],
               env=env, capture_output=True, check=True)
db = root/'omnigateway.db'
empty = db.read_bytes()
with sqlite3.connect(db) as d:
    d.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('c','openai','account','oauth',1,2)")
    d.execute("INSERT INTO credential_health VALUES('c','m','open',2,3,4)")
d.close()
seed = db.read_bytes()
cases = [('empty', empty, '', args) for args in [ ['credentials', 'list'], ['credentials', 'health'] ]]
for args in [['credentials', 'list'], ['credentials', 'show', 'c'], ['credentials', 'health'],
             ['credentials', 'health', '--all'], ['credentials', 'show', 'missing'], ['credentials', 'show']]:
    cases.append(('standard', seed, '', args))
columns = ['id', 'provider', 'label', 'auth_type', 'enabled', 'tier', 'weight', 'expires_at',
           'account_email', 'provider_data', 'disabled_reason', 'disabled_at', 'refresh_token',
           'token_version', 'created_at', 'updated_at']
values = ["X''", "X'0102'", "X'ff'", '2', '1.5', '1e999', "'1'", "''", "'雪'", 'NULL']
for col in columns:
    for value in values:
        # Relaxed tables exercise the existing X3 operator-cell coercions.
        for args in [['credentials', 'list'], ['credentials', 'show', 'c'], ['credentials', 'health']]:
            cases.append((f'{col}={value}', seed, f'UPDATE credentials SET "{col}"={value}', args))
for col in ['credential_id', 'model', 'breaker_state', 'consecutive_failures', 'opened_at', 'rate_limited_until']:
    for value in values:
        for args in [['credentials', 'health'], ['credentials', 'health', '--all']]:
            cases.append((f'health:{col}={value}', seed,
                          f'UPDATE credential_health SET "{col}"={value}', args))
for reason in values:
    for args in [['credentials', 'list'], ['credentials', 'show', 'c']]:
        cases.append((f'disabled:{reason}', seed,
                      f'UPDATE credentials SET enabled=0, disabled_reason={reason}', args))
cases.append(('unrelated invalid metadata', seed,
              "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('bad','openai','bad','oauth','invalid',1,2)",
              ['credentials', 'show', 'c']))
results = []
for name, data, sql, args in cases:
    for mode in [[], ['--json']]:
        pair = []
        for command in commands:
            db.write_bytes(data)
            if sql:
                with sqlite3.connect(db) as d:
                    cols = [r[1] for r in d.execute('pragma table_info(credentials)')]
                    rows = list(d.execute('SELECT * FROM credentials'))
                    d.execute('DROP TABLE credentials')
                    d.execute('CREATE TABLE credentials('+','.join('"'+c+'"' for c in cols)+')')
                    d.executemany('INSERT INTO credentials VALUES('+','.join('?' for c in cols)+')', rows)
                    cols = [r[1] for r in d.execute('pragma table_info(credential_health)')]
                    rows = list(d.execute('SELECT * FROM credential_health'))
                    d.execute('DROP TABLE credential_health')
                    d.execute('CREATE TABLE credential_health('+','.join('"'+c+'"' for c in cols)+')')
                    d.executemany('INSERT INTO credential_health VALUES('+','.join('?' for c in cols)+')', rows)
                    d.executescript(sql)
                d.close()
            before = typed_state.snapshot(db)
            p = subprocess.run(command+['--root', str(root)]+args+mode, env=env, capture_output=True, timeout=20)
            result = dict(code=p.returncode, out=p.stdout.hex(), err=p.stderr.hex(), types=typed_state.snapshot(db))
            typed_state.no_panic(result)
            assert before == result['types'], (name, result)
            pair.append(result)
        equal = all(pair[0][k] == pair[1][k] for k in ['code', 'out', 'err', 'types'])
        results.append(dict(name=name, args=args+mode, ts=pair[0], rust=pair[1], equal=equal))
(evidence/'results.json').write_text(json.dumps(results, indent=2))
failures = [r for r in results if not r['equal']]
(evidence/'failures.json').write_text(json.dumps(failures, indent=2))
print('evidence', evidence, 'pairs', len(results), 'equal', len(results)-len(failures), 'failing', len(failures))
print('EXIT HISTOGRAM credentials', dict(collections.Counter(r['ts']['code'] for r in results)))
assert not failures, f'{len(failures)} parity mismatches'
