"""Print ordered header names and an allowlisted summary; never raw bodies."""

import io
import json
from pathlib import Path
import sys

from capture import read_body

if len(sys.argv) != 3:
    raise SystemExit("usage: show.py <capture-dir> <request-number>")
base = Path(sys.argv[1]) / f"{int(sys.argv[2]):03}"
line, *headers = base.with_suffix(".head.txt").read_text(encoding="latin1").splitlines()
method, target, version = line.split(" ", 2)
path, _, query = target.partition("?")
print(method, path + ("?alt=sse" if query == "alt=sse" else ""), version)
public = {"host", "user-agent", "content-length", "content-type",
          "transfer-encoding", "accept", "accept-encoding"}
values = {}
for row in filter(None, headers):
    name, value = row.split(":", 1)
    lower = name.lower()
    values[lower] = value.strip()
    print(f"{name}: {values[lower] if lower in public else '<redacted>'}")
with io.BytesIO(base.with_suffix(".body.bin").read_bytes()) as raw:
    _, body = read_body(raw, values)
try:
    data = json.loads(body)
except ValueError:
    raise SystemExit(0) from None
if isinstance(data, dict):
    print("body keys:", ", ".join(data))
    print({key: data[key] for key in ("model", "userAgent", "requestType") if key in data})
    if isinstance(data.get("request"), dict):
        print("request keys:", ", ".join(data["request"]))
