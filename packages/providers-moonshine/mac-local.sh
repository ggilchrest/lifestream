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
export MOONSHINE_ARTIFACTS_STAGED=1
export MOONSHINE_BIND="${MOONSHINE_BIND:-127.0.0.1}"
export MOONSHINE_PORT="${MOONSHINE_PORT:-8788}"
export MOONSHINE_MODEL_PATH="$runtime_root/models/moonshine-tiny"
export MOONSHINE_MODEL_REVISION="390624ed33d594443aa4aa221f5b9f283b545b5a"
export MOONSHINE_MODEL_DIGEST="867cd2215804859c55aa972d740bd5002be149b4e7526328c895d2408848c736"
export MOONSHINE_RUNTIME_REVISION="mlx-audio@0.5.3"

exec "$python" "$script_dir/sidecar/moonshine_sidecar.py"
