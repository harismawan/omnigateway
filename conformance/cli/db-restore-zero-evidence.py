"""Version-bound C3 evidence assertion, deliberately outside the pinned matrix.

Usage: python3 conformance/cli/db-restore-zero-evidence.py EVIDENCE_DIR
Requires preserved r5 column-32-{TS,Rust}.{json,db}, db19-before-32-*.db,
and db19-sqlite (reviewer's driver linked to bundled SQLite).
Recreate with r5 columns.py ONLY=valid-log; never normalize arbitrary DB bytes.
"""
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

b = Path(sys.argv[1])
records = [json.loads((b / f"column-32-{w}.json").read_text()) for w in ["TS", "Rust"]]
def streams(r):
    out = json.loads(r["out"])
    snap = out["preRestoreSnapshot"]
    snap["createdAt"] = 0
    for k in ["id", "filename"]:
        snap[k] = re.sub(r"db_[\dTZ-]+_preRestore", "db_<time>_preRestore", snap[k])
    return r["code"], out, r["err"]
assert streams(records[0]) == streams(records[1])
assert records[0]["code"] == 0
# Candidate, undo snapshot, artifacts, WAL/SHM, modes, sizes and path set equal.
assert [s for s in records[0]["state"] if s[0] != "db"] == [s for s in records[1]["state"] if s[0] != "db"]
assert records[0]["state"][0][:3] == records[1]["state"][0][:3]
assert (b / "db19-before-32-TS.db").read_bytes() == (b / "db19-before-32-Rust.db").read_bytes()
data = [(b / f"column-32-{w}.db").read_bytes() for w in ["TS", "Rust"]]
logical = []
with tempfile.TemporaryDirectory(prefix="db20-zero-", dir="/tmp/opencode") as tmp:
    tmp = Path(tmp)
    for writer, raw in zip(["TS", "Rust"], data):
        p = tmp / f"{writer}.db"
        p.write_bytes(raw)
        c = sqlite3.connect(p)
        assert c.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert c.execute("SELECT rootpage FROM sqlite_master WHERE name='usage_rollup'").fetchone() == (33,)
        tables = c.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
        content = []
        for table, schema in tables:
            quote = lambda s: '"' + s.replace('"', '""') + '"'
            cols = [r[1] for r in c.execute(f"PRAGMA table_info({quote(table)})")]
            fields = ','.join(f"{quote(col)},typeof({quote(col)})" for col in cols)
            content.append((schema, c.execute(f"SELECT {fields} FROM {quote(table)}").fetchall()))
        logical.append(content)
        c.close()
        sql = "SELECT json_array(api_key_id,hour,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,typeof(cost_usd)) AS value FROM usage_rollup;"
        q = tmp / "read.sql"
        q.write_text("PRAGMA integrity_check;" + sql)
        r = subprocess.run([str(b / "db19-sqlite"), str(p), str(q)], capture_output=True, text=True, check=True)
        assert not r.stderr
        assert r.stdout.splitlines() == ['version=3.54.1', 'integrity_check=ok ', 'value=["key",0,1,0,0,0,0,0.0,"real"] ']
        js = 'import{Database}from"bun:sqlite";let d=new Database(process.argv[1]);console.log(JSON.stringify([d.query("select sqlite_version() as v").get().v,d.query("pragma integrity_check").get().integrity_check,d.query(process.argv[2]).get().value]));d.close()'
        r = subprocess.run(["bun", "-e", js, str(p), sql], capture_output=True, text=True, check=True)
        assert not r.stderr
        assert json.loads(r.stdout) == ['3.53.4', 'ok', '["key",0,1,0,0,0,0,0.0,"real"]']
        assert p.read_bytes() == raw
assert logical[0] == logical[1]
a, z = data
assert len(a) == len(z) == 159744
assert int.from_bytes(a[16:18], 'big') == int.from_bytes(z[16:18], 'big') == 4096
base = (33 - 1) * 4096
# This fixture has one WITHOUT ROWID leaf-index cell. Header: type 10,
# zero freeblocks, one cell; content-start and cell-pointer both address it.
for raw, start, cell in [(a, 4083, '0c0913080908080808086b6579'), (z, 4075, '140913080908080808076b65790000000000000000')]:
    page = raw[base:base+4096]
    assert page[:5] == bytes.fromhex('0a00000001') and page[7] == 0
    assert int.from_bytes(page[5:7], 'big') == int.from_bytes(page[8:10], 'big') == start
    assert page[start:].hex() == cell
# Payload 12 -> 20; final serial type 8 (compact zero) -> 7 (REAL,
# eight zero bytes). Thus the cell moves back eight bytes. No other delta.
diff = {i for i in range(len(a)) if a[i] != z[i] and not 96 <= i < 100}
assert diff == {base+6, base+9, *range(base+4075, base+4096)}
print("PASS C3: streams/all other files/all SQL values+types equal; four bidirectional opens/integrity checks; exactly 23 structurally explained bytes")
