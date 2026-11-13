import os, sys, json, termios, subprocess, errno, time
master, slave = os.openpty()
before = termios.tcgetattr(slave)
p = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
out = bytearray()
answered = 0
parts = json.loads(sys.argv[1])
while True:
    chunk = os.read(master, 65536)
    out.extend(chunk)
    if answered == 0 and b"New admin password: " in out:
        while termios.tcgetattr(slave)[3] & termios.ICANON:
            time.sleep(0.001)
        for part in parts:
            os.write(master, bytes.fromhex(part))
            time.sleep(0.01)
        answered = 1
    elif answered == 1 and b"Repeat it: " in out:
        # The TS seam answers itself; Rust consumes the identical byte sequence.
        if os.environ.get("READER_RUST") == "1":
            for part in parts:
                os.write(master, bytes.fromhex(part))
                time.sleep(0.01)
        answered = 2
    if p.poll() is not None:
        break
    # Slave stays open for the terminal restoration assertion. A select timeout
    # allows observing process exit without relying on EIO from the master.
    import select
    while not select.select([master], [], [], 0.05)[0]:
        if p.poll() is not None:
            break
    if p.poll() is not None:
        while select.select([master], [], [], 0)[0]:
            out.extend(os.read(master, 65536))
        break
after = termios.tcgetattr(slave)
os.close(master)
os.close(slave)
print(json.dumps({"bytes":out.hex(),"code":p.wait(),"restored":before == after}))
