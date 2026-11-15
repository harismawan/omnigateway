"""Trace once, then inject a bounded delay at an observed syscall occurrence.

Kills only the direct CLI child of our strace process, identified through /proc.
Full traces and root captures are retained outside the disposable fixture.
"""
import os
import re
import select
import signal
import subprocess
import sys
import time

point, log, baseline = sys.argv[1:4]
cmd = sys.argv[4:]
target = None
if point not in ("trace", "K1"):
    lines = open(baseline).readlines()
    calls = []
    counts = {}
    for line in lines:
        m = re.match(r"(\d+)\s+(\w+)\(", line)
        if not m:
            continue
        pid, name = m.groups()
        counts[pid, name] = counts.get((pid, name), 0) + 1
        calls.append((name, counts[pid, name], line))
    rename = next((i for i, c in enumerate(calls) if c[0].startswith("rename") and ".incoming" in c[2]), None)
    copy = next((i for i, c in enumerate(calls) if c[0] in ("copy_file_range", "sendfile", "ioctl") and ".incoming" in c[2]), None)
    if point == "K2":
        target = next((c for c in calls if c[0] in ("pwrite64", "write") and "preRestore.sqlite>" in c[2]), None)
    elif point == "K3" and copy is not None:
        target = calls[copy]
    elif point in ("K4", "K5") and copy is not None and rename is not None:
        # Last two are the explicit swap removals; earlier ones are SQLite close.
        unlinks = [c for c in calls[copy:rename] if c[0] in ("unlink", "unlinkat")][-2:]
        index = 0 if point == "K4" else 1
        target = unlinks[index] if len(unlinks) > index else None
    elif point in ("K6", "K7") and rename is not None:
        target = calls[rename]
    elif point == "K8" and rename is not None:
        target = next((c for c in calls[rename+1:] if c[0] == "openat" and '"' + cmd[cmd.index("--root")+1] + '/db"' in c[2]), None)
        # Baseline uses a different scratch directory.
        if target is None:
            target = next((c for c in calls[rename+1:] if c[0] == "openat" and '/db"' in c[2]), None)
    if target is None:
        print("not reached: no matching syscall in baseline")
        sys.exit(0)
    print("TARGET", target, flush=True)

master, slave = os.openpty()
args = ["/usr/bin/strace", "-f", "-yy", "-e", "trace=file,desc", "-o", log+".trace"]
if target:
    phase = "delay_exit" if point == "K7" else "delay_enter"
    args += ["-e", f"inject={target[0]}:{phase}=10s:when={target[1]}"]
p = subprocess.Popen(args+cmd, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
child = None
data = b""
answered = False
killed = False
deadline = time.monotonic()+25
try:
    while p.poll() is None and time.monotonic() < deadline:
        if child is None:
            children = open(f"/proc/{p.pid}/task/{p.pid}/children").read().split()
            if children:
                child = int(children[0])
        if select.select([master], [], [], .02)[0]:
            try:
                data += os.read(master, 65536)
            except OSError:
                break
        if b"[y/N]" in data and not answered:
            if point == "K1":
                try:
                    os.kill(child, signal.SIGKILL)
                    killed = True
                except ProcessLookupError:
                    print("not reached: target ordinal drifted (process already exited)")
                break
            os.write(master, b"y\n")
            answered = True
        if target and answered:
            # strace prints the syscall entry before the injected delay ends.
            text = open(log+".trace").read()
            matches = re.findall(r"^"+str(child)+r"\s+"+target[0]+r"\(.*", text, re.M)
            if len(matches) >= target[1]:
                replay = matches[target[1]-1]
                root = cmd[cmd.index("--root")+1]
                expected = {"K3": "/db.incoming", "K4": "/db-wal", "K5": "/db-shm", "K6": "/db.incoming", "K7": "/db.incoming", "K8": '/db"'}.get(point)
                valid = root in replay and (("_preRestore.sqlite>" in replay) if point == "K2" else root+expected in replay)
                if not valid:
                    os.kill(child, signal.SIGKILL)
                    killed = True
                    print("not reached: delayed syscall PATH mismatch:", replay, flush=True)
                    break
                time.sleep(.15)
                try:
                    os.kill(child, signal.SIGKILL)
                    killed = True
                except ProcessLookupError:
                    print("not reached: target ordinal drifted (process already exited)")
                break
    if p.poll() is None and not killed:
        if child:
            os.kill(child, signal.SIGKILL)
        print("not reached: timeout")
    p.wait(timeout=15)
finally:
    os.close(master)
open(log+".output", "wb").write(data)
print("completed trace" if point == "trace" else "killed" if killed else "not reached: exited before target")
