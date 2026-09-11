"""Single-worker, loopback-only VoxCPM2 streaming sidecar."""
import base64, hashlib, json, os, threading, tempfile, wave, queue, time, select, socket
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from collections import OrderedDict

BACKEND = os.environ.get("VOXCPM_BACKEND", "pytorch-cuda")
RUNTIME_REVISION = os.environ.get("VOXCPM_RUNTIME_REVISION", "19b6bf7590025418821a86dcb817504e0ad7e5df")
MODEL_REVISION = os.environ.get("VOXCPM_MODEL_SNAPSHOT", "")
MAPPING_REVISION = "voxcpm2-map-2"
FORMAT = {"encoding": "pcm_s16le", "sampleRateHz": 48000, "channels": 1}
READY = False
MODEL = None
LOCK = threading.Lock()
WAITING = threading.BoundedSemaphore(1)
JOBS = queue.Queue(maxsize=1)
ACTIVE_JOB = None
# Only synthetic anchors, never uploaded user audio. Bounded process-local cache.
ANCHORS = OrderedDict()

class GenerationStopped(Exception):
    pass

def check_generation():
    if ACTIVE_JOB:
        if ACTIVE_JOB.cancelled.is_set(): raise GenerationStopped("cancelled")
        if time.monotonic() >= ACTIVE_JOB.deadline: raise GenerationStopped("deadlineExceeded")

class SynthesisJob:
    def __init__(self, request):
        self.request=request
        self.events=queue.Queue(maxsize=8)
        self.cancelled=threading.Event()
        self.done=threading.Event()
        self.started=time.monotonic()
        remaining=(datetime.fromisoformat(request['deadlineAt'].replace('Z','+00:00'))-now()).total_seconds()
        self.deadline=self.started+min(600,max(0,remaining))
    def event(self, payload):
        while not self.cancelled.is_set():
            if time.monotonic() >= self.deadline and payload['kind']!='terminal': raise GenerationStopped('deadlineExceeded')
            try: self.events.put(payload,timeout=.05); return
            except queue.Full:
                if time.monotonic() >= self.deadline: raise GenerationStopped('deadlineExceeded')
        raise GenerationStopped('cancelled')

def work_once(timeout=.1):
    # Called only by the process main thread in production. HTTP threads never
    # touch the model or MLX streams. One admitted job, eight queued PCM frames.
    global ACTIVE_JOB
    try: job=JOBS.get(timeout=timeout)
    except queue.Empty: return False
    ACTIVE_JOB=job
    try: Handler.generate(job,job.request)
    finally:
        ACTIVE_JOB=None;LOCK.release();job.done.set();JOBS.task_done()
    return True

class ControlServer(ThreadingHTTPServer):
    daemon_threads=True
    request_queue_size=8
    def __init__(self,*args,**kwargs):
        self.clients=threading.BoundedSemaphore(8)
        super().__init__(*args,**kwargs)
    def process_request(self,request,client_address):
        if not self.clients.acquire(False): self.shutdown_request(request); return
        try: super().process_request(request,client_address)
        except BaseException: self.clients.release(); raise
    def process_request_thread(self,request,client_address):
        try: super().process_request_thread(request,client_address)
        finally: self.clients.release()
STYLES = {
    "neutral": "A calm, clear adult voice",
    "explanation": "A clear, measured adult voice speaking helpfully",
    "reassurance": "A warm, calm adult voice with a reassuring tone",
    "concern": "A serious, attentive adult voice expressing gentle concern",
    "celebration": "An upbeat adult voice with cheerful energy",
    "warning": "A firm, urgent adult voice delivering a clear warning",
    "emergency": "A commanding adult voice, urgent and concise",
}

def now():
    return datetime.now(timezone.utc)

