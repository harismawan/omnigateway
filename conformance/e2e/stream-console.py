#!/usr/bin/env python3
"""Paired captured-console corpus; caller supplies scrubbed env/netns."""
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

spec = importlib.util.spec_from_file_location('wire', Path(__file__).with_name('stream-slow-reader.py'))
sys.dont_write_bytecode=True
wire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wire)

def run(binary, root, kind):
    root.mkdir(parents=True)
    path = root / 'console.log'
    path.write_text('old raw\n2026-11-18T00:00:00.000Z INFO  old\n')
    env = dict(os.environ, OMNI_ROOT=str(root), OMNI_DB_PATH=str(root/'omni.db'),
               OMNI_HOST='127.0.0.1', OMNI_PORT='18794', OMNI_LOG_LEVEL='error',
               OMNI_ENCRYPTION_KEY='stream-test-encryption-key-0123456789')
    if kind in ('file', 'missing'): env['OMNI_LOG_FILE'] = ' '+str(path if kind == 'file' else root/'missing')+' '
    if kind.startswith('journal'):
        stub = root/'bin'; stub.mkdir()
        # Never read the host journal. Record exact argv and serve private text.
        (stub/'journalctl').write_text('#!/usr/bin/python3\nimport sys,json\nfrom pathlib import Path\np=Path('+repr(str(root))+')\nwith (p/"argv").open("a") as f:f.write(json.dumps(sys.argv[1:])+"\\n")\nprint((p/"console.log").read_text(),end="")\n')
        (stub/'journalctl').chmod(0o755)
        env.update(PATH=str(stub)+':'+env['PATH'], JOURNAL_STREAM='')
        if kind == 'journal-user': env['MANAGERPID']=''
    log = open(root/'gateway.log','wb')
    child = subprocess.Popen([binary], cwd=root, env=env, stdout=log, stderr=log)
    cookie = ''
    def api(url, body=None, method='GET', credential=None):
        conn=http.client.HTTPConnection('127.0.0.1',18794,timeout=10)
        conn.request(method,url,None if body is None else json.dumps(body), {'content-type':'application/json','cookie':cookie if credential is None else credential})
        r=conn.getresponse(); value=r.read(); token=r.getheader('set-cookie'); conn.close()
        return r.status,json.loads(value),token.split(';')[0] if token else ''
    def ws(topic, since=None):
        s=socket.create_connection(('127.0.0.1',18794));s.settimeout(4)
        s.sendall(('GET /api/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+base64.b64encode(b'the sample nonce').decode()+'\r\nCookie: '+cookie+'\r\n\r\n').encode())
        head=b''
        while not head.endswith(b'\r\n\r\n'):head+=wire.exact(s,1)
        assert head.startswith(b'HTTP/1.1 101'),head
        msg={'type':'subscribe','topic':topic}
        if since is not None:msg['sinceSeq']=since
        wire.send(s,1,json.dumps(msg));return s,json.loads(wire.frame(s)[1])
    result={}
    try:
        for _ in range(200):
            try:
                if api('/health')[0]==200:break
            except OSError:time.sleep(.025)
        api('/api/setup',{'password':'stream-test-password'},'POST')
        cookie=api('/api/login',{'password':'stream-test-password'},'POST')[2]
        result['unauth']=api('/api/console',credential='')[:2]
        api('/api/settings/viewer-password',{'password':'stream-viewer-password'},'PUT')
        viewer=api('/api/login',{'password':'stream-viewer-password','mode':'viewer'},'POST')[2]
        result['viewer-status']=api('/api/console',credential=viewer)[0]
        key=api('/api/keys',{'label':'console-client'},'POST')[1]
        client=api('/api/client/login',{'key':key['key']},'POST')[2]
        result['client']=api('/api/console',credential=client)[:2]
        for q in ('','?lines=0','?lines=1.9','?lines=bad','?lines=%20','?lines=999','?level=error','?level=%20ERROR%20','?since=1','?since=bad','?node='):
            value=api('/api/console'+q)[:2]
            if kind=='file':value[1]['path']='<private-file>'
            if kind=='missing':value[1]['path']='<private-missing>'
            result[q]=value
        s,ack=ws('stream:console');result['ack']=ack
        if kind in ('none','missing'):
            assert ack['type']=='error',ack;s.close();return result
        assert ack['type']=='ack',ack
        local,local_ack=ws('stream:console:'+api('/health')[1]['nodeId'])
        assert local_ack['type']=='ack',local_ack
        local.close()
        result['self-node-source']=True
        if kind=='file':
            with path.open('a') as f:f.write('2026-11-18T00:00:00.001Z ERROR appended  reason=x\n')
            event=json.loads(wire.frame(s)[1]);result['append']=event
            assert event['payload']['lines'][0]['msg']=='appended',event
            replay,ack=ws('stream:console',0)
            result['replay']=json.loads(wire.frame(replay)[1]);replay.close()
            time.sleep(.3)
            path.rename(root/'rotated');path.write_text('rotated raw\n')
            result['rotation']=json.loads(wire.frame(s)[1])
            time.sleep(.3);path.write_text('x\n')
            result['truncation']=json.loads(wire.frame(s)[1])
            replay,ack=ws('stream:console',0)
            result['gap']=json.loads(wire.frame(replay)[1]);replay.close()
            path.write_text(''.join(f'raw{i}\n' for i in range(6000)))
            result['large']=api('/api/console?lines=500')[1]['lines']
        else:
            stamp=time.time_ns()//1000000+10
            from datetime import datetime,timezone
            instant=datetime.fromtimestamp(stamp/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
            raw=instant+' ERROR journal-new'
            path.write_text(raw+'\n')
            event=json.loads(wire.frame(s)[1]);assert event['payload']['lines'][0]['raw']==raw,event
            # Same cursor timestamp, distinct raw line survives next poll.
            path.write_text(raw+'\n'+instant+' ERROR journal-second\n')
            event=json.loads(wire.frame(s)[1]);assert len(event['payload']['lines'])==1,event
            result['journal-dedup']=event['payload']['lines'][0]['msg']
            args=[json.loads(v) for v in (root/'argv').read_text().splitlines()]
            assert all(a[-2:]==['--no-pager','--output=cat'] for a in args),args
            result['argv-prefix']=args[0][:-4]
        s.close();return result
    finally:
        child.terminate();child.wait(timeout=10);log.close()

if __name__=='__main__':
    frozen,rust,work=sys.argv[1:];root=Path(work);root.mkdir(parents=True)
    for kind in ('none','missing','file','journal-system','journal-user'):
        a=run(frozen,root/('ts-'+kind),kind);b=run(rust,root/('rust-'+kind),kind)
        (root/(kind+'.json')).write_text(json.dumps({'frozen':a,'rust':b},indent=2))
        assert a==b,(kind,a,b)
        print('PASS',kind,flush=True)
