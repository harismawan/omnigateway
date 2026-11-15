"""Exact SQLite cell comparison; only the targeted revoke clock may vary."""
import sqlite3
from contextlib import closing

TOLERANCE_MS = 1000

def snapshot(path):
    with closing(sqlite3.connect(path)) as db:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        return {t: [dict(zip(cols, zip(row[::2], row[1::2]))) for row in db.execute(
            'SELECT '+','.join('typeof("'+c+'"),hex("'+c+'")' for c in cols)+' FROM "'+t+'"')]
            for t in tables for cols in [[r[1] for r in db.execute('pragma table_info("'+t+'")')]]}

def equal(pair, args):
    left, right = pair
    if left['types'].keys() != right['types'].keys():
        return False
    revoke = args[:2] == ['keys', 'revoke'] and left['code'] == right['code'] == 0
    target = ('text', args[2].encode().hex().upper()) if revoke else None
    for table, rows in left['types'].items():
        other = right['types'][table]
        if len(rows) != len(other):
            return False
        for a, b in zip(rows, other):
            if a.keys() != b.keys():
                return False
            for column, cell in a.items():
                if revoke and table == 'api_keys' and column == 'revoked_at' and a.get('id') == b.get('id') == target:
                    for side, value in [(left, cell), (right, b[column])]:
                        if value[0] != 'integer':
                            return False
                        clock = int(bytes.fromhex(value[1]))
                        if not side['started']-TOLERANCE_MS <= clock <= side['ended']+TOLERANCE_MS:
                            return False
                elif cell != b[column]:
                    return False
    return True

def no_panic(result):
    stderr = bytes.fromhex(result['err']).decode(errors='replace')
    assert result['code'] not in (101, 134, -6) and 'panicked' not in stderr and "thread 'main'" not in stderr, result
