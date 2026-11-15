#!/usr/bin/env python3
"""Negative whole-root probes; also acts as the Rust mutation wrapper."""
import json
import os
from pathlib import Path
import subprocess
import sys

if "--root" in sys.argv:
    result = subprocess.run([os.environ["DB_STATE_REAL_BIN"], *sys.argv[1:]])
    root = Path(sys.argv[sys.argv.index("--root") + 1])
    assert str(root).startswith("/tmp/opencode/e1-e5/")
    mutation = os.environ["DB_STATE_MUTATION"]
    if mutation == "file":
        (root / "unexpected-file").write_bytes(b"unexpected")
    elif mutation == "mode":
        db = root / "db"
        db.chmod(0o644 if db.stat().st_mode & 0o7777 == 0o600 else 0o600)
    else:
        (root / "unexpected-directory").mkdir(exist_ok=True)
    sys.exit(result.returncode)

binary = str(Path(os.environ.get("OMNI_CLI_BIN", "target/debug/omni")).resolve())
histogram = {}
for mutation in ("file", "mode", "directory"):
    env = dict(os.environ, OMNI_CLI_BIN=str(Path(__file__).resolve()),
               DB_STATE_REAL_BIN=binary, DB_STATE_MUTATION=mutation)
    result = subprocess.run(["bun", "conformance/cli/db-restore-swap.ts", "--compare"],
                            env=env, capture_output=True)
    log = Path(f"/tmp/opencode/e1-e5/db16-mutation-{mutation}.log")
    log.write_bytes(result.stdout + result.stderr)
    assert result.returncode != 0, f"{mutation}: mutation escaped detection"
    assert b"AssertionError: post-state comparison:" in result.stderr, log
    expected = {"file": b"unexpected-file", "mode": b'"mode":384',
                "directory": b"unexpected-directory"}[mutation]
    assert expected in result.stdout, log
    histogram[f"exit {result.returncode}"] = histogram.get(f"exit {result.returncode}", 0) + 1
    print(f"PASS {mutation}: post-state comparison failed; {log}")
pinned = json.loads(Path("conformance/cli/exit-histograms.json").read_text())
assert histogram == pinned["db-file-state-self-test"], histogram
print("EXIT HISTOGRAM db-file-state-self-test", json.dumps(histogram))
