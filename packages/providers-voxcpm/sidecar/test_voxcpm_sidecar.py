import hashlib
import base64
import importlib.util
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.request
import wave
import sys
from pathlib import Path
from http.server import ThreadingHTTPServer

MODULE_PATH = Path(__file__).with_name("voxcpm_sidecar.py")
SPEC = importlib.util.spec_from_file_location("voxcpm_sidecar", MODULE_PATH)
sidecar = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = sidecar
SPEC.loader.exec_module(sidecar)

DIGEST_BASE = "sha256:" + "1" * 64


class FakeModel:
    def __init__(self):
        self.enabled = False
        self.loaded = []
        self.generation_calls = []
        self.in_call = 0
        self.max_in_call = 0
        self.release = None

    def _enter(self):
        self.in_call += 1
        self.max_in_call = max(self.max_in_call, self.in_call)

    def _leave(self):
        self.in_call -= 1

    def set_lora_enabled(self, enabled):
        self._enter(); self.enabled = enabled; time.sleep(0.005); self._leave()

    def unload_lora(self):
        self._enter(); time.sleep(0.005); self._leave()

    def load_lora(self, path):
        self._enter(); self.loaded.append(path); time.sleep(0.01); self._leave()
        return (["lora_A", "lora_B"], [])

    def generate_streaming(self, **kwargs):
        self.generation_calls.append(kwargs)
        def stream():
            if self.release is not None:
                self.release.wait(2)
            yield [0.0]
        return stream()


def write_wav(path):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000); audio.writeframes(b"\0\0" * 32000)


