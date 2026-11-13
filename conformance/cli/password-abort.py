"""Review part2/panic.py: closed stderr must restore raw terminal, even abort builds."""
import os, termios, subprocess, json, pathlib, tempfile, hashlib

binary = pathlib.Path(os.environ['OMNI_CLI_BIN']).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='/tmp/opencode/e1-e5/password-abort-'))
(root/'manifest.json').write_text(json.dumps({'commit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(),'binary':str(binary),'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}))
master, slave = os.openpty()
before = termios.tcgetattr(slave)
read, write = os.pipe()
os.close(read)
try:
    p = subprocess.Popen([str(binary),'--root',str(root),'admin','set-password'],stdin=slave,stdout=subprocess.PIPE,stderr=write,env={**os.environ,'OMNI_ENCRYPTION_KEY':'password-golden-secret'})
    os.close(write)
    code = p.wait(timeout=10)
    restored = before == termios.tcgetattr(slave)
    print(json.dumps({'code':code,'restored':restored,'artifacts':str(root)}),flush=True)
    assert restored
    assert code == 1
finally:
    os.close(master)
    os.close(slave)
