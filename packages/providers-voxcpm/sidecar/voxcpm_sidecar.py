"""Single-worker, loopback-only VoxCPM2 sidecar skeleton.

It intentionally refuses readiness until the staged immutable artifact manifest
and model snapshot are complete. No startup download path exists.
"""
import base64, json, os, select, socket, threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNTIME_REVISION = "19b6bf7590025418821a86dcb817504e0ad7e5df"
MODEL_REVISION = os.environ.get("VOXCPM_MODEL_SNAPSHOT", "")
MAPPING_REVISION = "voxcpm2-map-1"
READY = False
MODEL = None
LOAD_ERROR = None
MAPPING = {"neutral": "", "explanation": "Speak clearly and conversationally.", "reassurance": "Speak warmly and reassuringly.", "concern": "Speak with calm concern.", "celebration": "Speak with bright celebratory energy.", "warning": "Speak clearly with firm warning.", "emergency": "Speak urgently and clearly."}

def client_disconnected(connection):
    readable, _, _ = select.select([connection], [], [], 0)
    if not readable:
        return False
    try:
        return connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except (BlockingIOError, ConnectionResetError):
        return False

def load_once():
    global READY, MODEL, LOAD_ERROR
    if os.environ.get("CUDA_VISIBLE_DEVICES") != "1" or os.environ.get("VOXCPM_CUDA_DEVICE", "cuda:0") != "cuda:0":
        LOAD_ERROR = "gpu_profile_mismatch"; return
    if not MODEL_REVISION or os.environ.get("VOXCPM_ARTIFACTS_STAGED") != "1" or not os.path.isdir(os.environ.get("VOXCPM_MODEL_PATH", "")):
        LOAD_ERROR = "immutable_artifacts_not_staged"; return
    try:
        import torch
        if not torch.cuda.is_available() or torch.cuda.current_device() != 0:
            LOAD_ERROR = "logical_cuda_device_unavailable"; return
    except Exception:
        LOAD_ERROR = "cuda_runtime_unavailable"; return
    try:
        from voxcpm import VoxCPM
        MODEL = VoxCPM.from_pretrained(os.environ["VOXCPM_MODEL_PATH"], load_denoiser=False)
        next(MODEL.generate_streaming(text="warmup"))
        READY = True
    except Exception:
        LOAD_ERROR = "model_initialization_failed"

class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        data = json.dumps(payload).encode(); self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/healthz": return self._json(200, {"status":"alive"})
        if self.path == "/readyz": return self._json(200 if READY else 503, {"status":"ready" if READY else "unavailable", "reason":None if READY else LOAD_ERROR, "runtimeRevision":RUNTIME_REVISION, "modelRevision":MODEL_REVISION, "mappingRevision":MAPPING_REVISION, "logicalDevice":"cuda:0"})
        if self.path == "/v1/capabilities": return self._json(200, {"protocolVersion":"voxcpm.loopback.v1", "contractVersion":"2.0.0", "streaming":True, "workers":1, "ready":READY})
        self._json(404, {"error":"not_found"})
    def do_POST(self):
        if self.path != "/v1/tts/synthesize" or not READY: return self._json(503, {"error":"provider_unavailable"})
        size = int(self.headers.get("content-length", "0")); request = json.loads(self.rfile.read(min(size, 65536)))
        if request.get("protocolVersion") != "voxcpm.loopback.v1": return self._json(400, {"error":"unsupported_request"})
        mode = request["delivery"].get("deliveryMode", "neutral")
        control = MAPPING.get(mode)
        if control is None: return self._json(422, {"error":"unsupported_request"})
        self.send_response(200); self.send_header("content-type", "application/x-ndjson"); self.end_headers()
        applied = dict(request["delivery"]); degraded = []
        self.wfile.write((json.dumps({"kind":"preAudio","sequence":0,"requestId":request["requestId"],"correlationId":request["correlationId"],"voiceBundleRevision":request["voiceBundleRevision"],"requestedDelivery":request["delivery"],"appliedDelivery":applied,"degradedDimensions":degraded,"mappingRevision":MAPPING_REVISION,"effectiveSynthesis":{"controlInstruction":control,"pace":request["delivery"].get("pace"),"energy":request["delivery"].get("energy")},"format":request["format"],"runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION})+"\n").encode()); self.wfile.flush()
        sequence = 1; samples = 0
        try:
            target = f"({control}){request['text']}" if control else request["text"]
            stream = iter(MODEL.generate_streaming(text=target))
            while True:
                if client_disconnected(self.connection):
                    raise BrokenPipeError
                if datetime.now(timezone.utc).isoformat() >= request["deadlineAt"]:
                    raise TimeoutError
                try:
                    chunk = next(stream)
                except StopIteration:
                    break
                pcm = (chunk.clip(-1, 1) * 32767).astype("<i2").tobytes()
                event = {"kind":"data","sequence":sequence,"sampleOffset":samples,"sampleCount":len(pcm)//2,"dataBase64":base64.b64encode(pcm).decode("ascii"),"format":request["format"]}
                self.wfile.write((json.dumps(event)+"\n").encode()); self.wfile.flush(); samples += event["sampleCount"]; sequence += 1
            self.wfile.write((json.dumps({"kind":"terminal","sequence":sequence,"outcome":"completed","outputSamples":samples,"frameCount":sequence-1})+"\n").encode()); self.wfile.flush()
        except TimeoutError:
            self.wfile.write((json.dumps({"kind":"terminal","sequence":sequence,"outcome":"deadlineExceeded","outputSamples":samples,"frameCount":sequence-1})+"\n").encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            try: self.wfile.write((json.dumps({"kind":"terminal","sequence":sequence,"outcome":"retryableProviderFailure","outputSamples":samples,"frameCount":sequence-1})+"\n").encode()); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
    def log_message(self, *_): pass

if __name__ == "__main__":
    load_once(); ThreadingHTTPServer((os.environ.get("VOXCPM_BIND", "127.0.0.1"), int(os.environ.get("VOXCPM_PORT", "8787"))), Handler).serve_forever()
