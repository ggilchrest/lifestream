"""Single-worker, loopback-only VoxCPM2 streaming sidecar."""
import io, re, subprocess, uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse
import base64, hashlib, json, os, threading, tempfile, wave, queue, time, select, socket
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from collections import OrderedDict
from contextlib import contextmanager

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

@contextmanager
def guard_mlx_generation(model):
    # MLX-Audio 0.5.3 yields only after decoding the complete sentence. Check
    # cancellation between its existing feature-sampling patches instead of
    # holding admission until that final yield. No decoder/numerics changes.
    decoder=model.feat_decoder
    original=decoder.sample
    def guarded(*args,**kwargs):
        check_generation()
        result=original(*args,**kwargs)
        check_generation()
        return result
    decoder.sample=guarded
    try: yield
    finally: decoder.sample=original

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
    try:
        with MODEL_LOCK: Handler.generate(job,job.request)
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

def synthesis_settings():
    request = getattr(ACTIVE_JOB, "request", {}) if ACTIVE_JOB else {}
    return request.get("synthesisSettings", {"inferenceTimesteps":10, "cfgValue":2.0})


def now():
    return datetime.now(timezone.utc)


MODEL_LOCK = threading.RLock()
EVALUATION = None
DEVICE_IDENTITY = None
EVALUATION_SAMPLE_RATE = 48000
CHECKPOINT_KEY = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
REFERENCE_KEY = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$")
STEP_DIRECTORY = re.compile(r"^step_(\d+)$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
OUTPUT_NAME = re.compile(r"^[0-9a-f]{32}\.wav$")
MIN_REFERENCE_SECONDS = 0.25
MAX_REFERENCE_SECONDS = 30.0
MAX_REFERENCE_BYTES = int(MAX_REFERENCE_SECONDS * 16000 * 2) + 4096

def evaluation_requested():
    return any(os.environ.get(name) for name in ("VOXCPM_CHECKPOINT_MANIFEST", "VOXCPM_CHECKPOINT_ROOT", "VOXCPM_REFERENCE_MANIFEST", "VOXCPM_DEFAULTS_MANIFEST"))

def initialize_evaluation(model):
    global EVALUATION, READY
    base_digest = os.environ.get("VOXCPM_BASE_DIGEST") or "sha256:" + hashlib.sha256(MODEL_REVISION.encode()).hexdigest()
    checkpoints = load_checkpoint_registry(os.environ.get("VOXCPM_CHECKPOINT_MANIFEST"), base_digest, os.environ.get("VOXCPM_CHECKPOINT_ROOT"))
    references = load_reference_registry(os.environ.get("VOXCPM_REFERENCE_MANIFEST"))
    runtime = EvaluationRuntime(model, checkpoints, references, Path(os.environ.get("VOXCPM_EVALUATION_OUTPUT_DIR", "/var/lib/voxcpm-evaluation")))
    try:
        with MODEL_LOCK:
            runtime._warmup()
            if os.environ.get("VOXCPM_DEFAULTS_MANIFEST"):
                runtime.configure_defaults(_load_json_file(os.environ["VOXCPM_DEFAULTS_MANIFEST"], "service defaults"))
            EVALUATION = runtime
    except Exception:
        READY = False
        raise

def synthesis_reference(request):
    if not EVALUATION:
        if "checkpointKey" in request or "referenceVoiceId" in request:
            raise ApiError(503, "registry_unavailable", "voice registry is unavailable")
        return request.get("voiceReference"), None
    checkpoint, reference = EVALUATION.resolve_synthesis(request)
    EVALUATION._select_locked(checkpoint)
    if reference:
        with wave.open(str(reference.path), "rb") as audio:
            pcm = audio.readframes(audio.getnframes())
        return {"version":"voxcpm.voice-reference.v1", "sampleRateHz":16000, "dataBase64":base64.b64encode(pcm).decode(), "transcript":""}, reference.digest
    return request.get("voiceReference"), None

def evaluation_http(handler, method):
    path = urlparse(handler.path).path
    if not path.startswith("/v1/evaluation/"):
        return False
    if not EVALUATION:
        handler.json(404, {"error":{"code":"not_found", "message":"not found"}})
        return True
    acquired = False
    try:
        if method == "GET":
            if path == "/v1/evaluation/checkpoints": handler.json(200, EVALUATION.catalog())
            elif path == "/v1/evaluation/references": handler.json(200, EVALUATION.reference_catalog())
            elif re.fullmatch(r"/v1/evaluation/jobs/[0-9a-f]{32}", path): handler.json(200, EVALUATION.job(path.rsplit("/",1)[-1]))
            elif path.startswith("/v1/evaluation/output/"):
                data = EVALUATION.output(path.rsplit("/",1)[-1])
                handler.send_response(200); handler.send_header("content-type","audio/wav"); handler.send_header("cache-control","no-store"); handler.send_header("content-length",str(len(data))); handler.end_headers(); handler.wfile.write(data)
            else: handler.json(404, {"error":{"code":"not_found", "message":"not found"}})
        else:
            size = int(handler.headers.get("content-length", "0"))
            if not 1 < size <= 2*1024*1024: raise ApiError(400,"malformed_request","request body must be bounded JSON")
            body = json.loads(handler.rfile.read(size))
            acquired = LOCK.acquire(False)
            if not acquired: raise ApiError(503,"provider_unavailable","VoxCPM worker is busy")
            if path == "/v1/evaluation/select":
                if not isinstance(body,dict) or set(body)!={"key","expectedDigest"}: raise ApiError(422,"invalid_request","invalid selection request")
                active, elapsed = EVALUATION.select(body["key"],body["expectedDigest"])
                handler.json(200,{"active":active,"state":"ready","switchSeconds":elapsed})
            elif path == "/v1/evaluation/generate": handler.json(200,EVALUATION.generate(body))
            elif path == "/v1/evaluation/evaluate": handler.json(202,EVALUATION.evaluate(body))
            else: handler.json(404,{"error":{"code":"not_found","message":"not found"}})
    except ApiError as error: handler.json(error.status,{"error":{"code":error.code,"message":error.safe_message}})
    except (ValueError,TypeError,json.JSONDecodeError): handler.json(400,{"error":{"code":"malformed_request","message":"request body must be bounded JSON"}})
    except Exception: handler.json(503,{"error":{"code":"provider_unavailable","message":"VoxCPM evaluation is unavailable"}})
    finally:
        if acquired: LOCK.release()
    return True

class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.safe_message = status, code, message


@dataclass(frozen=True)
class Checkpoint:
    key: str
    label: str
    revision: str
    digest: str
    kind: str
    path: Path | None

    def public(self) -> dict[str, str]:
        return {"key": self.key, "label": self.label, "revision": self.revision, "digest": self.digest, "kind": self.kind}

    def identity(self) -> dict[str, str]:
        return {"key": self.key, "revision": self.revision, "digest": self.digest}


@dataclass(frozen=True)
class Reference:
    source_id: str
    key: str
    label: str
    transcript: str
    sample_rate: int
    duration: float
    digest: str
    path: Path

    def public(self) -> dict[str, Any]:
        return {"sourceId": self.source_id, "referenceKey": self.key, "key": self.key, "label": self.label, "transcript": self.transcript, "duration": self.duration, "digest": self.digest}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def valid_reference_key(value: Any) -> bool:
    return isinstance(value, str) and bool(REFERENCE_KEY.fullmatch(value)) and ".." not in value


def _load_json_file(path: str, label: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"invalid {label} manifest") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid {label} manifest")
    return value


def _checkpoint_artifact(path: Path) -> Path | None:
    if path.is_file() and path.suffix in (".safetensors", ".ckpt"):
        return path
    if path.is_dir():
        for name in ("lora_weights.safetensors", "lora_weights.ckpt"):
            candidate = path / name
            if candidate.is_file():
                return candidate
    return None


def load_checkpoint_registry(path: str | None, base_digest: str | None = None, checkpoint_root: str | None = None) -> dict[str, Checkpoint]:
    if path is None:
        if not base_digest or not DIGEST.fullmatch(base_digest):
            raise RuntimeError("VOXCPM_CHECKPOINT_MANIFEST is required for evaluation")
        raw: dict[str, Any] = {"base": {"kind": "base", "label": "Base VoxCPM2", "revision": "base", "digest": base_digest}}
    else:
        raw = _load_json_file(path, "checkpoint")
    result: dict[str, Checkpoint] = {}
    for key, item in raw.items():
        if not isinstance(key, str) or not CHECKPOINT_KEY.fullmatch(key) or not isinstance(item, dict):
            raise RuntimeError("invalid checkpoint registry entry")
        if set(item) - {"kind", "label", "revision", "path", "digest"}:
            raise RuntimeError("invalid checkpoint registry entry")
        kind, label = item.get("kind"), item.get("label")
        revision, digest = item.get("revision", key), item.get("digest")
        if kind not in ("base", "lora") or not isinstance(label, str) or not label.strip():
            raise RuntimeError("invalid checkpoint registry entry")
        if not isinstance(revision, str) or not CHECKPOINT_KEY.fullmatch(revision):
            raise RuntimeError("invalid checkpoint registry entry")
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise RuntimeError("invalid checkpoint registry entry")
        checkpoint_path = item.get("path")
        resolved = None
        if kind == "lora":
            if not isinstance(checkpoint_path, str) or not Path(checkpoint_path).is_absolute():
                raise RuntimeError("LoRA checkpoint paths must be absolute")
            resolved = Path(checkpoint_path).resolve(strict=False)
        elif checkpoint_path is not None and not isinstance(checkpoint_path, str):
            raise RuntimeError("invalid checkpoint registry entry")
        result[key] = Checkpoint(key, label.strip(), revision, digest, kind, resolved)
    if "base" not in result or result["base"].kind != "base" or sum(item.kind == "base" for item in result.values()) != 1:
        raise RuntimeError("checkpoint registry requires exactly one base entry named base")
    if checkpoint_root:
        root = Path(checkpoint_root).resolve(strict=True)
        if not root.is_dir():
            raise RuntimeError("VOXCPM_CHECKPOINT_ROOT must be a directory")
        for directory in sorted(root.iterdir(), key=lambda item: item.name):
            match = STEP_DIRECTORY.fullmatch(directory.name)
            artifact = _checkpoint_artifact(directory) if match else None
            if not match or artifact is None:
                continue
            step = int(match.group(1))
            key = f"step-{step:05d}"
            if not CHECKPOINT_KEY.fullmatch(key):
                raise RuntimeError("invalid discovered checkpoint key")
            digest = sha256_file(artifact)
            discovered = Checkpoint(key, f"Step {step}", key, digest, "lora", directory.resolve(strict=True))
            existing = result.get(key)
            if existing and (existing.kind != "lora" or existing.digest != digest or existing.path != discovered.path):
                raise RuntimeError(f"checkpoint registry conflicts with discovered {key}")
            result[key] = existing or discovered
    base = result.pop("base")
    return {"base": base, **dict(sorted(result.items()))}


def inspect_reference_audio(data: bytes) -> tuple[int, float, str]:
    if len(data) > MAX_REFERENCE_BYTES:
        raise ApiError(422, "invalid_reference", "reference audio exceeds the duration limit")
    try:
        with wave.open(io.BytesIO(data), "rb") as audio:
            if audio.getcomptype() != "NONE" or audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getframerate() != 16000:
                raise ApiError(422, "invalid_reference", "reference audio must be 16 kHz mono PCM16 WAV")
            frames = audio.getnframes()
            duration = frames / audio.getframerate()
            if not MIN_REFERENCE_SECONDS <= duration <= MAX_REFERENCE_SECONDS:
                raise ApiError(422, "invalid_reference", "reference audio duration is outside the allowed range")
            if len(audio.readframes(frames)) != frames * 2:
                raise ApiError(422, "invalid_reference", "reference WAV content is truncated")
    except (EOFError, wave.Error) as error:
        raise ApiError(422, "invalid_reference", "reference audio must be a valid PCM WAV") from error
    return 16000, duration, "sha256:" + hashlib.sha256(data).hexdigest()


def reference_from_path(source_id: str, key: str, path: Path, label: str | None = None, transcript: str = "") -> Reference:
    try:
        data = path.read_bytes()
    except OSError as error:
        raise RuntimeError("reference audio is unavailable") from error
    try:
        sample_rate, duration, digest = inspect_reference_audio(data)
    except ApiError as error:
        raise RuntimeError("reference audio is invalid") from error
    return Reference(source_id, key, (label or source_id).strip(), transcript, sample_rate, duration, digest, path.resolve(strict=True))


def valid_source_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 256 and ".." not in value and "/" not in value and "\\" not in value and not any(ord(character) < 32 for character in value)


def load_reference_registry(path: str | None) -> dict[str, Reference]:
    if not path:
        return {}
    raw = _load_json_file(path, "reference")
    result: dict[str, Reference] = {}
    source_ids: set[str] = set()
    for source_id, value in raw.items():
        required = {"referenceKey", "path", "digest", "transcript", "duration"}
        if not valid_source_id(source_id) or not isinstance(value, dict) or set(value) - (required | {"label"}) or not required <= set(value):
            raise RuntimeError("invalid reference registry entry")
        key, candidate, expected_digest = value["referenceKey"], value["path"], value["digest"]
        label, transcript, expected_duration = value.get("label", source_id), value["transcript"], value["duration"]
        if not valid_reference_key(key) or not key.startswith("ref-") or key in result or source_id in source_ids:
            raise RuntimeError("invalid reference registry entry")
        if not isinstance(candidate, str) or not Path(candidate).is_absolute() or not isinstance(expected_digest, str) or not DIGEST.fullmatch(expected_digest) or not isinstance(label, str) or not label.strip() or not isinstance(transcript, str) or not isinstance(expected_duration, (int, float)):
            raise RuntimeError("invalid reference registry entry")
        loaded = reference_from_path(source_id, key, Path(candidate), label, transcript)
        if loaded.digest != expected_digest or abs(loaded.duration - expected_duration) > 0.001:
            raise RuntimeError("reference registry digest or duration mismatch")
        result[key] = loaded
        source_ids.add(source_id)
    return result


def validate_reference_audio(path: Path) -> None:
    try:
        inspect_reference_audio(path.read_bytes())
    except OSError as error:
        raise ApiError(422, "invalid_reference", "reference audio is unavailable or invalid") from error


def parse_gpu_inventory(text: str) -> list[dict[str, Any]]:
    devices = []
    for line in text.splitlines():
        fields = [field.strip() for field in line.split(",")]
        if len(fields) != 5:
            continue
        try:
            devices.append({"index": int(fields[0]), "uuid": fields[1], "name": fields[2], "memoryMiB": int(fields[3]), "pciBusId": fields[4]})
        except ValueError:
            continue
    return devices


def resolve_gpu_identity(inventory: list[dict[str, Any]], visible_device: str) -> dict[str, Any]:
    tokens = [token.strip() for token in visible_device.split(",") if token.strip()]
    if len(tokens) != 1:
        raise RuntimeError("exactly one CUDA device must be selected")
    token = tokens[0]
    matches = [gpu for gpu in inventory if str(gpu["index"]) == token or gpu["uuid"] == token]
    if len(matches) != 1:
        raise RuntimeError("configured CUDA device does not resolve to one physical GPU")
    return dict(matches[0])


def enforce_device_policy(policy_path: str, profile: str, visible_device: str, inventory_text: str | None = None) -> dict[str, Any]:
    policy = _load_json_file(policy_path, "device policy")
    profiles = policy.get("profiles")
    if not isinstance(profiles, dict) or profile not in profiles or not isinstance(profiles[profile], dict):
        raise RuntimeError("unknown VoxCPM device profile")
    configured = profiles[profile]
    if set(configured) != {"allowedNames", "minimumVramMiB"} or not isinstance(configured["allowedNames"], list):
        raise RuntimeError("invalid VoxCPM device profile")
    if inventory_text is None:
        inventory_text = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid,name,memory.total,pci.bus_id", "--format=csv,noheader,nounits"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout
    identity = resolve_gpu_identity(parse_gpu_inventory(inventory_text), visible_device)
    if identity["name"] not in configured["allowedNames"] or identity["memoryMiB"] < configured["minimumVramMiB"]:
        raise RuntimeError(f"GPU is not approved for profile {profile}")
    return identity


class EvaluationRuntime:
    def __init__(self, model: Any, checkpoints: dict[str, Checkpoint], references: dict[str, Reference | Path], output_directory: Path):
        self.model, self.checkpoints = model, checkpoints
        self.output_directory = output_directory.resolve(strict=False)
        self.output_directory.mkdir(parents=True, exist_ok=True)
        self.references: dict[str, Reference] = {
            key: value if isinstance(value, Reference) else reference_from_path(key, key, value)
            for key, value in references.items()
        }
        self.reference_ids = {reference.source_id: reference for reference in self.references.values()}
        self.active = checkpoints["base"]
        self.default_checkpoint = checkpoints["base"]
        self.default_reference = None
        self.jobs: dict[str, dict[str, Any]] = {}
        self._jobs_lock = threading.Lock()

    def configure_defaults(self, policy: dict[str, Any]) -> None:
        if not isinstance(policy, dict) or set(policy) != {"checkpointKey", "checkpointDigest", "referenceVoiceId", "referenceDigest"}:
            raise RuntimeError("invalid service voice defaults")
        checkpoint = self._checkpoint(policy["checkpointKey"])
        reference = self._resolve_reference(policy["referenceVoiceId"])
        if checkpoint.digest != policy["checkpointDigest"] or reference.digest != policy["referenceDigest"]:
            raise RuntimeError("service voice default digest mismatch")
        self._verify_reference(reference)
        with MODEL_LOCK:
            self._select_locked(checkpoint)
            self.default_checkpoint, self.default_reference = checkpoint, reference

    def default_identity(self) -> dict[str, Any]:
        return {"checkpoint": self.default_checkpoint.identity(), "referenceKey": self.default_reference.key if self.default_reference else None,
                "referenceDigest": self.default_reference.digest if self.default_reference else None,
                "conditioningMode": "reference" if self.default_reference else None}

    def with_defaults(self, body: Any) -> Any:
        if not isinstance(body, dict):
            return body
        result = dict(body)
        result.setdefault("checkpointKey", self.default_checkpoint.key)
        if self.default_reference:
            result.setdefault("referenceVoiceId", self.default_reference.key)
        return result

    def resolve_synthesis(self, body: dict[str, Any]) -> tuple[Checkpoint, Reference | None]:
        # Presence, not truthiness, controls overrides: explicit base and null
        # reference are meaningful. Every omitted request re-resolves policy;
        # evaluation hot-swaps never mutate the configured service defaults.
        checkpoint = self._checkpoint(body["checkpointKey"] if "checkpointKey" in body else self.default_checkpoint.key)
        if "voiceReference" in body and "referenceVoiceId" in body:
            raise ApiError(422, "invalid_request", "choose one reference override")
        if "voiceReference" in body:
            reference = None
        elif "referenceVoiceId" in body:
            reference = None if body["referenceVoiceId"] is None else self._resolve_reference(body["referenceVoiceId"])
        else:
            reference = self.default_reference
        if reference:
            self._verify_reference(reference)
        return checkpoint, reference

    @staticmethod
    def _write_json(path: Path, value: Any) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        os.replace(temporary, path)

    def catalog(self) -> dict[str, Any]:
        return {"checkpoints": [item.public() for item in self.checkpoints.values()], "active": self.active.identity(), "capabilities": {"hotSwap": True}, "defaults": self.default_identity()}

    def reference_catalog(self) -> dict[str, Any]:
        return {"references": [reference.public() for reference in sorted(self.references.values(), key=lambda item: item.source_id)], "defaults": self.default_identity()}

    def _checkpoint(self, key: Any) -> Checkpoint:
        if not isinstance(key, str) or not CHECKPOINT_KEY.fullmatch(key) or key not in self.checkpoints:
            raise ApiError(404, "unknown_checkpoint", "checkpoint is not approved")
        return self.checkpoints[key]

    def _weights_path(self, checkpoint: Checkpoint) -> Path:
        assert checkpoint.path is not None
        candidate = checkpoint.path
        if candidate.is_dir():
            safetensors = candidate / "lora_weights.safetensors"
            candidate = safetensors if safetensors.is_file() else candidate / "lora_weights.ckpt"
        try:
            return candidate.resolve(strict=True)
        except OSError as error:
            raise ApiError(503, "checkpoint_unavailable", "checkpoint artifact is unavailable") from error

    def _verify_weights(self, checkpoint: Checkpoint) -> Path:
        candidate = self._weights_path(checkpoint)
        actual = "sha256:" + hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual != checkpoint.digest:
            raise ApiError(409, "checkpoint_digest_mismatch", "checkpoint artifact digest does not match the registry")
        return candidate

    def _warmup(self) -> None:
        stream = self.model.generate_streaming(text="warmup", max_len=20, retry_badcase=False)
        try:
            next(stream)
        finally:
            stream.close()

    def _select_locked(self, checkpoint: Checkpoint) -> tuple[dict[str, str], float]:
        global READY
        if self.active.key == checkpoint.key:
            return self.active.identity(), 0.0
        started = time.perf_counter()
        READY = False
        try:
            self.model.set_lora_enabled(False)
            self.model.unload_lora()
            if checkpoint.kind == "lora":
                weights = self._verify_weights(checkpoint)
                loaded, skipped = self.model.load_lora(str(weights))
                if not loaded or skipped:
                    raise ApiError(422, "invalid_checkpoint", "checkpoint did not match the configured LoRA architecture")
                self.model.set_lora_enabled(True)
            self._warmup()
            self.active = checkpoint
            READY = True
            return checkpoint.identity(), time.perf_counter() - started
        except Exception:
            try:
                self.model.set_lora_enabled(False); self.model.unload_lora(); self._warmup()
                self.active = self.checkpoints["base"]; READY = True
            except Exception:
                READY = False
            raise

    def select(self, key: Any, expected_digest: Any) -> tuple[dict[str, str], float]:
        checkpoint = self._checkpoint(key)
        if expected_digest != checkpoint.digest:
            raise ApiError(409, "expected_digest_mismatch", "expected digest does not match the approved checkpoint")
        with MODEL_LOCK:
            return self._select_locked(checkpoint)

    def _resolve_reference(self, reference_id: Any) -> Reference:
        reference = self.references.get(reference_id) if isinstance(reference_id, str) else None
        reference = reference or (self.reference_ids.get(reference_id) if isinstance(reference_id, str) else None)
        if not reference:
            raise ApiError(404, "unknown_reference", "reference voice is not approved")
        return reference

    @staticmethod
    def _verify_reference(reference: Reference) -> None:
        try:
            _sample_rate, _duration, actual_digest = inspect_reference_audio(reference.path.read_bytes())
        except OSError as error:
            raise ApiError(503, "reference_unavailable", "reference audio is unavailable") from error
        if actual_digest != reference.digest:
            raise ApiError(409, "reference_digest_mismatch", "reference audio digest does not match the registry")

    @staticmethod
    def validate_generation(body: Any) -> tuple[str, Any, str, dict[str, Any], Any, str | None]:
        allowed = {"checkpointKey", "referenceVoiceId", "text", "settings", "expectedDigest", "toneSuggestion"}
        if not isinstance(body, dict) or set(body) - allowed or not {"checkpointKey", "referenceVoiceId", "text", "settings"} <= set(body):
            raise ApiError(422, "invalid_request", "invalid evaluation request")
        text, settings = body["text"], body["settings"]
        if not isinstance(text, str) or not text.strip() or len(text) > 1000 or not isinstance(settings, dict) or set(settings) != {"cfg", "timesteps", "seed"}:
            raise ApiError(422, "invalid_request", "invalid evaluation request")
        cfg, timesteps, seed = settings["cfg"], settings["timesteps"], settings["seed"]
        if isinstance(cfg, bool) or not isinstance(cfg, (int, float)) or not 0 < cfg <= 10:
            raise ApiError(422, "invalid_request", "cfg must be between 0 and 10")
        if type(timesteps) is not int or not 1 <= timesteps <= 100 or type(seed) is not int or not 0 <= seed <= 2147483647:
            raise ApiError(422, "invalid_request", "invalid evaluation settings")
        tone = body.get("toneSuggestion")
        if tone is not None and (not isinstance(tone, str) or len(tone) > 500):
            raise ApiError(422, "invalid_request", "invalid tone suggestion")
        return body["checkpointKey"], body["referenceVoiceId"], text.strip(), {"cfg": cfg, "timesteps": timesteps, "seed": seed}, body.get("expectedDigest"), tone

    @staticmethod
    def _generation_kwargs(reference: Reference, text: str, settings: dict[str, Any]) -> dict[str, Any]:
        return {"text": text, "cfg_value": settings["cfg"], "inference_timesteps": settings["timesteps"], "retry_badcase": False, "reference_wav_path": str(reference.path)}

    @staticmethod
    def _controlled_text(text: str, tone_suggestion: str | None) -> tuple[str, str]:
        normalized_tone = tone_suggestion.strip() if tone_suggestion is not None else ""
        return normalized_tone, f"({normalized_tone}) {text}" if normalized_tone else text

    def _render_pcm(self, reference: Reference, text: str, settings: dict[str, Any]) -> bytes:
        import numpy as np
        import torch
        torch.manual_seed(settings["seed"]); torch.cuda.manual_seed_all(settings["seed"])
        chunks = list(self.model.generate_streaming(**self._generation_kwargs(reference, text, settings)))
        audio = np.concatenate(chunks) if chunks else np.empty(0, dtype=np.float32)
        if not len(audio) or not np.isfinite(audio).all():
            raise ApiError(503, "generation_failed", "VoxCPM returned invalid audio")
        return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()

    def _generate_locked(self, checkpoint: Checkpoint, reference: Reference, text: str, settings: dict[str, Any], expected_digest: Any = None, tone_suggestion: str | None = None) -> dict[str, Any]:
        if self.active.key != checkpoint.key or self.active.digest != checkpoint.digest:
            raise ApiError(409, "active_checkpoint_mismatch", "active checkpoint does not match the requested checkpoint")
        self._verify_reference(reference)
        started = time.perf_counter()
        normalized_tone, final_text = self._controlled_text(text, tone_suggestion)
        pcm = self._render_pcm(reference, final_text, settings)
        output_id = uuid.uuid4().hex
        output = self.output_directory / f"{output_id}.wav"
        with wave.open(str(output), "wb") as target:
            target.setnchannels(1); target.setsampwidth(2); target.setframerate(EVALUATION_SAMPLE_RATE); target.writeframes(pcm)
        provenance = {"checkpointKey": checkpoint.key, "checkpointDigest": checkpoint.digest, "referenceVoiceId": reference.source_id, "referenceKey": reference.key, "referenceDigest": reference.digest, "settings": settings, "finalText": final_text, "runtimeRevision": RUNTIME_REVISION, "modelRevision": MODEL_REVISION, "generationSeconds": time.perf_counter() - started}
        if expected_digest is not None: provenance["expectedDigest"] = expected_digest
        if tone_suggestion is not None: provenance["toneSuggestion"] = normalized_tone
        self._write_json(self.output_directory / f"{output_id}.json", provenance)
        public = {"audioUrl": f"/v1/evaluation/output/{output_id}.wav", **{key: provenance[key] for key in ("checkpointKey", "checkpointDigest", "referenceVoiceId", "referenceKey", "referenceDigest", "settings", "finalText")}, "generationSeconds": provenance["generationSeconds"]}
        if expected_digest is not None: public["expectedDigest"] = expected_digest
        if tone_suggestion is not None: public["toneSuggestion"] = normalized_tone
        return public

    def generate(self, body: Any) -> dict[str, Any]:
        key, reference_id, text, settings, expected_digest, tone = self.validate_generation(self.with_defaults(body))
        checkpoint = self._checkpoint(key)
        if expected_digest is not None and expected_digest != checkpoint.digest:
            raise ApiError(409, "expected_digest_mismatch", "expected digest does not match the approved checkpoint")
        reference = self._resolve_reference(reference_id)
        with MODEL_LOCK:
            self._select_locked(checkpoint)
            return self._generate_locked(checkpoint, reference, text, settings, expected_digest, tone)

    def evaluate(self, body: Any) -> dict[str, Any]:
        key, reference_id, text, settings, expected_digest, tone = self.validate_generation(self.with_defaults(body))
        if key != "all": raise ApiError(422, "invalid_request", "checkpointKey must be all")
        if expected_digest is not None:
            raise ApiError(422, "invalid_request", "expectedDigest is not valid when checkpointKey is all")
        reference = self._resolve_reference(reference_id)
        self._verify_reference(reference)
        job_id = uuid.uuid4().hex
        record = {"jobId": job_id, "state": "queued", "outputs": [], "referenceVoiceId": reference.source_id, "referenceKey": reference.key, "referenceDigest": reference.digest, "settings": settings}
        if tone is not None: record["toneSuggestion"] = tone.strip()
        with self._jobs_lock:
            if any(job["state"] in ("queued", "running") for job in self.jobs.values()): raise ApiError(409,"evaluation_busy","an evaluation is already running")
            while len(self.jobs) >= 32: self.jobs.pop(next(iter(self.jobs)))
            self.jobs[job_id] = record
        threading.Thread(target=self._run_evaluation, args=(record, reference, text, settings, tone), daemon=True).start()
        return {"jobId": job_id, "state": "queued"}

    def _run_evaluation(self, record: dict[str, Any], reference: Reference, text: str, settings: dict[str, Any], tone: str | None) -> None:
        record["state"] = "running"
        try:
            with MODEL_LOCK:
                for checkpoint in self.checkpoints.values():
                    _identity, switch_seconds = self._select_locked(checkpoint)
                    output = self._generate_locked(checkpoint, reference, text, settings, None, tone)
                    output["switchSeconds"] = switch_seconds
                    output_name = output["audioUrl"].rsplit("/", 1)[-1].removesuffix(".wav")
                    provenance_path = self.output_directory / f"{output_name}.json"
                    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
                    provenance["switchSeconds"] = switch_seconds
                    self._write_json(provenance_path, provenance)
                    record["outputs"].append(output)
            record["state"] = "ready"
        except Exception as error:
            record["state"] = "failed"; record["error"] = error.code if isinstance(error, ApiError) else type(error).__name__

    def job(self, job_id: str) -> dict[str, Any]:
        if not re.fullmatch(r"[0-9a-f]{32}", job_id): raise ApiError(404, "unknown_job", "evaluation job was not found")
        with self._jobs_lock:
            if job_id not in self.jobs: raise ApiError(404, "unknown_job", "evaluation job was not found")
            return json.loads(json.dumps(self.jobs[job_id]))

    def output(self, name: str) -> bytes:
        if not OUTPUT_NAME.fullmatch(name): raise ApiError(404, "not_found", "output was not found")
        path = (self.output_directory / name).resolve(strict=False)
        if path.parent != self.output_directory or not path.is_file(): raise ApiError(404, "not_found", "output was not found")
        return path.read_bytes()


def load_once():
    global READY, MODEL, DEVICE_IDENTITY
    if not MODEL_REVISION or os.environ.get("VOXCPM_ARTIFACTS_STAGED") != "1":
        return
    if BACKEND == "mlx":
        if evaluation_requested(): raise RuntimeError("PyTorch LoRA registry is unavailable on MLX")
        from mlx_audio.tts.utils import load_model
        MODEL = load_model(Path(os.environ["VOXCPM_MODEL_PATH"]))
    elif BACKEND == "pytorch-cuda":
        import torch
        if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
            raise RuntimeError("exactly one CUDA-visible logical device required")
        if os.environ.get("VOXCPM_DEVICE_POLICY"):
            DEVICE_IDENTITY = enforce_device_policy(os.environ["VOXCPM_DEVICE_POLICY"], os.environ.get("VOXCPM_DEVICE_PROFILE", "local-inference"), os.environ.get("CUDA_VISIBLE_DEVICES", ""))
            if torch.cuda.get_device_name(0) != DEVICE_IDENTITY["name"]: raise RuntimeError("PyTorch CUDA device does not match resolved physical GPU")
        elif "RTX 3080" not in torch.cuda.get_device_name(0):
            raise RuntimeError(f"cuda:0 is {torch.cuda.get_device_name(0)}")
        from voxcpm import VoxCPM
        configuration = {}
        if evaluation_requested():
            from voxcpm.model.voxcpm import LoRAConfig
            rank, alpha, dropout = int(os.environ.get("VOXCPM_LORA_R", "32")), int(os.environ.get("VOXCPM_LORA_ALPHA", "32")), float(os.environ.get("VOXCPM_LORA_DROPOUT", "0"))
            if not 1 <= rank <= 256 or not 1 <= alpha <= 1024 or not 0 <= dropout < 1: raise RuntimeError("invalid configured LoRA architecture")
            configuration = {"device":"cuda:0", "optimize":os.environ.get("VOXCPM_OPTIMIZE", "1")=="1", "lora_config":LoRAConfig(enable_lm=True, enable_dit=True, enable_proj=False, r=rank, alpha=alpha, dropout=dropout)}
        MODEL = VoxCPM.from_pretrained(os.environ["VOXCPM_MODEL_PATH"], load_denoiser=False, **configuration)
        warmup = MODEL.generate_streaming(text="warmup", retry_badcase=False)
        next(warmup)
        warmup.close()
    else:
        raise RuntimeError(f"unsupported VoxCPM backend: {BACKEND}")
    if evaluation_requested(): initialize_evaluation(MODEL)
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
        key=(BACKEND,MODEL_REVISION,EVALUATION.active.digest if EVALUATION else None,style,seed,synthesis_settings()["inferenceTimesteps"],synthesis_settings()["cfgValue"])
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
        with guard_mlx_generation(MODEL):
            for result in MODEL.generate(text=text, instruct=style or None, max_tokens=max_tokens, cfg_value=synthesis_settings()["cfgValue"], inference_timesteps=synthesis_settings()["inferenceTimesteps"], **conditioning):
                check_generation()
                yield np.asarray(result.audio, dtype=np.float32)
        return
    import torch
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    conditioning = {"reference_wav_path":reference_path} if reference_path else {}
    if reference_path and transcript:
        conditioning.update(prompt_wav_path=prompt_path or reference_path,prompt_text=transcript.rstrip()+" ")
    generator=MODEL.generate_streaming(text=f"({style}){text}" if style else text, max_len=max_tokens, cfg_value=synthesis_settings()["cfgValue"], inference_timesteps=synthesis_settings()["inferenceTimesteps"], retry_badcase=False, **conditioning)
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
    if not isinstance(request,dict): return "malformedRequest"
    if "checkpointKey" in request and (not isinstance(request["checkpointKey"],str) or not CHECKPOINT_KEY.fullmatch(request["checkpointKey"])): return "malformedRequest"
    if "referenceVoiceId" in request and request["referenceVoiceId"] is not None and not valid_reference_key(request["referenceVoiceId"]): return "malformedRequest"
    if "voiceReference" in request and "referenceVoiceId" in request: return "malformedRequest"
    settings = request.get("synthesisSettings")
    if "synthesisSettings" in request:
        if not isinstance(settings,dict) or set(settings)!={"inferenceTimesteps","cfgValue"}: return "malformedRequest"
        steps, guidance = settings["inferenceTimesteps"], settings["cfgValue"]
        if type(steps) is not int or not 10 <= steps <= 50: return "malformedRequest"
        if type(guidance) not in (int,float) or not 2.0 <= guidance <= 4.0: return "malformedRequest"

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
        if evaluation_http(self,"GET"): return
        if self.path=="/healthz": return self.json(200,{"status":"alive","busy":LOCK.locked(),"queuedJobs":JOBS.qsize()})
        if self.path=="/readyz": return self.json(200 if READY else 503,{"status":"ready" if READY else "unavailable","runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION,"mappingRevision":MAPPING_REVISION,"activeCheckpoint":EVALUATION.active.identity() if EVALUATION else None,"serviceDefaults":EVALUATION.default_identity() if EVALUATION else None})
        if self.path=="/v1/capabilities": return self.json(200,{"protocolVersion":"voxcpm.loopback.v1","contractVersion":"2.0.0","streaming":True,"workers":1,"ready":READY,"format":FORMAT,"backend":BACKEND,"activeCheckpoint":EVALUATION.active.identity() if EVALUATION else None,"serviceDefaults":EVALUATION.default_identity() if EVALUATION else None,"evaluation":{"hotSwap":bool(EVALUATION)},"spokenTextIsolation":"reference-anchor-v1","voiceDesignControl":"voxcpm.voice-design.v1","voiceReferenceControl":"voxcpm.voice-reference.v1","synthesisSettingsControl":{"version":"voxcpm.synthesis-settings.v1","inferenceTimesteps":{"min":10,"max":50,"default":10},"cfgValue":{"min":2.0,"max":4.0,"default":2.0}}})
        self.json(404,{"error":"not_found"})
    def do_POST(self):
        if evaluation_http(self,"POST"): return
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
            check_generation()
            applied,degraded,style=map_delivery(request["delivery"])
            design=request.get("voiceDesign", {"description":"", "seed":0})
            reference, registered_digest = synthesis_reference(request)
            reference_digest=registered_digest or (hashlib.sha256(base64.b64decode(reference["dataBase64"])).hexdigest() if reference else None)
            if reference:
                degraded=sorted(set(degraded+['deliveryMode','pace','energy']))
                # Keep the reference timbre; only describe the chosen delivery.
                style=style.replace("adult voice", "delivery")
            if design["description"]:
                style=design["description"] + "; " + style
            self.event({"kind":"preAudio","sequence":sequence,"requestId":request["requestId"],"correlationId":request["correlationId"],"voiceBundleRevision":request["voiceBundleRevision"],"requestedDelivery":request["delivery"],"appliedDelivery":applied,"degradedDimensions":degraded,"mappingRevision":MAPPING_REVISION,"effectiveSynthesis":{"spokenTextIsolation":"reference-anchor-v1","voiceDesign":style,"voiceDescription":design["description"],"seed":design["seed"],"referenceDigest":reference_digest,"conditioningMode":"continuation" if reference and reference["transcript"] else "reference" if reference else "description","cfgValue":synthesis_settings()["cfgValue"],"inferenceTimesteps":synthesis_settings()["inferenceTimesteps"],"backend":BACKEND,"activeCheckpoint":EVALUATION.active.identity() if EVALUATION else None,"serviceDefaults":EVALUATION.default_identity() if EVALUATION else None},"format":FORMAT,"runtimeRevision":RUNTIME_REVISION,"modelRevision":MODEL_REVISION})
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
