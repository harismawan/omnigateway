"""Namespace-only connect secret prompt parity, using real PTY stdin."""
import json
import os
from pathlib import Path
import re
import select
import subprocess
import sys

binary, work = sys.argv[1:]
repo = Path.cwd()
env = dict(PATH=os.environ['PATH'], HOME=str(Path(work)/'home'),
           TMPDIR=str(Path(work)/'tmp'), OMNI_ENCRYPTION_KEY='review-secret-long-enough',
           NO_COLOR='1')
results = []
for mode in [[], ['--json']]:
    for provider in ['openai', 'anthropic', 'antigravity']:
        pair = []
        for command in [['bun', '--no-env-file', str(repo/'apps/cli/src/index.ts')], [binary]]:
            master, slave = os.openpty()
            process = subprocess.Popen(command+['--root', str(Path(work)/'seed'), 'connect', provider]+mode,
                                       stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
            try:
                err = b''
                while b'Paste the code or callback URL: ' not in err:
                    assert select.select([process.stderr], [], [], 30)[0], 'prompt timeout'
                    chunk = os.read(process.stderr.fileno(), 65536)
                    if not chunk:
                        break
                    err += chunk
                os.write(master, b'code#wrong\r')
                out, rest = process.communicate(timeout=30)
                # Only generated PKCE fields in instructions vary between processes.
                err = re.sub(rb'(code_challenge=)[^&\n]+', rb'\1<challenge>', err+rest)
                err = re.sub(rb'(state=)[^&\n]+', rb'\1<state>', err)
                pair.append(dict(code=process.returncode, out=out.hex(), err=err.hex()))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                os.close(master)
                os.close(slave)
        results.append(dict(provider=provider, json=bool(mode), equal=pair[0] == pair[1], pair=pair))
(Path(work)/'tty-results.json').write_text(json.dumps(results, indent=2))
print('PTY pairs', len(results), 'equal', sum(row['equal'] for row in results))
assert all(row['equal'] for row in results)