def load_once():
    global READY, MODEL
    if not MODEL_REVISION or os.environ.get("VOXCPM_ARTIFACTS_STAGED") != "1":
        return
    if BACKEND == "mlx":
        from mlx_audio.tts.utils import load_model
        MODEL = load_model(Path(os.environ["VOXCPM_MODEL_PATH"]))
    elif BACKEND == "pytorch-cuda":
        import torch
        if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
            raise RuntimeError("exactly one CUDA-visible logical device required")
        if "RTX 3080" not in torch.cuda.get_device_name(0):
            raise RuntimeError(f"cuda:0 is {torch.cuda.get_device_name(0)}")
        from voxcpm import VoxCPM
        MODEL = VoxCPM.from_pretrained(os.environ["VOXCPM_MODEL_PATH"], load_denoiser=False)
        warmup = MODEL.generate_streaming(text="warmup", retry_badcase=False)
        next(warmup)
        warmup.close()
    else:
        raise RuntimeError(f"unsupported VoxCPM backend: {BACKEND}")
    READY = True

def generate_audio(text, style, seed=0, reference=None):
    check_generation()
    # Only a bounded caller-supplied PCM clip is written, under a random private
    # temporary directory. It is removed on success, cancellation or failure.
    if reference:
        with tempfile.TemporaryDirectory(prefix="lifestream-voice-") as directory:
            path=os.path.join(directory,"reference.wav")
            with wave.open(path,"wb") as audio:
                audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
                audio.writeframes(base64.b64decode(reference["dataBase64"],validate=True))
            yield from generate_conditioned(text,style,seed,path,reference["transcript"])
    else:
        yield from generate_conditioned(text,style,seed)

