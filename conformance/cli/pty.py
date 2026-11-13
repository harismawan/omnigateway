"""Run one CLI with deterministic terminal attributes; emit raw bytes as hex."""
import errno
import fcntl
import json
import os
import struct
import subprocess
import sys
import termios

master, slave = os.openpty()
fcntl.fcntl(slave, fcntl.F_SETFL, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
attrs = termios.tcgetattr(slave)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(slave, termios.TCSANOW, attrs)
env = dict(os.environ)
env.pop("NO_COLOR", None)
# Opt-in: PTY_NO_COLOR becomes NO_COLOR inside the terminal, for suppression cases.
if "PTY_NO_COLOR" in env:
    env["NO_COLOR"] = env.pop("PTY_NO_COLOR")
env["TERM"] = "xterm-256color"
p = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
out = bytearray()
answered = False
answers = json.loads(env.get("PTY_ANSWERS", "[]"))
answer_index = 0
prompt_end = 0
while True:
    try:
        chunk = os.read(master, 65536)
    except OSError as e:
        if e.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    out.extend(chunk)
    if answer_index < len(answers) and (b"]: " in out[prompt_end:] or b"password: " in out[prompt_end:] or b"Repeat it: " in out[prompt_end:]):
        if env.get("PTY_WAIT_RAW") == "1" and b"password: " in out[prompt_end:]:
            import time
            while termios.tcgetattr(master)[3] & termios.ICANON:
                time.sleep(0.001)
        os.write(master, answers[answer_index].encode() + b"\n")
        answer_index += 1
        prompt_end = len(out)
    if b"[y/N]" in out and not answered:
        os.write(master, sys.argv[1].encode() + b"\n")
        answered = True
os.close(master)
print(json.dumps({"bytes": out.hex(), "code": p.wait()}))
