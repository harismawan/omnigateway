"""Review part2/panic.py: closed stderr must restore raw terminal, even abort builds.

The prompt write is itself the injected failure, so stderr cannot show that the
prompt was reached. Two guards keep a pass from being vacuous:
- a preflight `status` under the identical environment, where a configuration
  or store error is observable;
- pty packet mode: the kernel latches a flow-control status only when the child
  really switched the terminal (raw mode clears IXON), and DOSTOP alone means it
  was switched off at the hidden-input prompt and back on afterwards.
"""
import os, termios, subprocess, json, pathlib, tempfile, hashlib, fcntl, struct, select

binary = pathlib.Path(os.environ['OMNI_CLI_BIN']).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/e1-e5/password-abort-'))
(root/'manifest.json').write_text(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(),'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}))
env = {**os.environ, 'HOME':str(root), 'XDG_STATE_HOME':str(root/'state'), 'OMNI_ENCRYPTION_KEY':'password-golden-secret'}
preflight = subprocess.run([str(binary),'--root',str(root),'status','--json'],env=env,capture_output=True)
assert preflight.returncode == 0, (preflight.stdout, preflight.stderr)
assert json.loads(preflight.stdout)['storeError'] is None, preflight.stdout
master, slave = os.openpty()
fcntl.ioctl(master, termios.TIOCPKT, struct.pack('i', 1))
before = termios.tcgetattr(slave)
# Packet mode reports a change of IXON only with the default stop/start characters.
assert before[0] & termios.IXON and before[6][termios.VSTOP] == b'\x13' and before[6][termios.VSTART] == b'\x11', before
read, write = os.pipe()
os.close(read)
try:
    p = subprocess.Popen([str(binary),'--root',str(root),'admin','set-password'],stdin=slave,stdout=subprocess.PIPE,stderr=write,env=env)
    os.close(write)
    code = p.wait(timeout=10)
    restored = before == termios.tcgetattr(slave)
    packet = os.read(master, 64) if select.select([master], [], [], 1)[0] else b''
    print(json.dumps({'code':code,'restored':restored,'packet':packet.hex(),'artifacts':str(root)}),flush=True)
    assert restored
    assert code == 1
    assert packet == bytes([termios.TIOCPKT_DOSTOP]), ('raw mode was never entered and left', packet)
finally:
    os.close(master)
    os.close(slave)
