"""Frozen credentials read commands: byte output and typed-cell parity."""
from pathlib import Path
import collections, json, os, sqlite3, subprocess, tempfile, time, re, select
import driver_env, typed_state

repo = Path.cwd()
scratch = Path('/tmp/opencode/e2')
scratch.mkdir(exist_ok=True)
evidence = Path(tempfile.mkdtemp(prefix='m-credentials-', dir=scratch))
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
for value in values:
    cases.append((f'closed failures:{value}', seed,
                  f"UPDATE credential_health SET breaker_state='closed', consecutive_failures={value}",
                  ['credentials', 'health']))
cases.append(('unrelated invalid metadata', seed,
              "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('bad','openai','bad','oauth','invalid',1,2)",
              ['credentials', 'show', 'c']))
mutation_args = [['credentials',op,'c'] for op in ['enable','disable','rm']]
mutation_args += [['credentials','rm','c','--yes'], ['credentials','set','c','--label','new'],
                  ['credentials','set','c','--tier','2','--weight','0.25']]
for args in mutation_args:
    cases.append(('mutation',seed,'',args))
    for col in columns + ['api_key','access_token','id_token']:
        for value in values:
            cases.append((f'mutation:{col}={value}',seed,f'UPDATE credentials SET "{col}"={value}',args))
            cases.append((f'neighbor:{col}={value}',seed,
                "INSERT INTO credentials SELECT * FROM credentials; UPDATE credentials SET id='neighbor' WHERE rowid=(SELECT max(rowid) FROM credentials); "
                f'UPDATE credentials SET "{col}"={value} WHERE id=\'neighbor\'',args))
for op in ['enable','disable','set','rm']:
    for tail in [[],['missing'],['c','--unknown'],['c','--yes=x']]:
        cases.append(('missing/flags',seed,'',['credentials',op]+tail))
for flag in ['tier','weight','label']:
    for value in ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e999','0x10','0b11','0o7','1e-300','雪']:
        cases.append(('set flag',seed,'',['credentials','set','c',f'--{flag}={value}']))
    cases.append(('missing value',seed,'',['credentials','set','c',f'--{flag}']))
for value in ['0','1',"'1'","'0'",'1.5']:
    for op in ['enable','disable']:
        cases.append(('existing enabled',seed,f'UPDATE credentials SET enabled={value}',['credentials',op,'c']))
for provider in ['anthropic','openai','kimi','kilo','grok','antigravity','muse','qoder','custom','unknown']:
    cases.append(('add',seed,'',['credentials','add-key',provider]))
    cases.append(('add label',seed,'',['credentials','add-key',provider,'--label','  chosen  ']))
custom = ['credentials','add-key','custom','--endpoint-id','ep','--endpoint-label','Endpoint','--origin','https://example.test/v1/','--protocol','chat-completions']
cases.append(('custom',seed,'',custom))
for data in ['{}','null','[]','1','"x"','invalid', '{"endpointId":"ep","endpointLabel":"Endpoint","origin":"https://example.test","basePath":"/v1","protocol":"chat_completions"}', '{"endpointId":"ep","endpointLabel":"Endpoint","origin":"https://example.test","protocol":"responses"}']:
    sql = "INSERT INTO credentials(id,provider,label,auth_type,provider_data,created_at,updated_at) VALUES('old','custom','old','apiKey'," + "'"+data+"',1,2)"
    for args in [custom, ['credentials','add-key','custom','--endpoint-id',' ep ']]:
        cases.append(('custom reuse',seed,sql,args))
for tail in [[],['openai','--key','secret'],['openai','--origin'],['openai','--protocol=-bad']]:
    cases.append(('add malformed',seed,'',['credentials','add-key']+tail))
for answer in [b'y\n', b'no\n', b'YES\n']:
    cases.append(('tty:'+answer.hex(),seed,'',['credentials','rm','c']))
cases.append(('tty-key',seed,'',['credentials','add-key','openai']))
for answer in [b'',b' \n',b'one\ntwo\n',b'\xff']:
    cases.append(('stdin:'+answer.hex(),seed,'',['credentials','add-key','openai']))
for flag in ['endpoint-id','endpoint-label','origin','protocol']:
    for value in ['', ' ', 'bad', 'https://u:p@example.test', 'https://example.test?q=1','responses']:
        args = custom.copy(); args[args.index('--'+flag)+1] = value
        cases.append(('custom validation',seed,'',args))
