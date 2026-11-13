"""Missing DB creation and exclusive-lock refusal, independent fixtures."""
import pathlib, tempfile, subprocess, os, json, sqlite3, shutil, hashlib
root=pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/e1-e5/db-boundaries-'))
binary=pathlib.Path(os.environ['OMNI_CLI_BIN']).resolve()
commands=[[shutil.which('bun'),'--no-env-file',str(pathlib.Path.cwd()/'apps/cli/src/index.ts')],[str(binary)]]
env={**os.environ,'OMNI_ENCRYPTION_KEY':'database-golden-secret','HOME':str(root)}
(root/'manifest.json').write_text(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(),'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}))
count=0
for locked in [False,True]:
 for verb in ['stats','snapshots']:
  results=[]
  for cmd in commands:
   path=root/'db'
   for suffix in ['', '-wal','-shm']:pathlib.Path(str(path)+suffix).unlink(missing_ok=True)
   lock=None
   if locked:
    subprocess.run(commands[0]+['--root',str(root),'--db',str(path),'db','snapshots','--json'],env=env,capture_output=True,check=True)
    lock=sqlite3.connect(path);lock.execute('PRAGMA journal_mode=DELETE');lock.execute('BEGIN EXCLUSIVE')
    before=list(lock.iterdump())
   else: assert not path.exists()
   p=subprocess.run(cmd+['--root',str(root),'--db',str(path),'db',verb,'--json'],env=env,capture_output=True)
   if locked:
    assert p.returncode==1 and p.stdout==b'' and p.stderr==b'database is locked\n',(cmd,p.returncode,p.stdout,p.stderr)
    assert list(lock.iterdump())==before;lock.rollback();lock.close()
    results.append((p.returncode,p.stdout,p.stderr))
   else:
    assert p.returncode==0 and p.stderr==b'',(cmd,p.returncode,p.stderr)
    data=json.loads(p.stdout)
    if verb=='stats':assert data['engine']=='sqlite' and data['stats']['schemaVersion']>0
    else:assert data=={'snapshots':[]}
    db=sqlite3.connect(path);assert db.execute('SELECT count(*) FROM migrations').fetchone()[0]>0
    # Schema timestamps are generated on creation; all other logical cells compared.
    db.execute('UPDATE migrations SET applied_at=0');db.commit();results.append(list(db.iterdump()));db.close()
  assert results[0]==results[1]
  count+=1
print(f'PASS {count} missing/locked database comparisons ({root})')
