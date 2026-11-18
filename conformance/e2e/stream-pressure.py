#!/usr/bin/env python3
"""Sequenced console stopped-reader probe. No synthetic publisher/bypass.

250ms source floor and frozen <=80s lifetime bound frame count below queue1000;
this measures actual survivors/resumption, not a fabricated saturation proof.
"""
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

spec=importlib.util.spec_from_file_location('wire',Path(__file__).with_name('stream-slow-reader.py'))
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)

def run(binary, root):
    root.mkdir(parents=True);path=root/'console.log';path.touch()
    env=dict(os.environ,OMNI_ROOT=str(root),OMNI_DB_PATH=str(root/'omni.db'),OMNI_HOST='127.0.0.1',OMNI_PORT='18794',OMNI_LOG_LEVEL='error',OMNI_LOG_FILE=str(path),OMNI_METRICS_TOKEN='pressure-token',OMNI_ENCRYPTION_KEY='stream-test-encryption-key-0123456789')
    log=open(root/'gateway.log','wb');child=subprocess.Popen([binary],cwd=root,env=env,stdout=log,stderr=log)
    cookie='';sock=None
    def api(url,body=None):
        c=http.client.HTTPConnection('127.0.0.1',18794,timeout=10)
        c.request('GET' if body is None else 'POST',url,None if body is None else json.dumps(body),{'cookie':cookie,'content-type':'application/json','authorization':'Bearer pressure-token'} if url=='/metrics' else {'cookie':cookie,'content-type':'application/json'})
        r=c.getresponse();data=r.read();token=r.getheader('set-cookie');c.close()
        assert r.status==200,(url,r.status,data)
        return data,token.split(';')[0] if token else ''
    try:
        for _ in range(200):
            try:api('/health');break
            except OSError:time.sleep(.025)
        api('/api/setup',{'password':'stream-test-password'})
        cookie=api('/api/login',{'password':'stream-test-password'})[1]
        sock=socket.socket();sock.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,1024);sock.settimeout(20);sock.connect(('127.0.0.1',18794))
        sock.sendall(('GET /api/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+base64.b64encode(b'the sample nonce').decode()+'\r\nCookie: '+cookie+'\r\n\r\n').encode())
        head=b''
        while not head.endswith(b'\r\n\r\n'):head+=w.exact(sock,1)
        assert head.startswith(b'HTTP/1.1 101'),head
        w.send(sock,1,json.dumps({'type':'subscribe','topic':'stream:console'}));assert json.loads(w.frame(sock)[1])['type']=='ack'
        before=w.memory(child.pid);start=time.monotonic()
        # NO recv/peek/select or reader thread until after every write + settle.
        # Each line occurs on a distinct source floor, carries its real index.
        for i in range(32):
            with path.open('a') as f:f.write(f'pressure-{i:03d} '+('x'*262144)+'\n')
            time.sleep(.30)
        time.sleep(.6)
        after=w.memory(child.pid);metrics=api('/metrics')[0].decode();blocked=time.monotonic()-start
        (root/'blocked.metrics').write_text(metrics)
        sock.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4*1024*1024)
        seq=[];indices=[];notices=[];close=None
        while len(seq)<32:
            opcode,payload=w.frame(sock)
            if opcode==9:w.send(sock,10,payload.decode());continue
            if opcode==8:close={'code':int.from_bytes(payload[:2],'big'),'reason':payload[2:].decode()};break
            value=json.loads(payload)
            if value.get('type')!='event':notices.append(value);continue
            seq.append(value['seq']);indices.extend(int(line['raw'].split(' ',1)[0].split('-')[1]) for line in value['payload']['lines'])
        assert not notices and close is None,(notices,close)
        assert seq==list(range(1,33)) and indices==list(range(32)),(seq,indices)
        result={'seq':seq,'line_indices':indices,'notices':notices,'close':close,'blocked_seconds':blocked,'before':before,'after':after,'metrics':metrics,'limits':'32 frames: transport pressure/drain observed, queue1000 saturation/drop-oldest not established; memory includes source and process work.'}
        (root/'result.json').write_text(json.dumps(result,indent=2));return result
    finally:
        if sock:sock.close()
        child.terminate();child.wait(timeout=10);log.close()

if __name__=='__main__':
    frozen,rust,work=sys.argv[1:];root=Path(work);root.mkdir(parents=True)
    a=run(frozen,root/'ts');b=run(rust,root/'rust')
    assert a['seq']==b['seq'] and a['line_indices']==b['line_indices']
    print('PASS sequenced console survivors 1..32; no saturation claim')
