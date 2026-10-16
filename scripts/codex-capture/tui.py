"""Runs the Codex TUI under a pseudo-terminal for a fixed time, then stops it.

The TUI will not start without a terminal that answers its cursor-position and
device-attribute queries, so this answers both, presses Enter once the prompt
has been typed in from the command line, and kills the process at the
deadline. Usage:

    CODEX_BIN=... CODEX_HOME=... CODEX_CA_CERTIFICATE=... CODEX_WORKDIR=... \
        python3 -I scripts/codex-capture/tui.py [seconds] [model] [prompt]
"""

import os
import pty
import select
import signal
import sys
import time

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0
model = sys.argv[2] if len(sys.argv) > 2 else "gpt-6-astra"
prompt = sys.argv[3] if len(sys.argv) > 3 else "say hi"

env = dict(os.environ)
env["TERM"] = "xterm-256color"
for name in ("CODEX_BIN", "CODEX_HOME", "CODEX_CA_CERTIFICATE", "CODEX_WORKDIR"):
    if not env.get(name):
        sys.exit(f"{name} must be set")

pid, fd = pty.fork()
if pid == 0:
    os.chdir(env["CODEX_WORKDIR"])
    os.execve(env["CODEX_BIN"], ["codex", "-m", model, prompt], env)

deadline = time.time() + seconds
start = time.time()
sent_enter = False
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if b"\x1b[6n" in data:
            os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in data:
            os.write(fd, b"\x1b[?62;c")
    if not sent_enter and time.time() - start > 8:
        os.write(fd, b"\r")
        sent_enter = True
os.kill(pid, signal.SIGTERM)
print("done")
