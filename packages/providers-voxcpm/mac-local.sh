#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
workspace_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd)"
runtime_root="${LIFESTREAM_MAC_RUNTIME_ROOT:-$workspace_root/runtime/mac-local}"
python="$runtime_root/venv/bin/python"

if [ ! -x "$python" ]; then
  echo "Mac local runtime is not installed. Run orchestration/scripts/install-mac-local-runtime.sh first." >&2
  exit 1
fi

export HF_HOME="${HF_HOME:-$runtime_root/huggingface}"
export VOXCPM_ARTIFACTS_STAGED=1
export VOXCPM_BACKEND=mlx
export VOXCPM_BIND="${VOXCPM_BIND:-127.0.0.1}"
export VOXCPM_PORT="${VOXCPM_PORT:-8787}"
export VOXCPM_MODEL_PATH="$runtime_root/models/VoxCPM2-4bit"
export VOXCPM_MODEL_SNAPSHOT="dc9e5c187858da5f4a13dc4c247e297339216381"
export VOXCPM_RUNTIME_REVISION="mlx-audio@0.5.3"

exec "$python" "$script_dir/sidecar/voxcpm_sidecar.py"
