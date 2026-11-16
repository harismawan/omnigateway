"""X3 frozen HTTP stored-cell oracle. Run sequentially; ports 19500/19501.

OMNI_TS_BIN and OMNI_GATEWAY_BIN must name copied binaries. No inherited
gateway environment, real config, provider calls, or Bun source execution.
Only routing/auth strictness and /v1/models frozen JSON failures are accepted.
Evidence (including complete responses, typed DB states and logs) is private.
"""
import collections
import http.client
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile
import time


ROOT = pathlib.Path(tempfile.mkdtemp(prefix='operator-', dir='/tmp/opencode/x3'))
BINS = [os.environ['OMNI_TS_BIN'], os.environ['OMNI_GATEWAY_BIN']]
PASSWORD = 'x3-synthetic-password-2026'
PORTS = [19500, 19501]
CHILDREN = []
RESULTS = []
TABLES = ['api_keys', 'credentials', 'virtual_models', 'settings', 'request_logs', 'quota_windows', 'credential_health', 'quota_samples']
ACCEPTED = json.loads(pathlib.Path(__file__).with_name('x3-accepted.json').read_text())
ID = dict(integer='1', real='1.5', blob="X'7178'", null='NULL',
          invalidutf="CAST(X'71ff' AS TEXT)", empty="''", numeric="'123'")
JSON = dict(truncated="'\"canary_x3'", bare="'broken'", empty="''",
            object="'{}'", array="'[]'", null='NULL', integer='1', real='1.5',
            blob="X'7b7d'", blobnum="X'31'", invalidutf="CAST(X'22ff22' AS TEXT)")


def request(i, method, path, body=None, cookie=None, key=None):
    headers = {'Content-Type': 'application/json'}
    if cookie:
        headers['Cookie'] = cookie
    if key:
        headers['Authorization'] = 'Bearer ' + key
    c = http.client.HTTPConnection('127.0.0.1', PORTS[i], timeout=20)
    try:
        c.request(method, path, None if body is None else json.dumps(body), headers)
        r = c.getresponse()
        return dict(status=r.status, content_type=r.getheader('content-type'),
                    body=r.read().hex(), cookie=(r.getheader('set-cookie') or '').split(';')[0])
    finally:
        c.close()


def boot(i, db):
    home = ROOT / ('home' + str(i))
    home.mkdir(exist_ok=True)
    env = dict(PATH='/usr/bin:/bin', HOME=str(home), XDG_CONFIG_HOME=str(home/'config'),
               XDG_STATE_HOME=str(home/'state'), OMNI_ROOT=str(home), OMNI_DB_PATH=str(db),
               OMNI_STATIC_DIR=str(home/'static'), OMNI_HOST='127.0.0.1',
               OMNI_PORT=str(PORTS[i]), OMNI_ENCRYPTION_KEY='x3-synthetic-encryption-key-at-least-32-characters',
               OMNI_LOG_LEVEL='warn', OMNI_DAY_OFFSET_MINUTES='0', NO_COLOR='1')
    log = ROOT / ('gateway-' + str(len(RESULTS)) + '-' + str(i) + '.log')
    with log.open('wb') as f:
        p = subprocess.Popen([BINS[i]] + (['--no-env-file'] if i == 0 else []),
                             cwd=home, env=env, stdout=f, stderr=f)
    CHILDREN.append(p)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        assert p.poll() is None, log.read_text(errors='replace')
        try:
            request(i, 'GET', '/api/status')
            return p, log
        except OSError:
            time.sleep(.03)
    raise AssertionError('startup timeout: ' + str(log))


def stop(p):
    p.terminate()
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    CHILDREN.remove(p)