def generate_conditioned(text, style, seed, reference_path=None, transcript=""):
    # Vox's instruct API prepends ordinary text tokens. Never put those tokens
    # in audible synthesis: render an unplayed, bounded voice anchor first,
    # then use its isolated reference-audio slot with the exact spoken text.
    import numpy as np
    if reference_path:
        # Preserve the selected reference itself, not a freshly redesigned
        # intermediate voice. Style controls are explicitly degraded below.
        yield from raw_generate(text,"",seed,reference_path,transcript)
        return
    with tempfile.TemporaryDirectory(prefix="lifestream-voice-anchor-") as directory:
        anchor_path = os.path.join(directory, "anchor.wav")
        key=(BACKEND,MODEL_REVISION,style,seed)
        cached=ANCHORS.get(key)
        if cached and time.monotonic()-cached[0]<300:
            anchor=cached[1];ANCHORS.move_to_end(key)
        else:
            chunks=[]
            for chunk in raw_generate("The voice is ready. This is a short sample.", style, seed, None, "", max_tokens=80):
                check_generation(); chunks.append(chunk)
            anchor = np.concatenate(chunks)[:48000*12]
            ANCHORS[key]=(time.monotonic(),anchor)
            while len(ANCHORS)>4: ANCHORS.popitem(last=False)
        if not len(anchor) or not np.isfinite(anchor).all():
            raise ValueError("invalid conditioning anchor")
        # Both engines consume a 16 kHz reference while generating 48 kHz PCM.
        anchor = anchor[:48000 * 12]
        anchor = anchor[:len(anchor)//3*3].reshape(-1,3).mean(axis=1)
        with wave.open(anchor_path,"wb") as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
            audio.writeframes((np.clip(anchor,-1,1)*32767).astype("<i2").tobytes())
        yield from raw_generate(text, "", seed, anchor_path, transcript, prompt_path=reference_path)

def raw_generate(text, style, seed, reference_path=None, transcript="", max_tokens=375, prompt_path=None):
    check_generation()
    if BACKEND == "mlx":
        import mlx.core as mx
        import numpy as np
        # VoxCPM's diffusion stage is stochastic. Re-seed every bounded request
        # so the fallback does not drift from intelligible speech into a noisy
        # sample after earlier generations have advanced MLX's random state.
        mx.random.seed(seed)
        conditioning = {"ref_audio":reference_path} if reference_path else {}
        if reference_path and transcript:
            conditioning.update(prompt_audio=prompt_path or reference_path,prompt_text=transcript.rstrip()+" ")
        for result in MODEL.generate(text=text, instruct=style or None, max_tokens=max_tokens, cfg_value=2.0, inference_timesteps=10, **conditioning):
            check_generation()
            yield np.asarray(result.audio, dtype=np.float32)
        return
    import torch
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    conditioning = {"reference_wav_path":reference_path} if reference_path else {}
    if reference_path and transcript:
        conditioning.update(prompt_wav_path=prompt_path or reference_path,prompt_text=transcript.rstrip()+" ")
    generator=MODEL.generate_streaming(text=f"({style}){text}" if style else text, max_len=max_tokens, cfg_value=2.0, inference_timesteps=10, retry_badcase=False, **conditioning)
    try:
        for chunk in generator:
            check_generation(); yield chunk
    finally: generator.close()

def map_delivery(delivery):
    mode, degraded = delivery.get("deliveryMode"), []
    if mode not in STYLES:
        mode = "neutral"; degraded.append("deliveryMode")
    pace, energy, urgency = delivery.get("pace"), delivery.get("energy"), delivery.get("urgency")
    if not isinstance(pace, (int, float)) or not 0 <= pace <= 1:
        pace = .5; degraded.append("pace")
    if not isinstance(energy, (int, float)) or not 0 <= energy <= 1:
        energy = .5; degraded.append("energy")
    if urgency not in ("low", "normal", "high", "critical"):
        urgency = "normal"; degraded.append("urgency")
    style = STYLES[mode]
    style += ", speaking deliberately" if pace < .35 else ", speaking briskly" if pace > .65 else ""
    style += ", with restrained energy" if energy < .35 else ", with strong energy" if energy > .65 else ""
    applied = dict(delivery)
    applied.update(deliveryMode=mode, pace=pace, energy=energy, urgency=urgency)
    return applied, sorted(set(degraded)), style

def validate(request):
    reference=request.get("voiceReference")
    if reference is not None:
        if not isinstance(reference,dict) or set(reference)!={"version","sampleRateHz","dataBase64","transcript"}: return "malformedRequest"
        if reference["version"]!="voxcpm.voice-reference.v1" or reference["sampleRateHz"]!=16000: return "unsupportedRequest"
        if not isinstance(reference["transcript"],str) or len(reference["transcript"])>1000: return "malformedRequest"
        if not isinstance(reference["dataBase64"],str) or len(reference["dataBase64"])>853336: return "malformedRequest"
        try: pcm=base64.b64decode(reference["dataBase64"],validate=True)
        except (ValueError,TypeError): return "malformedRequest"
        if len(pcm)<64000 or len(pcm)>640000 or len(pcm)%2: return "malformedRequest"
    design = request.get("voiceDesign")
    if design is not None:
        if not isinstance(design, dict) or set(design) != {"version", "description", "seed"}: return "malformedRequest"
        if design["version"] != "voxcpm.voice-design.v1": return "unsupportedRequest"
        if not isinstance(design["description"], str) or len(design["description"]) > 300 or any(ord(c) < 32 or c in "()" for c in design["description"]): return "malformedRequest"
        if type(design["seed"]) is not int or not 0 <= design["seed"] <= 2147483647: return "malformedRequest"
    required = ("requestId","correlationId","interactionId","deadlineAt","voiceBundleKey",
                "voiceBundleRevision","text","delivery","format")
    if request.get("protocolVersion") != "voxcpm.loopback.v1": return "unsupportedRequest"
    if any(k not in request for k in required): return "malformedRequest"
    if not isinstance(request["text"], str) or not request["text"].strip() or len(request["text"])>4000: return "malformedRequest"
    if request["voiceBundleKey"] != "fixture-voice-design" or request["voiceBundleRevision"] != 1:
        return "unsupportedRequest"
    if request["format"] != FORMAT: return "unsupportedRequest"
    try:
        if datetime.fromisoformat(request["deadlineAt"].replace("Z","+00:00")) <= now():
            return "deadlineExceeded"
    except (AttributeError, TypeError, ValueError): return "malformedRequest"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Network/control work is separate from the single main-thread model worker.
    timeout = 5
    def end_headers(self):
        self.send_header("connection", "close")
        self.close_connection = True
        super().end_headers()
    def json(self, status, payload):
        data=json.dumps(payload,separators=(",",":")).encode()
        self.send_response(status); self.send_header("content-type","application/json")
        self.send_header("content-length",str(len(data))); self.end_headers(); self.wfile.write(data)
    def event(self, payload):
        self.wfile.write((json.dumps(payload,separators=(",",":"))+"\n").encode()); self.wfile.flush()
    def terminal(self, outcome):
        self.send_response(200); self.send_header("content-type","application/x-ndjson")
        self.send_header("connection","close"); self.end_headers()
        self.event({"kind":"terminal","sequence":0,"outcome":outcome,"outputSamples":0,"frameCount":0})
    def do_GET(self):
        if self.path=="/healthz": return self.json(200,{"status":"alive","busy":LOCK.locked(),"queuedJobs":JOBS.qsize()})
        if self.path=="/readyz": return self.json(200 if READY else 503,{"status":"ready" if READY else "unavailable","runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION,"mappingRevision":MAPPING_REVISION})
        if self.path=="/v1/capabilities": return self.json(200,{"protocolVersion":"voxcpm.loopback.v1","contractVersion":"2.0.0","streaming":True,"workers":1,"ready":READY,"format":FORMAT,"backend":BACKEND,"spokenTextIsolation":"reference-anchor-v1","voiceDesignControl":"voxcpm.voice-design.v1","voiceReferenceControl":"voxcpm.voice-reference.v1"})
        self.json(404,{"error":"not_found"})
    def do_POST(self):
        if self.path!="/v1/tts/synthesize" or not READY: return self.json(503,{"error":"provider_unavailable"})
        try:
            size=int(self.headers.get("content-length","0"))
            if not 1<size<=1048576: raise ValueError()
            request=json.loads(self.rfile.read(size))
        except (ValueError,json.JSONDecodeError): return self.terminal("malformedRequest")
        failure=validate(request)
        if failure: return self.terminal(failure)
        if not LOCK.acquire(False):
            # One bounded successor may wait for cancelled compute to reach a
            # safe yield. Health stays independent; no parallel model calls.
            if not WAITING.acquire(False): return self.terminal('providerUnavailable')
            acquired=False
            try:
                remaining=(datetime.fromisoformat(request['deadlineAt'].replace('Z','+00:00'))-now()).total_seconds()
                until=time.monotonic()+min(5,max(0,remaining))
                while time.monotonic()<until:
                    readable,_,_=select.select([self.connection],[],[],0)
                    if readable and self.connection.recv(1,socket.MSG_PEEK)==b'': return
                    if LOCK.acquire(timeout=min(.05,max(0,until-time.monotonic()))): acquired=True;break
            finally: WAITING.release()
            if not acquired: return self.terminal('providerUnavailable')
        job=SynthesisJob(request)
        try: JOBS.put_nowait(job)
        except queue.Full: LOCK.release(); return self.terminal('providerUnavailable')
        try:
            self.send_response(200); self.send_header('content-type','application/x-ndjson')
            self.send_header('cache-control','no-store'); self.end_headers()
            next_sequence=samples=frames=0
            while True:
                # Detect peer close even when the model has not yielded. This
                # fences output now; compute stops at its next safe yield.
                readable,_,_=select.select([self.connection],[],[],0)
                if readable and self.connection.recv(1,socket.MSG_PEEK)==b'': break
                try: event=job.events.get(timeout=.05)
                except queue.Empty:
                    if job.done.is_set(): break
                    if time.monotonic()>=job.deadline:
                        self.event({'kind':'terminal','sequence':next_sequence,'outcome':'deadlineExceeded','outputSamples':samples,'frameCount':frames})
                        break
                    continue
                if event['kind']=='terminal':
                    # Completion is observable only after generator cleanup and
                    # worker release, so the next segment cannot race cleanup.
                    if not job.done.wait(max(.1,job.deadline-time.monotonic())): break
                self.event(event)
                next_sequence=event['sequence']+1
                if event['kind']=='data': samples+=event['sampleCount'];frames+=1
                if event['kind']=='terminal': break
        except (BrokenPipeError,ConnectionResetError,TimeoutError,OSError): pass
        finally: job.cancelled.set()

    def generate(self,request):
        sequence=samples=frames=0; generator=None
        try:
            applied,degraded,style=map_delivery(request["delivery"])
            design=request.get("voiceDesign", {"description":"", "seed":0})
            reference=request.get("voiceReference")
            reference_digest=hashlib.sha256(base64.b64decode(reference["dataBase64"])).hexdigest() if reference else None
            if reference:
                degraded=sorted(set(degraded+['deliveryMode','pace','energy']))
                # Keep the reference timbre; only describe the chosen delivery.
                style=style.replace("adult voice", "delivery")
            if design["description"]:
                style=design["description"] + "; " + style
            self.event({"kind":"preAudio","sequence":sequence,"requestId":request["requestId"],"correlationId":request["correlationId"],"voiceBundleRevision":request["voiceBundleRevision"],"requestedDelivery":request["delivery"],"appliedDelivery":applied,"degradedDimensions":degraded,"mappingRevision":MAPPING_REVISION,"effectiveSynthesis":{"spokenTextIsolation":"reference-anchor-v1","voiceDesign":style,"voiceDescription":design["description"],"seed":design["seed"],"referenceDigest":reference_digest,"conditioningMode":"continuation" if reference and reference["transcript"] else "reference" if reference else "description","cfgValue":2.0,"inferenceTimesteps":10,"backend":BACKEND},"format":FORMAT,"runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION})
            sequence+=1; deadline=datetime.fromisoformat(request["deadlineAt"].replace("Z","+00:00"))
            generator=generate_audio(request["text"],style,design["seed"],reference)
            import numpy as np
            for wave in generator:
                check_generation()
                if now()>=deadline:
                    self.event({"kind":"terminal","sequence":sequence,"outcome":"deadlineExceeded","outputSamples":samples,"frameCount":frames}); return
                if not np.isfinite(wave).all(): raise ValueError('non-finite generated PCM')
                pcm=(np.clip(wave,-1,1)*32767).astype("<i2")
                for start in range(0,len(pcm),4800):
                    check_generation()
                    chunk=pcm[start:start+4800]
                    self.event({"kind":"data","sequence":sequence,"sampleOffset":samples,"sampleCount":len(chunk),"dataBase64":base64.b64encode(chunk.tobytes()).decode(),"format":FORMAT})
                    sequence+=1; samples+=len(chunk); frames+=1
            self.event({"kind":"terminal","sequence":sequence,"outcome":"completed","outputSamples":samples,"frameCount":frames})
        except GenerationStopped as error:
            try: self.event({"kind":"terminal","sequence":sequence,"outcome":str(error),"outputSamples":samples,"frameCount":frames})
            except GenerationStopped: pass
        except (BrokenPipeError,ConnectionResetError,TimeoutError):
            if generator: generator.close()
        except Exception as error:
            try: self.event({"kind":"terminal","sequence":sequence,"outcome":"retryableProviderFailure","outputSamples":samples,"frameCount":frames,"errorCode":type(error).__name__})
            except (BrokenPipeError,ConnectionResetError,GenerationStopped): pass
        finally:
            if generator: generator.close()
    def log_message(self,*_): pass

if __name__=="__main__":
    server=ControlServer((os.environ.get("VOXCPM_BIND","127.0.0.1"),int(os.environ.get("VOXCPM_PORT","8787"))),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        load_once()
        while True: work_once()
    finally: server.shutdown();server.server_close()
