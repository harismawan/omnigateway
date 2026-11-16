"""Raw status quota cells; human arithmetic differences remain explicitly counted."""
from pathlib import Path
import collections, hashlib, json, os, sqlite3, subprocess, tempfile
import driver_env, typed_state

repo = Path.cwd()
scratch = Path('/tmp/opencode/cli-fix6')
scratch.mkdir(exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix='r6-quota-', dir=scratch))
home = evidence / 'home'
root = home / 'root'
root.mkdir(parents=True)
env = dict(PATH=os.environ['PATH'], HOME=str(home), XDG_STATE_HOME=str(home/'state'),
           OMNI_ENCRYPTION_KEY='review-secret-long-enough', NO_COLOR='1',
           BUN_RUNTIME_TRANSPILER_CACHE_PATH='0')
commands = [['bun', '--no-env-file', str(repo/'apps/cli/src/index.ts')], [os.environ['OMNI_CLI_BIN']]]
subprocess.run(commands[0]+['--root', str(root), 'status', '--json'], env=env, capture_output=True, check=True)
db = root/'omnigateway.db'
with sqlite3.connect(db) as d:
    d.execute("INSERT INTO credentials(id,provider,label,auth_type,created_at,updated_at) VALUES('q','openai','quota','oauth',1,1)")
    cols = [r[1] for r in d.execute('pragma table_info(credentials)')]
    rows = list(d.execute('SELECT * FROM credentials'))
    d.execute('DROP TABLE credentials')
    d.execute('CREATE TABLE credentials('+','.join('"'+c+'"' for c in cols)+')')
    d.executemany('INSERT INTO credentials VALUES('+','.join('?' for c in cols)+')', rows)
    d.execute('DROP TABLE quota_windows')
    d.execute('CREATE TABLE quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms)')
    d.execute("INSERT INTO quota_windows VALUES('q','fiveHour',0,1,10,NULL,0,NULL)")
seed = db.read_bytes()
columns = ['window_type', 'starts_at', 'used', 'limit_value', 'resets_at', 'observed_at', 'window_ms']
values = ["X''", "X'0102'", "X'ff'", '2', '1.5', '-0.0', '1e308', '1e999', '-1e999', "'1'", "''", "'雪'", 'NULL']
accepted = {(c, v) for c in ['window_type', 'starts_at', 'used'] for v in values}
accepted.update(('limit_value', v) for v in ["X'ff'", '2', '1.5', '1e308', '1e999', "'1'"])
results = []
cases = [(f'UPDATE quota_windows SET "{c}"={v}', (c, v) in accepted) for c in columns for v in values]
for credential, quota in [("X'71'", "X'71'"), ("X''", "X''"), ("X'0102'", "X'0102'"),
                          ('1', "'1'"), ('1.0', '1'), ('NULL', 'NULL'), ("'q'", "'q'")]:
    cases.append((f'UPDATE credentials SET id={credential}; UPDATE quota_windows SET credential_id={quota}', False))
for sql, human_difference in cases:
        for args in [['status', '--json'], ['status']]:
            pair = []
            for command in commands:
                db.write_bytes(seed)
                with sqlite3.connect(db) as d:
                    d.executescript(sql)
                before = db.read_bytes()
                before_types = typed_state.snapshot(db)
                p = subprocess.run(command+['--root', str(root)]+args, env=env, capture_output=True, timeout=20)
                result = dict(code=p.returncode, out=p.stdout.hex(), err=p.stderr.hex(),
                              types=typed_state.snapshot(db), unchanged=before == db.read_bytes(),
                              db_sha=hashlib.sha256(db.read_bytes()).hexdigest())
                typed_state.no_panic(result)
                assert result['types'] == before_types and result['unchanged'], result
                pair.append(result)
            equal = all(pair[0][k] == pair[1][k] for k in ['code', 'out', 'err'])
            if args == ['status']:
                assert equal == (not human_difference), (sql, pair)
            results.append(dict(sql=sql, args=args, ts=pair[0], rust=pair[1], equal=equal,
                                cls='human-quota' if args == ['status'] and not equal else 'equal' if equal else 'quota-json',
                                db_equal=typed_state.equal(pair, args)))
(evidence/'quota.json').write_text(json.dumps(results, indent=2))
hist = collections.Counter('exit '+str(r['ts']['code']) for r in results)
classes = collections.Counter(r['cls'] for r in results)
failures = [r for r in results if not r['db_equal'] or r['cls'] == 'quota-json']
(evidence/'failures.json').write_text(json.dumps(failures, indent=2))
print('evidence', evidence, 'pairs', len(results), 'classes', dict(classes), 'failing', len(failures))
print('EXIT HISTOGRAM quota-json', json.dumps(hist))
assert hist == json.loads((repo/'conformance/cli/exit-histograms.json').read_text())['quota-json']
assert classes['human-quota'] == 45, classes
assert not failures, f'{len(failures)} deterministic parity mismatches'
