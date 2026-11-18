import os,sys,json,time,socket,base64,http.client,subprocess,importlib.util
from pathlib import Path
sys.dont_write_bytecode=True
repo=Path('/home/homebrew/.local/share/opencode/worktree/1600a1/rust-postgres')
spec=importlib.util.spec_from_file_location('wire',repo/'conformance/e2e/stream-slow-reader.py');w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
out=Path(sys.argv[3]);out.mkdir()
def run(binary,label):
 root=out/label;root.mkdir();path=root/'console';path.write_text('2026-11-18 INFO hello\r\n2026-11-18 INFO hello\tthere\n2026-11-18 INFO hello\u2028world\n2026-11-18 INFO hello\u2029world\n2026-11-18\t INFO bad-token\n')
 env=dict(os.environ,OMNI_ROOT=str(root),OMNI_DB_PATH=str(root/'omni.db'),OMNI_HOST='127.0.0.1',OMNI_PORT='18794',OMNI_LOG_LEVEL='error',OMNI_LOG_FILE=str(path),OMNI_ENCRYPTION_KEY='stream-test-encryption-key-0123456789')
 log=(root/'log').open('wb');p=subprocess.Popen([binary],cwd=root,env=env,stdout=log,stderr=log);cookie=''
 def api(url,body=None):
  c=http.client.HTTPConnection('127.0.0.1',18794,timeout=5);c.request('GET' if body is None else 'POST',url,None if body is None else json.dumps(body),{'cookie':cookie,'content-type':'application/json'});r=c.getresponse();data=r.read();token=r.getheader('set-cookie');c.close();return r.status,json.loads(data),token.split(';')[0] if token else ''
 def opened():
  s=socket.create_connection(('127.0.0.1',18794));s.settimeout(2);s.sendall(('GET /api/stream HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+base64.b64encode(b'the sample nonce').decode()+'\r\nCookie: '+cookie+'\r\n\r\n').encode());head=b''
  while not head.endswith(b'\r\n\r\n'):head+=w.exact(s,1)
  assert head.startswith(b'HTTP/1.1 101'),head
  return s
 def encoded(text,width=0):
  payload=text.encode();mask=b'1234';n=len(payload)
  header=bytes([129,254])+n.to_bytes(2,'big') if width==16 or (width==0 and n>=126) else bytes([129,255])+n.to_bytes(8,'big') if width==64 else bytes([129,128|n])
  return header+mask+bytes(b^mask[i%4] for i,b in enumerate(payload))
 def ask(raw):
  s=opened();s.sendall(raw);op,data=w.frame(s);s.close();return {'op':op,'hex':data.hex(),'text':data.decode(errors='replace') if op==1 else None}
 result={}
 try:
  for _ in range(1000):
   try:api('/health');break
   except OSError:time.sleep(.02)
  api('/api/setup',{'password':'stream-test-password'});cookie=api('/api/login',{'password':'stream-test-password'})[2]
  result['console']=api('/api/console')[1]['lines']
  cases={
   'surrogate-id':'{"type":"subscribe","topic":"res:logs","id":"\\ud800"}',
   'mixed-id-error':'{"type":"subscribe","topic":"stream:absent","id":"\\udc00x\\ud800\\ud83d\\ude00"}',
   'surrogate-topic':'{"type":"subscribe","topic":"res:\\ud800","id":"t"}',
   'deep-extra':'{"type":"subscribe","topic":"res:logs","extra":'+ '['*150+'0'+']'*150+'}',
   'overflow-extra':'{"type":"subscribe","topic":"res:logs","extra":1e999}',
   'duplicate-id-last-string':'{"type":"subscribe","topic":"res:logs","id":null,"id":"\\ud800"}',
   'duplicate-id-last-null':'{"type":"subscribe","topic":"res:logs","id":"\\ud800","id":null}'}
  for name,text in cases.items():result[name]=ask(encoded(text))
  normal='{"type":"subscribe","topic":"res:logs"}'
  for width in [16,64]:result['noncanonical-'+str(width)]=ask(encoded(normal,width))
   result['medium64']=ask(encoded('{"type":"subscribe","topic":"res:logs","extra":"'+'x'*200+'"}',64))
   sock=opened()
   identities=['res:'+chr(0xd800),'res:'+chr(0xdc00),'res:'+chr(0xfffd),'res:😀']
   records=[]
   for topic in identities:
    for kind in ['subscribe','unsubscribe','subscribe']:
     sock.sendall(encoded(json.dumps({'type':kind,'topic':topic})));op,data=w.frame(sock);records.append(data.hex())
   for topic in ['res:'+chr(0xd800)*124,'res:'+chr(0xd800)*125,'stream:'+chr(0xd800)]:
    sock.sendall(encoded(json.dumps({'type':'subscribe','topic':topic})));op,data=w.frame(sock);records.append(data.hex())
   sock.close();result['identities']=records
   sock=opened();raw=encoded(normal,64)
   for byte in raw:sock.sendall(bytes([byte]));time.sleep(.001)
   result['incremental64']=w.frame(sock)[1].hex();sock.close()
   result['control16']=ask(bytes([0x89,254,0,1])+b'1234'+b'I')
  for name,raw in {'rsv':b'\xc1\x80'+b'1234','continuation':b'\x80\x80'+b'1234','short-close':b'\x88\x81'+b'1234'+b'I'}.items():result[name]=ask(raw)
 finally:p.terminate();p.wait(timeout=15);log.close()
 return result
results={label:run(binary,label) for label,binary in [('frozen',sys.argv[1]),('rust',sys.argv[2])]}
(out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps({k:results['frozen'][k]==results['rust'][k] for k in results['frozen']},indent=2))

assert results["frozen"]==results["rust"],"paired mismatch"
