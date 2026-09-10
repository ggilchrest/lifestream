"""Single-worker, loopback-only VoxCPM2 streaming sidecar."""
import base64, json, os, threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

BACKEND = os.environ.get("VOXCPM_BACKEND", "pytorch-cuda")
RUNTIME_REVISION = os.environ.get("VOXCPM_RUNTIME_REVISION", "19b6bf7590025418821a86dcb817504e0ad7e5df")
MODEL_REVISION = os.environ.get("VOXCPM_MODEL_SNAPSHOT", "")
MAPPING_REVISION = "voxcpm2-map-1"
FORMAT = {"encoding": "pcm_s16le", "sampleRateHz": 48000, "channels": 1}
READY = False
MODEL = None
LOCK = threading.Lock()
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

def generate_audio(text, style):
    if BACKEND == "mlx":
        import mlx.core as mx
        import numpy as np
        # VoxCPM's diffusion stage is stochastic. Re-seed every bounded request
        # so the fallback does not drift from intelligible speech into a noisy
        # sample after earlier generations have advanced MLX's random state.
        mx.random.seed(0)
        for result in MODEL.generate(text=text, instruct=style, cfg_value=2.0, inference_timesteps=10):
            yield np.asarray(result.audio, dtype=np.float32)
        return
    yield from MODEL.generate_streaming(text=f"({style}){text}", cfg_value=2.0, inference_timesteps=10, retry_badcase=False)

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
    required = ("requestId","correlationId","interactionId","deadlineAt","voiceBundleKey",
                "voiceBundleRevision","text","delivery","format")
    if request.get("protocolVersion") != "voxcpm.loopback.v1": return "unsupportedRequest"
    if any(k not in request for k in required): return "malformedRequest"
    if not isinstance(request["text"], str) or not request["text"].strip(): return "malformedRequest"
    if request["voiceBundleKey"] != "fixture-voice-design" or request["voiceBundleRevision"] != 1:
        return "unsupportedRequest"
    if request["format"] != FORMAT: return "unsupportedRequest"
    try:
        if datetime.fromisoformat(request["deadlineAt"].replace("Z","+00:00")) <= now():
            return "deadlineExceeded"
    except (AttributeError, TypeError, ValueError): return "malformedRequest"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
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
        if self.path=="/healthz": return self.json(200,{"status":"alive"})
        if self.path=="/readyz": return self.json(200 if READY else 503,{"status":"ready" if READY else "unavailable","runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION,"mappingRevision":MAPPING_REVISION})
        if self.path=="/v1/capabilities": return self.json(200,{"protocolVersion":"voxcpm.loopback.v1","contractVersion":"2.0.0","streaming":True,"workers":1,"ready":READY,"format":FORMAT,"backend":BACKEND})
        self.json(404,{"error":"not_found"})
    def do_POST(self):
        if self.path!="/v1/tts/synthesize" or not READY: return self.json(503,{"error":"provider_unavailable"})
        try:
            size=int(self.headers.get("content-length","0"))
            if not 1<size<=65536: raise ValueError()
            request=json.loads(self.rfile.read(size))
        except (ValueError,json.JSONDecodeError): return self.terminal("malformedRequest")
        failure=validate(request)
        if failure: return self.terminal(failure)
        if not LOCK.acquire(False): return self.terminal("providerUnavailable")
        sequence=samples=frames=0; generator=None
        try:
            applied,degraded,style=map_delivery(request["delivery"])
            self.send_response(200); self.send_header("content-type","application/x-ndjson")
            self.send_header("cache-control","no-store"); self.send_header("connection","close"); self.end_headers()
            self.event({"kind":"preAudio","sequence":sequence,"requestId":request["requestId"],"correlationId":request["correlationId"],"voiceBundleRevision":request["voiceBundleRevision"],"requestedDelivery":request["delivery"],"appliedDelivery":applied,"degradedDimensions":degraded,"mappingRevision":MAPPING_REVISION,"effectiveSynthesis":{"voiceDesign":style,"cfgValue":2.0,"inferenceTimesteps":10,"backend":BACKEND},"format":FORMAT,"runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION})
            sequence+=1; deadline=datetime.fromisoformat(request["deadlineAt"].replace("Z","+00:00"))
            generator=generate_audio(request["text"],style)
            import numpy as np
            for wave in generator:
                if now()>=deadline:
                    self.event({"kind":"terminal","sequence":sequence,"outcome":"deadlineExceeded","outputSamples":samples,"frameCount":frames}); return
                pcm=(np.clip(wave,-1,1)*32767).astype("<i2")
                for start in range(0,len(pcm),4800):
                    chunk=pcm[start:start+4800]
                    self.event({"kind":"data","sequence":sequence,"sampleOffset":samples,"sampleCount":len(chunk),"dataBase64":base64.b64encode(chunk.tobytes()).decode(),"format":FORMAT})
                    sequence+=1; samples+=len(chunk); frames+=1
            self.event({"kind":"terminal","sequence":sequence,"outcome":"completed","outputSamples":samples,"frameCount":frames})
        except (BrokenPipeError,ConnectionResetError):
            if generator: generator.close()
        except Exception as error:
            try: self.event({"kind":"terminal","sequence":sequence,"outcome":"retryableProviderFailure","outputSamples":samples,"frameCount":frames,"errorCode":type(error).__name__})
            except (BrokenPipeError,ConnectionResetError): pass
        finally: LOCK.release()
    def log_message(self,*_): pass

if __name__=="__main__":
    load_once()
    # MLX streams are thread-local. A single-worker server also matches the
    # provider contract and prevents native generation from crossing threads.
    HTTPServer((os.environ.get("VOXCPM_BIND","127.0.0.1"),int(os.environ.get("VOXCPM_PORT","8787"))),Handler).serve_forever()
