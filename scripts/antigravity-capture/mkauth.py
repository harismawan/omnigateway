"""Write a synthetic consumer login into a fresh HOME, never the live home."""

import json
import os
from pathlib import Path
import sys

if len(sys.argv) != 3 or sys.argv[2] not in {"app", "cli"}:
    raise SystemExit("usage: mkauth.py <fresh-home> <app|cli>")
home = Path(sys.argv[1])
if home.exists():
    raise SystemExit("refusing to write into an existing home")
os.umask(0o077)
file = home / ".gemini" / (
    "jetski-standalone-oauth-token" if sys.argv[2] == "app"
    else "antigravity-cli/antigravity-oauth-token"
)
file.parent.mkdir(parents=True)
file.write_text(json.dumps({"auth_method": "consumer", "token": {
    "access_token": "capture-access-token", "refresh_token": "capture-refresh-token",
    "token_type": "Bearer", "expiry": "2099-01-01T00:00:00Z",
}}))
