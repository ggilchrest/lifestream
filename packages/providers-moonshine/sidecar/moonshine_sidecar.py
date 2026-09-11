"""Single-worker, loopback-only Moonshine MLX batch STT sidecar."""
import base64
import hashlib
import json
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

RUNTIME_REVISION = os.environ.get("MOONSHINE_RUNTIME_REVISION", "mlx-audio@0.5.3")
MODEL_REVISION = os.environ.get("MOONSHINE_MODEL_REVISION", "")
MODEL_DIGEST = os.environ.get("MOONSHINE_MODEL_DIGEST", "")
MAPPING_REVISION = "moonshine-map-1"
FORMAT = {"encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1}
MAX_INPUT_SAMPLES = 480_000
MAX_BODY_BYTES = 1_500_000
READY = False
MODEL = None
LOCK = threading.Lock()


def now():
    return datetime.now(timezone.utc)


def load_once():
    global READY, MODEL
    model_path = Path(os.environ["MOONSHINE_MODEL_PATH"])
    artifact_path = model_path / "model.safetensors"
    if os.environ.get("MOONSHINE_ARTIFACTS_STAGED") != "1" or not MODEL_REVISION or not MODEL_DIGEST:
        return
    actual_digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    if actual_digest != MODEL_DIGEST:
        raise RuntimeError("Moonshine model artifact digest changed")
    from mlx_audio.stt.utils import load_model
    MODEL = load_model(model_path)
    READY = True


def validate(request):
    if request.get("protocolVersion") != "moonshine.loopback.v1":
        return "unsupportedRequest", None
    required = ("requestId", "deadlineAt", "audioInputId", "format", "sampleCount", "dataBase64")
    if any(key not in request for key in required):
        return "malformedRequest", None
    if not isinstance(request.get("requestId"), str) or not request["requestId"] or request.get("requestId") != request.get("audioInputId"):
        return "malformedRequest", None
    if request.get("format") != FORMAT:
        return "unsupportedRequest", None
    samples = request.get("sampleCount")
    if not isinstance(samples, int) or isinstance(samples, bool) or not 0 < samples <= MAX_INPUT_SAMPLES:
        return "malformedRequest", None
    try:
        deadline = datetime.fromisoformat(request["deadlineAt"].replace("Z", "+00:00"))
        if deadline <= now():
            return "deadlineExceeded", None
        pcm = base64.b64decode(request["dataBase64"], validate=True)
    except (AttributeError, TypeError, ValueError):
        return "malformedRequest", None
    if len(pcm) != samples * 2:
        return "malformedRequest", None
    return None, pcm


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 5

    def end_headers(self):
        self.send_header("connection", "close")
        self.close_connection = True
        super().end_headers()

    def json(self, status, payload):
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def events(self, payloads):
        data = "".join(json.dumps(payload, separators=(",", ":")) + "\n" for payload in payloads).encode()
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def terminal(self, request_id, outcome, samples):
        self.events([{"kind": "terminal", "sequence": 0, "requestId": request_id, "outcome": outcome, "inputSamples": samples}])

    def do_GET(self):
        if self.path == "/healthz":
            return self.json(200, {"status": "alive"})
        if self.path == "/readyz":
            return self.json(200 if READY else 503, {"status": "ready" if READY else "unavailable", "runtimeRevision": RUNTIME_REVISION, "modelRevision": MODEL_REVISION, "modelArtifactDigest": f"sha256:{MODEL_DIGEST}", "mappingRevision": MAPPING_REVISION})
        if self.path == "/v1/capabilities":
            return self.json(200, {"protocolVersion": "moonshine.loopback.v1", "contractVersion": "1.0.0", "streaming": False, "committedTranscripts": True, "workers": 1, "ready": READY, "format": FORMAT, "maxInputSamples": MAX_INPUT_SAMPLES})
        return self.json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/v1/stt/transcribe" or not READY:
            return self.json(503, {"error": "provider_unavailable"})
        request_id = "unknown"
        samples = 0
        try:
            size = int(self.headers.get("content-length", "0"))
            if not 1 < size <= MAX_BODY_BYTES:
                raise ValueError()
            request = json.loads(self.rfile.read(size))
            request_id = request.get("requestId", "unknown")
            samples = request.get("sampleCount", 0) if isinstance(request.get("sampleCount"), int) else 0
        except (ValueError, json.JSONDecodeError):
            return self.terminal(request_id, "malformedRequest", samples)
        failure, pcm = validate(request)
        if failure:
            return self.terminal(request_id, failure, samples)
        if not LOCK.acquire(False):
            return self.terminal(request_id, "providerUnavailable", samples)
        try:
            import numpy as np
            audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            result = MODEL.generate(audio, max_tokens=200, temperature=0.0, verbose=False)
            payload = {"type": "committed", "utteranceId": f"{request_id}:0", "text": result.text.strip(), "startSample": 0, "endSample": samples, "speakerRef": None, "confidence": 0}
            self.events([
                {"kind": "data", "sequence": 0, "requestId": request_id, "runtimeRevision": RUNTIME_REVISION, "modelRevision": MODEL_REVISION, "modelArtifactDigest": f"sha256:{MODEL_DIGEST}", "mappingRevision": MAPPING_REVISION, "payload": payload},
                {"kind": "terminal", "sequence": 1, "requestId": request_id, "outcome": "completed", "inputSamples": samples},
            ])
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            try:
                self.terminal(request_id, "retryableProviderFailure", samples)
            except (BrokenPipeError, ConnectionResetError):
                pass
            print(f"Moonshine transcription failed: {type(error).__name__}", flush=True)
        finally:
            LOCK.release()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    load_once()
    HTTPServer((os.environ.get("MOONSHINE_BIND", "127.0.0.1"), int(os.environ.get("MOONSHINE_PORT", "8788"))), Handler).serve_forever()
