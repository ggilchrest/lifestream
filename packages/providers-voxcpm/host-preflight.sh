#!/usr/bin/env bash
set -euo pipefail
gpu_index="${VOXCPM_REQUIRED_GPU_INDEX:-1}"
expected_name="${VOXCPM_REQUIRED_GPU_NAME:-NVIDIA GeForce RTX 3080}"
actual="$(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits | awk -F', ' -v i="$gpu_index" '$1 == i {print $0}')"
[[ -n "$actual" ]] || { echo "gpu_mapping_failed: physical index $gpu_index unavailable" >&2; exit 20; }
name="$(awk -F', ' '{print $2}' <<<"$actual")"; memory="$(awk -F', ' '{print $3}' <<<"$actual")"
[[ "$name" == "$expected_name" && "$memory" == "10240" ]] || { echo "gpu_mapping_failed: index $gpu_index is $name with ${memory} MiB" >&2; exit 21; }
export CUDA_VISIBLE_DEVICES=1
export VOXCPM_CUDA_DEVICE=cuda:0
printf 'gpu_preflight_pass index=%s name=%s memoryMiB=%s CUDA_VISIBLE_DEVICES=%s logical=%s\n' "$gpu_index" "$name" "$memory" "$CUDA_VISIBLE_DEVICES" "$VOXCPM_CUDA_DEVICE"
