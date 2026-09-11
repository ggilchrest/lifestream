"""Exercise single-worker HTTP lifecycle without loading models."""
import http.client
import importlib.util
from pathlib import Path
from http.server import HTTPServer
import threading
import unittest
import base64
import json
import time
import socket
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parents[1]


class SidecarHttpTest(unittest.TestCase):
    def test_mlx_patch_cancellation_restores_sampling_method(self):
        from types import SimpleNamespace
        spec=importlib.util.spec_from_file_location('mlx_cancel_test',ROOT/'packages/providers-voxcpm/sidecar/voxcpm_sidecar.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        cancelled=threading.Event();module.ACTIVE_JOB=SimpleNamespace(cancelled=cancelled,deadline=time.monotonic()+5)
        calls=[]
        def sample(value):
            calls.append(value)
            if value=='cancel':cancelled.set()
            return value
        model=SimpleNamespace(feat_decoder=SimpleNamespace(sample=sample))
        with module.guard_mlx_generation(model):
            self.assertEqual(model.feat_decoder.sample('unchanged'),'unchanged')
        self.assertIs(model.feat_decoder.sample,sample)
        with self.assertRaisesRegex(module.GenerationStopped,'cancelled'):
            with module.guard_mlx_generation(model):
                model.feat_decoder.sample('cancel')
                model.feat_decoder.sample('must-not-run')
        self.assertEqual(calls,['unchanged','cancel'])
        self.assertIs(model.feat_decoder.sample,sample)
        cancelled.clear();module.ACTIVE_JOB.deadline=time.monotonic()-1
        with self.assertRaisesRegex(module.GenerationStopped,'deadlineExceeded'):
            with module.guard_mlx_generation(model):model.feat_decoder.sample('expired')
        self.assertEqual(calls,['unchanged','cancel'])
        self.assertIs(model.feat_decoder.sample,sample)

    def test_one_successor_waits_for_cleanup_without_starving_health(self):
        import numpy as np
        spec=importlib.util.spec_from_file_location('successor_test',ROOT/'packages/providers-voxcpm/sidecar/voxcpm_sidecar.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.READY=True
        def generate(*args):
            yield np.ones(4800,dtype=np.float32)*.05
        module.generate_audio=generate
        server=module.ControlServer(('127.0.0.1',0),module.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        module.LOCK.acquire()
        worker=threading.Thread(target=lambda:module.work_once(timeout=2),daemon=True);worker.start()
        request={'protocolVersion':'voxcpm.loopback.v1','requestId':'test','correlationId':'test','interactionId':'test','deadlineAt':(datetime.now(timezone.utc)+timedelta(seconds=3)).isoformat(),'voiceBundleKey':'fixture-voice-design','voiceBundleRevision':1,'text':'Fresh request.','delivery':{},'format':module.FORMAT}
        result=[]
        def successor():
            connection=http.client.HTTPConnection(*server.server_address,timeout=3)
            try:
                connection.request('POST','/v1/tts/synthesize',json.dumps(request),{'content-type':'application/json'})
                result.extend(json.loads(line) for line in connection.getresponse().read().splitlines())
            finally: connection.close()
        client=threading.Thread(target=successor);client.start()
        try:
            time.sleep(.1)
            self.assertTrue(client.is_alive(),'successor waits instead of failing immediately')
            connection=http.client.HTTPConnection(*server.server_address,timeout=.5)
            connection.request('GET','/healthz');self.assertTrue(json.loads(connection.getresponse().read())['busy']);connection.close()
            module.LOCK.release();client.join(2);worker.join(2)
            self.assertFalse(client.is_alive());self.assertFalse(module.LOCK.locked())
            self.assertEqual(result[-1]['outcome'],'completed')
        finally:
            server.shutdown();server.server_close()

    def test_busy_model_does_not_starve_health_and_peer_close_fences_one_worker(self):
        import numpy as np
        spec=importlib.util.spec_from_file_location('control_test',ROOT/'packages/providers-voxcpm/sidecar/voxcpm_sidecar.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        module.READY=True
        entered=threading.Event();release=threading.Event();worker_done=threading.Event();calls=[]
        def generate(*args):
            calls.append(threading.get_ident());entered.set();release.wait(2)
            yield np.ones(4800,dtype=np.float32)*.05
        module.generate_audio=generate
        server=module.ControlServer(('127.0.0.1',0),module.Handler)
        http_thread=threading.Thread(target=server.serve_forever,daemon=True);http_thread.start()
        def work():
            module.work_once(timeout=2);worker_done.set()
        worker=threading.Thread(target=work,daemon=True);worker.start()
        request={'protocolVersion':'voxcpm.loopback.v1','requestId':'test','correlationId':'test','interactionId':'test','deadlineAt':(datetime.now(timezone.utc)+timedelta(seconds=5)).isoformat(),'voiceBundleKey':'fixture-voice-design','voiceBundleRevision':1,'text':'Keep the original text.','delivery':{},'format':module.FORMAT}
        client=http.client.HTTPConnection(*server.server_address,timeout=2)
        try:
            client.request('POST','/v1/tts/synthesize',json.dumps(request),{'content-type':'application/json'})
            response=client.getresponse();self.assertTrue(entered.wait(1))
            start=time.monotonic()
            health=http.client.HTTPConnection(*server.server_address,timeout=1)
            health.request('GET','/healthz');state=json.loads(health.getresponse().read());health.close()
            self.assertTrue(state['busy']);self.assertLess(time.monotonic()-start,.5)
            module.WAITING.acquire()
            other=http.client.HTTPConnection(*server.server_address,timeout=1)
            other.request('POST','/v1/tts/synthesize',json.dumps(request),{'content-type':'application/json'})
            self.assertEqual(json.loads(other.getresponse().read())['outcome'],'providerUnavailable');other.close();module.WAITING.release()
            response.fp.raw._sock.shutdown(socket.SHUT_RDWR);response.close()
            self.assertTrue(module.ACTIVE_JOB.cancelled.wait(1))
            self.assertTrue(module.LOCK.locked(),'in-flight compute remains exclusive until its safe yield')
            release.set();self.assertTrue(worker_done.wait(1));self.assertFalse(module.LOCK.locked())
            self.assertEqual(calls,[worker.ident])
            worker2=threading.Thread(target=lambda:module.work_once(timeout=2),daemon=True);worker2.start()
            fresh=http.client.HTTPConnection(*server.server_address,timeout=2)
            fresh.request('POST','/v1/tts/synthesize',json.dumps(request),{'content-type':'application/json'})
            events=[json.loads(line) for line in fresh.getresponse().read().splitlines()];fresh.close();worker2.join(2)
            self.assertEqual(events[-1]['outcome'],'completed');self.assertEqual(events[-1]['outputSamples'],4800)
        finally:
            release.set();client.close();server.shutdown();server.server_close();worker.join(2)

    def test_style_is_only_used_for_unplayed_anchor_and_temp_files_are_removed(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("Run with the existing Mac runtime Python to exercise numpy generation")
        spec=importlib.util.spec_from_file_location("anchor_test",ROOT / "packages/providers-voxcpm/sidecar/voxcpm_sidecar.py")
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        calls=[]
        def generate(text,style,seed,reference_path=None,transcript="",max_tokens=375,prompt_path=None):
            calls.append((text,style,reference_path,transcript,prompt_path))
            yield np.ones(48000*3,dtype=np.float32)*.05
        module.raw_generate=generate
        generator=module.generate_conditioned("Only speak these words.","warm reassuring tone",42)
        next(generator)
        self.assertEqual(len(calls),2)
        self.assertEqual(calls[0][1],"warm reassuring tone")
        self.assertEqual(calls[1][0],"Only speak these words.")
        self.assertEqual(calls[1][1],"")
        self.assertIsNone(calls[1][4])
        anchor=Path(calls[1][2]);self.assertTrue(anchor.exists())
        generator.close();self.assertFalse(anchor.exists())
        list(module.generate_conditioned("A second sentence.","warm reassuring tone",42))
        self.assertEqual(len(calls),3,"synthetic anchor is reused, not regenerated per sentence")
        list(module.generate_conditioned("Keep the selected voice.","ignored delivery",42,"/original.wav","original transcript"))
        self.assertEqual(calls[-1],("Keep the selected voice.","","/original.wav","original transcript",None))

    def test_reference_validation_and_temporary_file_cleanup(self):
        path = ROOT / "packages/providers-voxcpm/sidecar/voxcpm_sidecar.py"
        spec = importlib.util.spec_from_file_location("voice_reference", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        reference = {"version":"voxcpm.voice-reference.v1", "sampleRateHz":16000, "dataBase64":base64.b64encode(bytes(64000)).decode(), "transcript":""}
        request = {"protocolVersion":"voxcpm.loopback.v1", "requestId":"test", "correlationId":"test", "interactionId":"test", "deadlineAt":(datetime.now(timezone.utc)+timedelta(seconds=20)).isoformat(), "voiceBundleKey":"fixture-voice-design", "voiceBundleRevision":1, "text":"hello", "delivery":{}, "format":module.FORMAT, "voiceReference":reference}
        self.assertIsNone(module.validate(request))
        self.assertEqual(module.validate({**request,"voiceReference":{**reference,"dataBase64":"bad"}}),"malformedRequest")
        self.assertEqual(module.validate({**request,"voiceDesign":{"version":"voxcpm.voice-design.v1","description":"ok","seed":True}}),"malformedRequest")
        paths = []
        def fake_generate(text, style, seed, reference_path=None, transcript=""):
            paths.append(Path(reference_path))
            self.assertTrue(paths[-1].exists())
            yield "audio"
            yield "more audio"
        module.generate_conditioned = fake_generate
        generator = module.generate_audio("hello","neutral",0,reference)
        self.assertEqual(next(generator),"audio")
        generator.close()
        self.assertFalse(paths[0].exists())
        self.assertFalse(paths[0].parent.exists())

    def test_idle_health_connection_does_not_block_the_next_client(self):
        for name in ("voxcpm", "moonshine"):
            with self.subTest(provider=name):
                path = ROOT / f"packages/providers-{name}/sidecar/{name}_sidecar.py"
                spec = importlib.util.spec_from_file_location(name, path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                server = HTTPServer(("127.0.0.1", 0), module.Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                first = http.client.HTTPConnection(*server.server_address, timeout=2)
                second = http.client.HTTPConnection(*server.server_address, timeout=2)
                try:
                    first.request("GET", "/healthz")
                    response = first.getresponse()
                    self.assertEqual(response.getheader("connection"), "close")
                    response.read()
                    for _ in range(4):
                        second.request("GET", "/healthz")
                        result = second.getresponse()
                        self.assertEqual(result.status, 200)
                        result.read()
                finally:
                    first.close()
                    second.close()
                    server.shutdown()
                    server.server_close()
                    thread.join(2)


if __name__ == "__main__":
    unittest.main()
