"""Model-free extraction of actual serving classes. No real synthesis requests."""
import ast,json,socket,threading,time,unittest,tempfile,importlib.util,os,shutil,queue
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
SOURCE=Path(__file__).resolve().parents[1]/'sidecar/voxcpm_sidecar.py'
spec=importlib.util.spec_from_file_location('transport_observation',SOURCE.with_name('transport_observation.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
module=ast.parse(SOURCE.read_text())
classes=[node for node in module.body if isinstance(node,ast.ClassDef) and node.name in ['ControlServer','Handler']]
namespace={'threading':threading,'ThreadingHTTPServer':ThreadingHTTPServer,'BaseHTTPRequestHandler':BaseHTTPRequestHandler,'json':json,'time':time,'READY':True,'evaluation_http':lambda *_:False,'validate':lambda _:'malformedRequest'}
exec(compile(ast.Module(body=classes,type_ignores=[]),str(SOURCE),'exec'),namespace)
class RequestReadBoundary(unittest.TestCase):
 def setUp(self):
  self.root=tempfile.mkdtemp(prefix='control-observation-');os.chmod(self.root,0o700);self.observer=mod.Observation(self.root,int(time.time()*1000)+60000,timers=False);namespace['observe']=self.observer.emit
  self.server=namespace['ControlServer'](('127.0.0.1',0),namespace['Handler'])
  self.errors=[];self.server.handle_error=lambda *_:self.errors.append(True)
  self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
 def tearDown(self):
  self.server.shutdown();self.server.server_close();self.thread.join(timeout=2);self.observer.close();shutil.rmtree(self.root);self.assertEqual(self.errors,[])
 def test_complete_synthetic_body_has_http_headers_and_typed_terminal(self):
  with socket.create_connection(self.server.server_address,timeout=7) as connection:
   connection.sendall(b'POST /v1/tts/synthesize HTTP/1.1\r\nHost: localhost\r\nContent-Length: 7\r\n\r\n{"x":1}')
   chunks=[]
   while True:
    part=connection.recv(4096)
    if not part:break
    chunks.append(part)
   response=b''.join(chunks)
   self.assertTrue(response.startswith(b'HTTP/1.1 200'))
   self.assertIn(b'connection: close',response.lower())
   self.assertIn(b'"outcome":"malformedRequest"',response)
   rows=[json.loads(x) for x in self.observer.path.read_text().splitlines()];events=[x['event'] for x in rows];self.assertIn('body_read_begin',events);self.assertIn('body_read_complete',events);self.assertIn('headers_attempt',events);self.assertNotIn('job_enqueue',events)
 def test_deliberately_stalled_body_closes_without_http_after_five_seconds(self):
  # Artificial incomplete body, NOT evidence that the incident body stalled.
  with socket.create_connection(self.server.server_address,timeout=7) as connection:
   started=time.monotonic()
   connection.sendall(b'POST /v1/tts/synthesize HTTP/1.1\r\nHost: localhost\r\nContent-Length: 50\r\n\r\n{')
   self.assertEqual(connection.recv(4096),b'')
   elapsed=time.monotonic()-started
   self.assertGreaterEqual(elapsed,4.8);self.assertLess(elapsed,6.8)
   rows=[json.loads(x) for x in self.observer.path.read_text().splitlines()];events=[x['event'] for x in rows];self.assertIn('request_read_timeout',events);self.assertNotIn('headers_attempt',events);self.assertEqual(len({x['peerPort'] for x in rows}),1)
 def test_capacity_refusal_is_explicit_without_dispatch(self):
  for _ in range(8):self.assertTrue(self.server.clients.acquire(False))
  try:
   with socket.create_connection(self.server.server_address,timeout=2) as connection:
    connection.sendall(b'GET /synthetic HTTP/1.0\r\n\r\n')
    try:response=connection.recv(4096)
    except ConnectionResetError:response=b''
    self.assertEqual(response,b'')
   rows=[json.loads(x) for x in self.observer.path.read_text().splitlines()];self.assertEqual([x['event'] for x in rows],['capacity_refusal'])
  finally:
   for _ in range(8):self.server.clients.release()
 def test_job_enqueue_headers_and_identity_with_fake_worker_only(self):
  import http.client
  class Job:
   def __init__(self,request):
    self.done=threading.Event();self.done.set();self.cancelled=threading.Event();self.deadline=time.monotonic()+5;self.events=queue.Queue();self.events.put({'kind':'terminal','sequence':0,'outcome':'providerUnavailable','outputSamples':0,'frameCount':0})
  class Jobs:
   def put_nowait(self,job):namespace['LOCK'].release()
  original=namespace['validate'];namespace.update(validate=lambda _:None,SynthesisJob=Job,JOBS=Jobs(),LOCK=threading.Lock(),select=__import__('select'),socket=socket,queue=queue)
  try:
   connection=http.client.HTTPConnection(*self.server.server_address,timeout=2);identity='61420c1f-4e12-43c1-a6be-8e2136bf1b42:cbb69a36-412b-4c27-9b7b-28efde8e0382';connection.request('POST','/v1/tts/synthesize',json.dumps({'requestId':identity}));response=connection.getresponse();self.assertEqual(response.status,200);self.assertIn(b'providerUnavailable',response.read());connection.close()
   rows=[json.loads(x) for x in self.observer.path.read_text().splitlines()];events=[x['event'] for x in rows];self.assertLess(events.index('job_enqueue'),events.index('headers_attempt'));self.assertEqual(next(x for x in rows if x['event']=='job_enqueue')['requestId'],identity)
  finally:namespace['validate']=original
 def test_sink_bounds_redaction_and_expiry(self):
  for _ in range(600):self.observer.emit('body_read_begin',12345,'a'*36+':'+'b'*36)
  rows=[json.loads(x) for x in self.observer.path.read_text().splitlines()];self.assertEqual(len(rows),256);self.assertLessEqual(self.observer.path.stat().st_size,131072);self.assertTrue(all('requestId' not in x for x in rows));self.assertEqual(self.observer.path.stat().st_mode&0o777,0o600)
  self.observer.clock=lambda:int(time.time()*1000)+86400001;self.observer.until_ms=self.observer.clock()+10000;self.observer.emit('body_read_complete',12345);self.assertEqual(len(self.observer.path.read_text().splitlines()),1)
if __name__=='__main__':unittest.main()

