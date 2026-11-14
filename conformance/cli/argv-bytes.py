"""Unix argv decoding: Bun replaces malformed UTF-8, rather than panicking."""
import os
import pathlib
import shutil
import subprocess
import tempfile

binary = pathlib.Path(os.environ.get('OMNI_CLI_BIN', 'target/debug/omni')).resolve()
commands = [[shutil.which('bun'), '--no-env-file', str(pathlib.Path.cwd() / 'apps/cli/src/index.ts')], [str(binary)]]
samples = {
    b'\xff': '[65533]',
    b'\xc0\xaf': '[65533,65533]',
    b'\xed\xa0\x80': '[65533,65533,65533]',
    b'\xf0\x9f': '[65533]',
    b'a\x80b': '[97,65533,98]',
    b'\xe2\x82A': '[65533,65]',
}
for raw, expected in samples.items():
    probe = subprocess.run(['bun', '--no-env-file', '-e',
        'console.log(JSON.stringify(Array.from({length:process.argv[1].length},(_,i)=>process.argv[1].charCodeAt(i))))', '--', raw], capture_output=True, check=True)
    assert probe.stdout.decode().strip() == expected, (raw, probe.stdout)
    print(f'Bun argv {raw.hex()} code units = {expected}')

with tempfile.TemporaryDirectory(prefix='/tmp/opencode/e1-e5/db9-argv-') as base:
    seed = pathlib.Path(base) / 'seed'
    seed.mkdir()
    subprocess.run(commands[0] + ['--root', str(seed), '--db', 'db', 'db', 'snapshots'],
                   env={**os.environ, 'HOME': str(seed), 'OMNI_ENCRYPTION_KEY': 'database-golden-secret'},
                   capture_output=True, check=True)
    results = []
    for name in ['root', 'positional', 'string-option']:
        pair = []
        for index, command in enumerate(commands):
            root = pathlib.Path(base) / f'{name}-{index}'
            root.mkdir()
            if name == 'positional':
                shutil.copyfile(seed / 'db', root / 'db')
            env = {**os.environ, 'HOME': str(root), 'XDG_STATE_HOME': str(root / 'state'),
                   'OMNI_ENCRYPTION_KEY': 'database-golden-secret', 'NO_COLOR': '1'}
            # Positional validation opens the store; compare its full post-state.
            args = ['--root', str(root), '--db', 'db', 'db', 'restore', 'bad\ufffd']
            if name == 'root':
                args = ['--root', os.fsencode(root) + b'/\xff', '--db', 'db', 'db', 'snapshots']
            elif name == 'positional':
                args[-1] = b'bad\xff'
            else:
                args = ['--root', str(root), '--db', b'\xff/db', 'db', 'snapshots']
            p = subprocess.run(command + args, env=env, capture_output=True)
            result = (p.returncode, p.stdout.replace(os.fsencode(root), b'<root>'), p.stderr.replace(os.fsencode(root), b'<root>'))
            assert p.returncode == 1, (name, index, result)
            state = subprocess.run(['bun', '--no-env-file', '-e',
                'import {frozenPostState} from "./conformance/cli/db-file-state.ts"; console.log(JSON.stringify(frozenPostState(process.argv[1])))',
                '--', str(root)], capture_output=True, check=True).stdout
            pair.append((result, state))
        assert pair[0] == pair[1], (name, pair)
        results.append(pair[0][0][0])
        print(f'PASS {name}: {pair[0][0]!r}; full post-state equal')
    assert results == [1, 1, 1]
print('PASS 3 argv byte comparisons; pinned frozen exits 1=3; 6 Bun decoding probes')
