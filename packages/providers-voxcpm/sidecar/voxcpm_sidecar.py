"""Single-worker, loopback-only VoxCPM2 sidecar skeleton.

It intentionally refuses readiness until the staged immutable artifact manifest
and model snapshot are complete. No startup download path exists.
"""
import json, os, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNTIME_REVISION = "19b6bf7590025418821a86dcb817504e0ad7e5df"
MODEL_REVISION = os.environ.get("VOXCPM_MODEL_SNAPSHOT", "")
MAPPING_REVISION = "voxcpm2-map-1"
READY = False
MODEL = None

def load_once():
    global READY, MODEL
    if not MODEL_REVISION or os.environ.get("VOXCPM_ARTIFACTS_STAGED") != "1":
        return
    from voxcpm import VoxCPM
    MODEL = VoxCPM.from_pretrained(os.environ["VOXCPM_MODEL_PATH"], load_denoiser=False)
    next(MODEL.generate_streaming(text="warmup"))
    READY = True

class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        data = json.dumps(payload).encode(); self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/healthz": return self._json(200, {"status":"alive"})
        if self.path == "/readyz": return self._json(200 if READY else 503, {"status":"ready" if READY else "unavailable", "runtimeRevision":RUNTIME_REVISION, "modelRevision":MODEL_REVISION, "mappingRevision":MAPPING_REVISION})
        if self.path == "/v1/capabilities": return self._json(200, {"protocolVersion":"voxcpm.loopback.v1", "contractVersion":"2.0.0", "streaming":True, "workers":1, "ready":READY})
        self._json(404, {"error":"not_found"})
    def do_POST(self):
        if self.path != "/v1/tts/synthesize" or not READY: return self._json(503, {"error":"provider_unavailable"})
        size = int(self.headers.get("content-length", "0")); request = json.loads(self.rfile.read(min(size, 65536)))
        if request.get("protocolVersion") != "voxcpm.loopback.v1": return self._json(400, {"error":"unsupported_request"})
        self.send_response(200); self.send_header("content-type", "application/x-ndjson"); self.end_headers()
        # The production adapter binds this generator to the staged model and
        # writes bounded PCM chunks. No unbounded buffering or download occurs.
        self.wfile.write((json.dumps({"kind":"preAudio","sequence":0,"requestId":request["requestId"],"correlationId":request["correlationId"],"voiceBundleRevision":request["voiceBundleRevision"],"requestedDelivery":request["delivery"],"appliedDelivery":request["delivery"],"degradedDimensions":[],"mappingRevision":MAPPING_REVISION,"effectiveSynthesis":{},"format":request["format"],"runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION})+"\n").encode())
    def log_message(self, *_): pass

if __name__ == "__main__":
    load_once(); ThreadingHTTPServer((os.environ.get("VOXCPM_BIND", "127.0.0.1"), int(os.environ.get("VOXCPM_PORT", "8787"))), Handler).serve_forever()