def wav_bytes(sample_rate=16000, channels=1, frames=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(channels); audio.setsampwidth(2); audio.setframerate(sample_rate); audio.writeframes(b"\0\0" * frames * channels)
    return output.getvalue()


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.weights = self.root / "lora_weights.ckpt"
        self.weights.write_bytes(b"approved weights")
        self.lora_digest = "sha256:" + hashlib.sha256(self.weights.read_bytes()).hexdigest()
        self.reference = self.root / "reference.wav"
        write_wav(self.reference)
        self.checkpoints = {
            "base": sidecar.Checkpoint("base", "Base VoxCPM2", "base", DIGEST_BASE, "base", None),
            "step-00024": sidecar.Checkpoint("step-00024", "Step 24", "step-00024", self.lora_digest, "lora", self.weights),
        }
        self.model = FakeModel()
        self.runtime = sidecar.EvaluationRuntime(self.model, self.checkpoints, {"fixture-voice": self.reference}, self.root / "outputs")
        self.runtime._render_pcm = lambda *_args: b"\0\0" * 100
        sidecar.READY = True

    def tearDown(self):
        self.temporary.cleanup()

    def test_catalog_exposes_only_opaque_approved_fields(self):
        catalog = self.runtime.catalog()
        self.assertEqual([item["key"] for item in catalog["checkpoints"]], ["base", "step-00024"])
        self.assertNotIn(str(self.root), json.dumps(catalog))
        self.assertEqual(set(catalog["checkpoints"][1]), {"key", "label", "revision", "digest", "kind"})

    def test_checkpoint_root_discovers_every_valid_step_directory(self):
        checkpoint_root = self.root / "checkpoints"; checkpoint_root.mkdir()
        for name, content in (("step_0000000", b"zero"), ("step_0000001", b"one"), ("step_0000024", b"twenty-four")):
            directory = checkpoint_root / name; directory.mkdir(); (directory / "lora_weights.safetensors").write_bytes(content)
        (checkpoint_root / "latest").mkdir()
        invalid = checkpoint_root / "step_0000025"; invalid.mkdir(); (invalid / "trainer_state.json").write_text("{}")
        discovered = sidecar.load_checkpoint_registry(None, DIGEST_BASE, str(checkpoint_root))
        self.assertEqual(list(discovered), ["base", "step-00000", "step-00001", "step-00024"])
        self.assertEqual(discovered["step-00024"].digest, "sha256:" + hashlib.sha256(b"twenty-four").hexdigest())

    def test_unknown_traversal_and_digest_mismatch_are_rejected(self):
        for key in ("missing", "../step-00024", str(self.weights)):
            with self.assertRaises(sidecar.ApiError): self.runtime.select(key, self.lora_digest)
        with self.assertRaisesRegex(sidecar.ApiError, "expected digest"):
            self.runtime.select("step-00024", DIGEST_BASE)

    def test_lora_and_base_selection_report_active_checkpoint(self):
        active, _elapsed = self.runtime.select("step-00024", self.lora_digest)
        self.assertEqual(active["key"], "step-00024")
        self.assertTrue(self.model.enabled)
        active, _elapsed = self.runtime.select("base", DIGEST_BASE)
        self.assertEqual(active["key"], "base")
        self.assertFalse(self.model.enabled)

    def test_selection_requests_are_serialized(self):
        errors = []
        def select_lora():
            try: self.runtime.select("step-00024", self.lora_digest)
            except Exception as error: errors.append(error)
        def select_base():
            try: self.runtime.select("base", DIGEST_BASE)
            except Exception as error: errors.append(error)
        first = threading.Thread(target=select_lora)
        second = threading.Thread(target=select_base)
        first.start(); second.start(); first.join(); second.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.model.max_in_call, 1)

    def test_generation_fails_closed_when_requested_checkpoint_is_not_active(self):
        request = {"checkpointKey": "step-00024", "referenceVoiceId": "fixture-voice", "text": "hello", "settings": {"cfg": 3, "timesteps": 20, "seed": 0}}
        with self.assertRaisesRegex(sidecar.ApiError, "active checkpoint"):
            self.runtime._generate_locked(self.checkpoints["step-00024"], self.runtime.references["fixture-voice"], request["text"], request["settings"])

    def test_reference_manifest_maps_source_id_without_exposing_path(self):
        manifest = self.root / "references.json"
        manifest.write_text(json.dumps({"mac-catalog-voice": {"referenceKey": "ref-fixture-calm", "label": "Mac Catalog Voice", "path": str(self.reference), "digest": sidecar.sha256_file(self.reference), "transcript": "A calm reference.", "duration": 2.0}}))
        references = sidecar.load_reference_registry(str(manifest))
        runtime = sidecar.EvaluationRuntime(self.model, self.checkpoints, references, self.root / "manifest-outputs")
        listed = runtime.reference_catalog()["references"]
        self.assertEqual(listed, [{"sourceId": "mac-catalog-voice", "referenceKey": "ref-fixture-calm", "key": "ref-fixture-calm", "label": "Mac Catalog Voice", "transcript": "A calm reference.", "duration": 2.0, "digest": sidecar.sha256_file(self.reference)}])
        self.assertNotIn(str(self.root), json.dumps(listed))

    def test_reference_manifest_rejects_invalid_audio_and_digest(self):
        manifest = self.root / "references.json"
        wrong_rate = self.root / "wrong-rate.wav"; wrong_rate.write_bytes(wav_bytes(sample_rate=48000))
        entry = {"referenceKey": "ref-invalid", "path": str(wrong_rate), "digest": sidecar.sha256_file(wrong_rate), "transcript": "bad", "duration": 1.0}
        manifest.write_text(json.dumps({"catalog-invalid": entry}))
        with self.assertRaisesRegex(RuntimeError, "invalid"):
            sidecar.load_reference_registry(str(manifest))
        entry.update(path=str(self.reference), digest="sha256:" + "0" * 64, duration=2.0)
        manifest.write_text(json.dumps({"catalog-invalid": entry}))
        with self.assertRaisesRegex(RuntimeError, "digest"):
            sidecar.load_reference_registry(str(manifest))

    def test_unknown_reference_is_rejected(self):
        request = {"checkpointKey": "base", "referenceVoiceId": "missing", "text": "hello", "settings": {"cfg": 3, "timesteps": 20, "seed": 0}}
        with self.assertRaisesRegex(sidecar.ApiError, "not approved"):
            self.runtime.generate(request)

    def test_generation_accepts_manifest_source_and_reference_key_with_provenance(self):
        manifest_reference = sidecar.Reference("mac-catalog-voice", "ref-fixture-calm", "Mac Catalog Voice", "hello", 16000, 2.0, sidecar.sha256_file(self.reference), self.reference)
        self.runtime = sidecar.EvaluationRuntime(self.model, self.checkpoints, {manifest_reference.key: manifest_reference}, self.root / "manifest-generation")
        self.runtime._render_pcm = lambda *_args: b"\0\0" * 100
        registered = {"checkpointKey": "base", "referenceVoiceId": "fixture-voice", "text": "hello", "settings": {"cfg": 3, "timesteps": 20, "seed": 7}, "expectedDigest": DIGEST_BASE, "toneSuggestion": "calm"}
        registered["referenceVoiceId"] = "mac-catalog-voice"
        result = self.runtime.generate(registered)
        self.assertEqual(result["checkpointDigest"], DIGEST_BASE)
        self.assertEqual(result["referenceDigest"], sidecar.sha256_file(self.reference))
        self.assertEqual(result["referenceKey"], "ref-fixture-calm")
        self.assertEqual(result["referenceVoiceId"], "mac-catalog-voice")
        self.assertEqual(result["expectedDigest"], DIGEST_BASE)
        registered["referenceVoiceId"] = "ref-fixture-calm"
        self.assertEqual(self.runtime.generate(registered)["referenceKey"], "ref-fixture-calm")

    def test_tone_suggestion_controls_effective_model_text(self):
        rendered = []
        self.runtime._render_pcm = lambda _reference, text, _settings: rendered.append(text) or b"\0\0" * 100
        request = {"checkpointKey": "base", "referenceVoiceId": "fixture-voice", "text": "target text", "settings": {"cfg": 3, "timesteps": 20, "seed": 0}}
        cases = [
            ("happy", "(happy) target text", "happy"),
            ("  breathy, but increasingly hopeful  ", "(breathy, but increasingly hopeful) target text", "breathy, but increasingly hopeful"),
            ("   ", "target text", ""),
        ]
        for tone, final_text, normalized_tone in cases:
            with self.subTest(tone=tone):
                result = self.runtime.generate({**request, "toneSuggestion": tone})
                self.assertEqual(rendered[-1], final_text)
                self.assertEqual(result["finalText"], final_text)
                self.assertEqual(result["toneSuggestion"], normalized_tone)

    def test_evaluation_generation_uses_reference_only_conditioning(self):
        reference = self.runtime._resolve_reference("fixture-voice")
        kwargs = self.runtime._generation_kwargs(reference, "(happy) target text", {"cfg": 3, "timesteps": 20, "seed": 0})
        self.assertEqual(kwargs["reference_wav_path"], str(self.reference))
        self.assertEqual(kwargs["text"], "(happy) target text")
        self.assertNotIn("prompt_wav_path", kwargs)
        self.assertNotIn("prompt_text", kwargs)

    def test_generation_rejects_changed_manifest_audio_digest(self):
        manifest_reference = sidecar.Reference("mac-catalog-voice", "ref-fixture-calm", "Mac Catalog Voice", "hello", 16000, 2.0, sidecar.sha256_file(self.reference), self.reference)
        runtime = sidecar.EvaluationRuntime(self.model, self.checkpoints, {manifest_reference.key: manifest_reference}, self.root / "digest-outputs")
        runtime._render_pcm = lambda *_args: b"\0\0" * 100
        self.reference.write_bytes(wav_bytes(frames=20000))
        with self.assertRaisesRegex(sidecar.ApiError, "digest"):
            runtime.generate({"checkpointKey": "base", "referenceVoiceId": "mac-catalog-voice", "text": "hello", "settings": {"cfg": 3, "timesteps": 20, "seed": 0}})

    def test_synthesis_waits_for_swap_lock(self):
        self.model.release = threading.Event()
        swap_started = threading.Event()
        original_warmup = self.runtime._warmup
        def blocked_warmup():
            swap_started.set(); original_warmup()
        self.runtime._warmup = blocked_warmup
        swap = threading.Thread(target=lambda: self.runtime.select("step-00024", self.lora_digest))
        acquired = threading.Event()
        synth = threading.Thread(target=lambda: (sidecar.MODEL_LOCK.acquire(), acquired.set(), sidecar.MODEL_LOCK.release()))
        swap.start(); self.assertTrue(swap_started.wait(1)); synth.start()
        self.assertFalse(acquired.wait(.05))
        self.model.release.set(); swap.join(); synth.join()
        self.assertTrue(acquired.is_set())

    def test_device_profiles_accept_only_configured_gpu_identity(self):
        policy = self.root / "device-policy.json"
        policy.write_text(json.dumps({"profiles":{"ai5090":{"allowedNames":["NVIDIA GeForce RTX 5090"],"minimumVramMiB":30000},"local-inference":{"allowedNames":["NVIDIA GeForce RTX 3080"],"minimumVramMiB":9000}}}))
        inventory = "0, GPU-5090, NVIDIA GeForce RTX 5090, 32607, 00000000:01:00.0\n1, GPU-3080, NVIDIA GeForce RTX 3080, 10240, 00000000:02:00.0\n"
        self.assertEqual(sidecar.enforce_device_policy(str(policy), "ai5090", "GPU-5090", inventory)["name"], "NVIDIA GeForce RTX 5090")
        self.assertEqual(sidecar.enforce_device_policy(str(policy), "local-inference", "1", inventory)["name"], "NVIDIA GeForce RTX 3080")
        with self.assertRaises(RuntimeError): sidecar.enforce_device_policy(str(policy), "local-inference", "0", inventory)

    def test_fixture_v1_reference_remains_compatible(self):
        pcm = base64_bytes = __import__("base64").b64encode(b"\0\0" * 32000).decode()
        request = {"protocolVersion": "voxcpm.loopback.v1", "requestId": "r", "correlationId": "c", "interactionId": "i", "deadlineAt": "2999-01-01T00:00:00Z", "voiceBundleKey": "fixture-voice-design", "voiceBundleRevision": 1, "text": "hello", "delivery": {}, "format": sidecar.FORMAT, "voiceReference": {"version": "voxcpm.voice-reference.v1", "sampleRateHz": 16000, "dataBase64": base64_bytes, "transcript": "hello"}}
        self.assertIsNone(sidecar.validate(request))

    def configure_fixture_defaults(self):
        checkpoint = sidecar.Checkpoint("step-00021", "Fixture step", "step-00021", self.lora_digest, "lora", self.weights)
        self.runtime.checkpoints[checkpoint.key] = checkpoint
        reference = self.runtime.references["fixture-voice"]
        policy = {"checkpointKey":checkpoint.key, "checkpointDigest":checkpoint.digest,
                  "referenceVoiceId":reference.key, "referenceDigest":reference.digest}
        self.runtime.configure_defaults(policy)
        return checkpoint, reference, policy

    def test_service_defaults_load_weights_and_survive_evaluation_selection(self):
        checkpoint, reference, policy = self.configure_fixture_defaults()
        self.assertTrue(self.model.enabled)
        self.assertEqual(self.model.loaded, [str(self.weights)])
        self.runtime.select("base", DIGEST_BASE)
        selected, selected_reference = self.runtime.resolve_synthesis({})
        self.runtime._select_locked(selected)
        self.assertEqual(selected.key, "step-00021")
        self.assertEqual(selected_reference.digest, reference.digest)
        self.assertEqual(self.runtime.default_identity()["checkpoint"]["key"], "step-00021")
        generated = self.runtime.generate({"text":"Fixture speech", "settings":{"cfg":3,"timesteps":20,"seed":0}})
        self.assertEqual(generated["checkpointKey"], "step-00021")
        self.assertEqual(generated["referenceDigest"], policy["referenceDigest"])

    def test_explicit_base_null_and_uploaded_reference_override_defaults(self):
        self.configure_fixture_defaults()
        checkpoint, reference = self.runtime.resolve_synthesis({"checkpointKey":"base","referenceVoiceId":None})
        self.assertEqual(checkpoint.key,"base"); self.assertIsNone(reference)
        _, reference = self.runtime.resolve_synthesis({"voiceReference":None})
        self.assertIsNone(reference)
        with self.assertRaises(sidecar.ApiError):
            self.runtime.resolve_synthesis({"voiceReference":None,"referenceVoiceId":None})

    def test_default_digest_drift_rejected_before_selection(self):
        _, _, policy = self.configure_fixture_defaults()
        loaded = list(self.model.loaded)
        with self.assertRaisesRegex(RuntimeError,"digest mismatch"):
            self.runtime.configure_defaults({**policy,"checkpointDigest":DIGEST_BASE})
        self.assertEqual(self.model.loaded,loaded)
        self.reference.write_bytes(wav_bytes(frames=20000))
        with self.assertRaises(sidecar.ApiError): self.runtime.resolve_synthesis({})

    def test_current_synthesis_settings_bounds_remain_independent_of_lab(self):
        request = {"protocolVersion":"voxcpm.loopback.v1","requestId":"r","correlationId":"c","interactionId":"i","deadlineAt":"2999-01-01T00:00:00Z","voiceBundleKey":"fixture-voice-design","voiceBundleRevision":1,"text":"Fixture","delivery":{},"format":sidecar.FORMAT}
        self.assertIsNone(sidecar.validate({**request,"synthesisSettings":{"cfgValue":4.0,"inferenceTimesteps":50}}))
        for settings in ({"cfgValue":1.9,"inferenceTimesteps":10},{"cfgValue":2.0,"inferenceTimesteps":51}):
            self.assertEqual(sidecar.validate({**request,"synthesisSettings":settings}),"malformedRequest")

    def test_cuda_loader_constructs_rank32_architecture_with_fixture_model(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        captured = {}
        def construct(_path, **kwargs):
            captured.update(kwargs); return self.model
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda:True,device_count=lambda:1,get_device_name=lambda _index:"NVIDIA GeForce RTX 3080"))
        modules = {"torch":torch,"voxcpm":SimpleNamespace(VoxCPM=SimpleNamespace(from_pretrained=construct)),
                   "voxcpm.model":SimpleNamespace(),"voxcpm.model.voxcpm":SimpleNamespace(LoRAConfig=lambda **kwargs:kwargs)}
        environment = {"VOXCPM_ARTIFACTS_STAGED":"1","VOXCPM_MODEL_PATH":str(self.root),
                       "VOXCPM_CHECKPOINT_ROOT":str(self.root),"VOXCPM_EVALUATION_OUTPUT_DIR":str(self.root/"loader-output"),
                       "VOXCPM_LORA_R":"32","VOXCPM_LORA_ALPHA":"32","VOXCPM_LORA_DROPOUT":"0"}
        with patch.dict(sys.modules,modules), patch.dict(sidecar.os.environ,environment,clear=True), patch.object(sidecar,"MODEL_REVISION","fixture-revision"), patch.object(sidecar,"MODEL",None), patch.object(sidecar,"EVALUATION",None):
            sidecar.load_once()
        self.assertEqual(captured["lora_config"],{"enable_lm":True,"enable_dit":True,"enable_proj":False,"r":32,"alpha":32,"dropout":0.0})

    def test_pre_audio_reports_active_checkpoint(self):
        previous_model, previous_evaluation, previous_ready = sidecar.MODEL, sidecar.EVALUATION, sidecar.READY
        sidecar.MODEL, sidecar.EVALUATION, sidecar.READY = self.model, self.runtime, True
        server = ThreadingHTTPServer(("127.0.0.1", 0), sidecar.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        import numpy as np
        original_generator = sidecar.generate_audio
        def fixture_audio(*_args):
            yield np.zeros(100, dtype=np.float32)
        sidecar.generate_audio = fixture_audio
        worker = threading.Thread(target=lambda: sidecar.work_once(timeout=3), daemon=True); worker.start()
        try:
            request = {"protocolVersion": "voxcpm.loopback.v1", "requestId": "r", "correlationId": "c", "interactionId": "i", "deadlineAt": "2999-01-01T00:00:00Z", "voiceBundleKey": "fixture-voice-design", "voiceBundleRevision": 1, "text": "hello", "delivery": {}, "format": sidecar.FORMAT}
            http_request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/v1/tts/synthesize", data=json.dumps(request).encode(), headers={"content-type": "application/json"}, method="POST")
            lines = urllib.request.urlopen(http_request, timeout=4).read().decode().splitlines()
            pre_audio = json.loads(lines[0])
            self.assertEqual(pre_audio["kind"], "preAudio")
            self.assertEqual(pre_audio["effectiveSynthesis"]["activeCheckpoint"]["key"], "base")
        finally:
            server.shutdown(); server.server_close(); thread.join()
            worker.join(4)
            sidecar.generate_audio = original_generator
            sidecar.MODEL, sidecar.EVALUATION, sidecar.READY = previous_model, previous_evaluation, previous_ready


if __name__ == "__main__":
    unittest.main()
