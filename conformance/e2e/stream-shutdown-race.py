#!/usr/bin/env python3
"""Immediate-after-101 shutdown comparison. Caller supplies scrubbed netns."""
import base64
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('wire',Path(__file__).with_name('stream-slow-reader.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

def run(binary,root,count,delay):
    root.mkdir(parents=True)
    env=dict(os.environ,OMNI_ROOT=str(root),OMNI_DB_PATH=str(root/'omni.db'),OMNI_HOST='127.0.0.1',OMNI_PORT='18794',OMNI_LOG_LEVEL='debug',OMNI_ENCRYPTION_KEY='stream-test-encryption-key-0123456789')
    results=[]
    for i in range(count):
        with (root/f'{i}.log').open('wb') as log:
            p=subprocess.Popen([binary],cwd=root,env=env,stdout=log,stderr=log)
            def api(path,body=None):
                c=http.client.HTTPConnection('127.0.0.1',18794,timeout=5)
                c.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),{'content-type':'application/json'})
                r=c.getresponse();data=r.read();cookie=r.getheader('set-cookie');c.close()
                assert r.status==200,(r.status,data)
                return cookie.split(';')[0] if cookie else ''
            s=None
            try:
                for _ in range(3000):
                    try:api('/health');break
                    except OSError:time.sleep(.01)
                if i==0:api('/api/setup',{'password':'stream-test-password'})
                cookie=api('/api/login',{'password':'stream-test-password'})
                s=socket.create_connection(('127.0.0.1',18794));s.settimeout(3)
                s.sendall(('GET /api/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+base64.b64encode(b'the sample nonce').decode()+'\r\nCookie: '+cookie+'\r\n\r\n').encode())
                head=b''
                while not head.endswith(b'\r\n\r\n'):head+=w.exact(s,1)
                assert head.startswith(b'HTTP/1.1 101'),head
                if delay:time.sleep(delay)
                start=time.monotonic_ns();p.terminate()
                try:
                    op,data=w.frame(s)
                    outcome={'opcode':op,'hex':data.hex()}
                except (EOFError,OSError) as e:outcome={'error':type(e).__name__}
                outcome.update(elapsed_ns=time.monotonic_ns()-start)
                p.wait(timeout=10);outcome['process_exit']=p.returncode;results.append(outcome)
            finally:
                if s:s.close()
                if p.poll() is None:p.terminate();p.wait(timeout=10)
    (root/'results.json').write_text(json.dumps(results,indent=2))
    print(binary,delay,dict((k,sum(str(r.get('error',r.get('opcode')))==k for r in results)) for k in {str(r.get('error',r.get('opcode'))) for r in results}),flush=True)

if __name__=='__main__':
    root=Path(sys.argv[1]);count=int(sys.argv[2])
    for index,binary in enumerate(sys.argv[3:]):
        for delay in (0,.01):run(binary,root/f'{index}-{delay}',count,delay)