for sql in ["", "INSERT INTO virtual_models(id,targets,strategy,is_alias) VALUES('pin','[{\"provider\":\"openai\",\"model\":\"m\",\"credentialId\":\"c\"}]','score',0)"]:
    for yes in [[],['--yes']]: cases.append(('pinned',seed,sql,['credentials','rm','c']+yes))

def normalize(result, args, started, ended, expected_key):
    # Only successful target clocks and new-row UUID/ciphertext (including nonce/tag)
    # vary. Validate clocks, decrypt secret, and retain each cell's SQLite type.
    if result['code'] != 0 or args[:1] != ['credentials']: return
    op = args[1]
    if op not in ['enable','disable','set','add-key']: return
    with sqlite3.connect(db) as conn:
        ids = [r[0] for r in conn.execute('SELECT id FROM credentials')]
    new_id = next((i for i in ids if i not in ['c','old']),None) if op == 'add-key' else None
    for row in result['types']['credentials']:
        target = row['id'] == ('text',(new_id if op == 'add-key' else args[2]).encode().hex().upper())
        if not target: continue
        for col in (['created_at','updated_at'] if op == 'add-key' else ['updated_at'] + (['disabled_at'] if op == 'disable' else [])):
            cell = row[col]; assert cell[0] == 'integer', cell
            assert started-1000 <= int(bytes.fromhex(cell[1])) <= ended+1000, cell
            row[col] = (cell[0],'<clock>')
        if op == 'add-key':
            assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',new_id)
            cell = row['api_key']; assert cell[0] == 'text'
            script = f'import {{deriveKey,decrypt}} from {json.dumps(str(repo/"packages/store/src/encryption.ts"))}; console.log(await decrypt(await deriveKey(process.env.OMNI_ENCRYPTION_KEY),process.argv[1]));'
            p = subprocess.run(['bun','--no-env-file','-e',script,bytes.fromhex(cell[1]).decode()],env=env,capture_output=True,check=True)
            assert p.stdout == expected_key+b'\n',(p.stdout,expected_key)
            row['api_key'] = (cell[0],'<encrypted:'+expected_key.hex()+'>')
            row['id'] = ('text','<uuid>')
    if new_id:
        result['out'] = bytes.fromhex(result['out']).replace(new_id.encode(),b'<uuid>').hex()

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
            started = time.time()*1000
            argv = command+['--root', str(root)]+args+mode
            answer = bytes.fromhex(name[6:]) if name.startswith('stdin:') else b'  test-key\n'
            if name.startswith('tty'):
                master, slave = os.openpty()
                p = subprocess.Popen(argv,env=env,stdin=slave,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                err = b''
                while b' [y/N] ' not in err and b' API key: ' not in err:
                    assert select.select([p.stderr],[],[],20)[0], 'prompt timeout'
                    chunk = os.read(p.stderr.fileno(),65536)
                    if not chunk: break
                    err += chunk
                os.write(master,bytes.fromhex(name[4:]) if name.startswith('tty:') else b'  test-key\r')
                out, rest = p.communicate(timeout=20)
                p.stdout, p.stderr = out, err+rest
                os.close(master); os.close(slave)
            else:
                p = subprocess.run(argv, env=env, input=answer, capture_output=True, timeout=20)
            ended = time.time()*1000
            result = dict(code=p.returncode, out=p.stdout.hex(), err=p.stderr.hex(), types=typed_state.snapshot(db))
            typed_state.no_panic(result)
            if args[1] in ['list','show','health']: assert before == result['types'], (name, result)
            normalize(result,args,started,ended,answer.decode(errors='replace').strip().encode())
            pair.append(result)
        equal = all(pair[0][k] == pair[1][k] for k in ['code', 'out', 'err', 'types'])
        results.append(dict(name=name, args=args+mode, ts=pair[0], rust=pair[1], equal=equal))
(evidence/'results.json').write_text(json.dumps(results, indent=2))
failures = [r for r in results if not r['equal']]
(evidence/'failures.json').write_text(json.dumps(failures, indent=2))
print('evidence', evidence, 'pairs', len(results), 'equal', len(results)-len(failures), 'failing', len(failures))
print('EXIT HISTOGRAM credentials', dict(collections.Counter(r['ts']['code'] for r in results)))
assert not failures, f'{len(failures)} parity mismatches'
