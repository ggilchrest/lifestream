# Local checkpoint and reference configuration

The PyTorch sidecar can load an approved checkpoint registry and a reference
registry without changing the streaming contract. Configure these external
paths with `VOXCPM_CHECKPOINT_MANIFEST`, `VOXCPM_CHECKPOINT_ROOT`,
`VOXCPM_REFERENCE_MANIFEST`, and optionally `VOXCPM_DEFAULTS_MANIFEST`.
Keep manifests, audio, weights, device policy, and generated evaluation output
outside versioned source. This does not support PyTorch LoRA weights on MLX;
ordinary MLX synthesis remains available without these registries.

The defaults manifest contains exactly `checkpointKey`, `checkpointDigest`,
`referenceVoiceId`, and `referenceDigest`. Digests have a `sha256:` prefix.
Startup verifies the reference and loads the selected weights before publishing
the evaluation runtime. Default-loading failure prevents startup readiness.
Checkpoint-root discovery accepts numbered `step_` directories, validates the
weight file, and creates an opaque registry key. It does not treat `latest` as
an approved checkpoint identity.

For rank-32 LM/DiT adapters, explicitly configure `VOXCPM_LORA_R=32`,
`VOXCPM_LORA_ALPHA=32`, and `VOXCPM_LORA_DROPOUT=0`. These are also the configured
loader's defaults. Projection LoRA is disabled. An optional external
`VOXCPM_DEVICE_POLICY` verifies the selected physical GPU; no host policy is
included here.

Omitted ordinary checkpoint/reference fields resolve the configured defaults
on every synthesis request. A temporary evaluation selection does not change
that policy. Explicit base, registered reference, uploaded reference, and null
reference overrides remain distinct. Synthetic conditioning anchors are keyed
by the active checkpoint digest to prevent reuse across checkpoint changes.

Ordinary `synthesisSettings` retain CFG 2–4 and 10–50 inference timesteps,
defaulting to 2 and 10. Evaluation uses its independent settings structure and
ranges. Existing voice design, uploaded-reference continuation, MLX behavior,
spoken-text isolation, bounded streaming, cancellation, and deadline handling
remain in the current sidecar implementation. Registry references use direct
reference conditioning. Checkpoint/default provenance is exposed in readiness,
capabilities, and pre-audio metadata.

Evaluation routes remain under `/v1/evaluation/` on the existing sidecar.
Do not expose this operator interface publicly. The Lab's existing same-origin
proxy reaches these routes directly; the historical unauthenticated server
bridge is not installed into the current authenticated application host.

Fixture checks (no models or GPU work):

```sh
python packages/providers-voxcpm/sidecar/test_voxcpm_sidecar.py
python scripts/sidecar-http.test.py
```