def canonical(r):
    raw = bytes.fromhex(r['body'])
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        return r['status'], r['content_type'], raw.hex()

    def walk(x):
        if isinstance(x, dict):
            return {k: ('<clock>' if k in ['now', 'uptime', 'uptimeMs', 'generatedAt',
                         'sampledAt', 'serverTime', 'seenAt'] else '<node-id>' if k == 'id' and 'self' in x
                        else '<request-id>' if k == 'requestId' and isinstance(v, str) and len(v) == 36
                        else walk(v)) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x
    # The probe's existing JSON-property-order mask; all unmasked bytes remain exact.
    return r['status'], r['content_type'], json.dumps(walk(value), sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def state(db, creation=False):
    d = sqlite3.connect(db)
    out = {}
    for table in TABLES:
        names = [r[1] for r in d.execute('pragma table_info(' + table + ')')]
        expressions = ','.join('typeof("' + n + '"),hex("' + n + '")' for n in names)
        rows = []
        for row in d.execute('select ' + expressions + ' from ' + table):
            cells = list(zip(row[::2], row[1::2]))
            if creation and table == 'credentials' and cells[names.index('id')][1] != META['cred_id'].encode().hex().upper():
                for n in ['id', 'api_key', 'created_at', 'updated_at']:
                    index = names.index(n)
                    cells[index] = (cells[index][0], '<generated>')
            # Mutation-generated wall clocks only; storage class still checked.
            for n in ['updated_at', 'revoked_at']:
                if n in names and cells[names.index(n)][0] != 'null':
                    cells[names.index(n)] = (cells[names.index(n)][0], '<clock>')
            rows.append(cells)
        out[table] = sorted(rows, key=repr)
    d.close()
    return out


def prepare(db, table, column, sql_value, recreate=True, multi=False):
    shutil.copyfile(ROOT/'seed.db', db)
    d = sqlite3.connect(db)
    if multi:
        names = [r[1] for r in d.execute('pragma table_info(credentials)')]
        row = list(d.execute('select * from credentials').fetchone())
        row[names.index('id')] = 'unrelated-credential'
        d.execute('insert into credentials values(' + ','.join('?' for _ in names) + ')', row)
    if table != 'baseline':
        if recreate:
            names = [r[1] for r in d.execute('pragma table_info(' + table + ')')]
            rows = list(d.execute('select * from ' + table))
            d.execute('drop table ' + table)
            d.execute('create table ' + table + '(' + ','.join('"'+n+'"'+(' PRIMARY KEY' if n in ['id', 'key'] else '') for n in names) + ')')
            d.executemany('insert into ' + table + ' values(' + ','.join('?' for _ in names) + ')', rows)
        d.execute('update ' + table + ' set ' + column.split('.')[0] + '=' + sql_value +
                  (" where key='settings'" if table == 'settings' else " where id='unrelated-credential'" if multi else ''))
    d.commit()
    d.close()


def run_case(case, batch, recreate=True, multi=False):
    group, table, column, cell, value = case
    sides = []
    for i in range(2):
        db = ROOT / ('case-' + str(len(RESULTS)) + '-' + str(i) + '.db')
        prepare(db, table, column, value, recreate, multi)
        p, log = boot(i, db)
        try:
            login = request(i, 'POST', '/api/login', {'password': PASSWORD})
            assert login['status'] == 200
            client = request(i, 'POST', '/api/client/login', {'key': META['key']}) if any(q[1].startswith('/api/client/') for q in batch) else {}
            answers = []
            for method, path, body in batch:
                response = request(i, method, path, body,
                                   client.get('cookie') if path.startswith('/api/client/') else login['cookie'],
                                   META['key'] if path == '/v1/models' else None)
                response.pop('cookie', None)
                if method == 'POST' and path == '/api/credentials':
                    payload = json.loads(bytes.fromhex(response['body']))
                    if 'credential' in payload:
                        for field in ['id', 'createdAt', 'updatedAt']:
                            payload['credential'][field] = '<generated>'
                        response['body'] = json.dumps(payload).encode().hex()
                answers.append(dict(response=response, state=state(db, creation=method == 'POST') if method != 'GET' else None))
            assert p.poll() is None, 'gateway exited'
        finally:
            stop(p)
        assert 'panicked' not in log.read_text(errors='replace'), str(log)
        sides.append(answers)
    for q, a, b in zip(batch, *sides):
        equal = canonical(a['response']) == canonical(b['response']) and a['state'] == b['state']
        accepted = None
        if not equal:
            for allowed in ACCEPTED:
                if (allowed['case'] == list(case) and allowed['request'] == list(q)
                        and allowed['statuses'] == [a['response']['status'], b['response']['status']]):
                    accepted = allowed['accepted']
                    if 'rust_body' in allowed:
                        assert b['response']['body'] == allowed['rust_body'], 'accepted auth body drift'
                    break
        RESULTS.append(dict(case=case, request=q, ts=a, rust=b, equal=equal, accepted=accepted))


def main():
    global META
    db = ROOT/'seed.db'
    p, _ = boot(0, db)
    try:
        setup = request(0, 'POST', '/api/setup', {'password': PASSWORD})
        assert setup['status'] == 200
        key = json.loads(bytes.fromhex(request(0, 'POST', '/api/keys', {'label': 'x3-key'}, setup['cookie'])['body']))
        cred = json.loads(bytes.fromhex(request(0, 'POST', '/api/credentials', {'provider': 'openai', 'apiKey': 'sk-synthetic-not-a-real-key', 'label': 'x3-credential'}, setup['cookie'])['body']))['credential']
    finally:
        stop(p)
    META = dict(key=key['key'], key_id=key['id'], cred_id=cred['id'])
    target = dict(provider='openai', model='gpt-4o', credentialId=cred['id'], tier=1, weight=1,
                  costPerMTok=dict(input=1, output=1), capabilities=dict(tools=True, images=True, reasoning=False))
    model = dict(id='x3-model', targets=[target], strategy='weighted', isAlias=False)
    d = sqlite3.connect(db)
    # Remove the seed process heartbeat, which otherwise expires mid-corpus.
    d.execute('delete from nodes')
    d.execute('update api_keys set created_at=1700000000000')
    d.execute('update credentials set created_at=1700000000000,updated_at=1700000000000')
    d.execute('insert into virtual_models values(?,?,?,?)', ('x3-model', json.dumps([target]), 'weighted', 0))
    d.execute("insert or replace into settings values('settings','{}')")
    d.execute('insert into request_logs(id,at,api_key_id,requested_model,resolved_provider,resolved_model,credential_id,status,duration_ms) values(?,?,?,?,?,?,?,?,?)', ('x3-log', 1700000000000, key['id'], 'x3-model', 'openai', 'gpt-4o', cred['id'], 200, 12))
    d.commit()
    d.close()
    gets = ['/api/keys', '/api/models', '/api/credentials', '/api/credentials/health', '/api/settings', '/api/catalog', '/api/usage?since=0&until=1800000000000', '/api/logs?until=1800000000000', '/api/logs/export?until=1800000000000', '/api/nodes', '/api/status']
    gets += ['/api/client/'+s for s in ['summary', 'quota', 'quota/history?since=0&until=1800000000000', 'usage?since=0&until=1800000000000', 'logs?until=1800000000000']] + ['/v1/models']
    mutations = [('PATCH', '/api/keys/'+key['id'], {'label': 'edited'}), ('PUT', '/api/keys/'+key['id']+'/smart-routing', {'enabled': False}), ('DELETE', '/api/keys/'+key['id'], None), ('PUT', '/api/models/x3-model', model), ('DELETE', '/api/models/x3-model', None), ('PATCH', '/api/credentials/'+cred['id'], {'label': 'edited'}), ('DELETE', '/api/credentials/'+cred['id'], None)]
    columns = dict(api_keys=['id', 'label', 'prefix'], credentials=['id', 'provider', 'label', 'auth_type', 'account_email'], virtual_models=['id', 'strategy'], request_logs=['id', 'api_key_id', 'credential_id'])
    cases = [('baseline', 'baseline', '', '', '')]
    cases += [('a', t, c, k, v) for t, cs in columns.items() for c in cs for k, v in ID.items()]
    cases += [('b', t, c, k, v) for t, c in [('credentials', 'provider_data'), ('api_keys', 'model_allowlist'), ('api_keys', 'limits'), ('virtual_models', 'targets'), ('settings', 'value')] for k, v in JSON.items()]
    for k, v in [('integer', 1), ('real', 1.5), ('null', None), ('empty', ''), ('numeric', '123'), ('object', {}), ('array', [])]:
        cases.append(('a', 'virtual_models', 'targets.credentialId', k, "'"+json.dumps([dict(target, credentialId=v)]).replace("'", "''")+"'"))
    for case in cases:
        t = case[1]
        run_case(case, [('GET', path, None) for path in gets])
        for q in mutations:
            if t == 'baseline' or t == 'api_keys' and '/api/keys/' in q[1] or t == 'credentials' and ('/api/credentials/' in q[1] or q[0] == 'PUT' and '/api/models/' in q[1]) or t == 'virtual_models' and '/api/models/' in q[1]:
                run_case(case, [q])
    for t, c in [('request_logs', 'at')] + [('credentials', c) for c in ['id', 'provider', 'auth_type', 'label']]:
        for k, v in ID.items():
            q = ('GET', '/api/credentials/health', None) if t == 'request_logs' else ('PUT', '/api/models/x3-new', dict(model, id='x3-new'))
            run_case(('extra', t, c, k, v), [q])
    for t, c, k, path in [('credentials', 'id', 'invalidutf', '/api/catalog'), ('api_keys', 'label', 'blob', '/api/keys')]:
        run_case(('shipped', t, c, k, ID[k]), [('GET', path, None)], recreate=False)
    for k in ['integer', 'real']:
        run_case(('multirow', 'credentials', 'provider_data', k, ID[k]), [('GET', '/api/client/quota', None)], multi=True)
    # Nonempty health/quota fixtures; mutate every column over SQLite scalar classes.
    d = sqlite3.connect(db)
    d.execute("INSERT INTO quota_windows VALUES(?, 'daily',1700000000000,1,10,1800000000000,1700000000000,86400000)", (cred['id'],))
    d.execute("INSERT INTO credential_health(credential_id,model,breaker_state,consecutive_failures) VALUES(?,'gpt-4o','closed',0)", (cred['id'],))
    d.execute("INSERT INTO quota_samples VALUES(?,'daily',1700000000000,1,10,1800000000000,86400000)", (cred['id'],))
    d.commit()
    d.close()
    scalar = dict(ID, blobempty="X''", zero='0', negative='-1', text="'daily'")
    for table in ['quota_windows', 'credential_health', 'quota_samples']:
        d = sqlite3.connect(db)
        cols = [r[1] for r in d.execute('pragma table_info('+table+')')]
        d.close()
        for column in cols:
            for cell, value in scalar.items():
                run_case(('quota-cells', table, column, cell, value),
                         [('GET', path, None) for path in ['/api/credentials/health', '/api/client/quota', '/api/client/quota/history?since=0&until=1800000000000']])
    for field in ['tier', 'weight']:
        for number in [2, 2.5, 9007199254740992, 1e20]:
            run_case(('writeback', 'credentials', 'label', 'blob', ID['blob']),
                     [('PATCH', '/api/credentials/'+cred['id'], {field: number})])
    # Synthetic create: response metadata must not depend on missing defaults.
    run_case(('create', 'credentials', 'label', 'integer', '1'),
             [('POST', '/api/credentials', {'provider': 'openai', 'apiKey': 'sk-synthetic-second', 'label': 'second'})])
    counts = collections.Counter(r['accepted'] for r in RESULTS if r['accepted'])
    failures = [r for r in RESULTS if not r['equal'] and not r['accepted']]
    (ROOT/'results.json').write_text(json.dumps(RESULTS, indent=2))
    summary = dict(pairs=len(RESULTS), equal=sum(r['equal'] for r in RESULTS), accepted=dict(counts), unexpected=len(failures))
    (ROOT/'summary.json').write_text(json.dumps(summary, indent=2))
    print('evidence', ROOT, flush=True)
    print(json.dumps(summary), flush=True)
    assert counts == {'routing-strict': 94, 'v1-models-frozen-json': 15}, counts
    assert not failures, str(len(failures)) + ' unexpected differences'


try:
    main()
finally:
    for child in CHILDREN[:]:
        stop(child)
