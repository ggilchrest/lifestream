#!/usr/bin/env bash
set -euo pipefail
[[ "${VOXCPM_PROFILE:-wsl-development}" == "wsl-development" ]] || exit 0
driver="$(find /usr/lib/wsl/drivers -type f -name libcuda.so.1 -print -quit 2>/dev/null || true)"
[[ -n "$driver" ]] || { echo "wsl_compatibility_error: mounted libcuda.so.1 not found" >&2; exit 30; }
install -d /usr/local/lib
ln -sfn "$driver" /usr/local/lib/libcuda.so
export LIBRARY_PATH="/usr/local/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
printf 'wsl_compatibility_pass target=%s LIBRARY_PATH=%s\n' "$driver" "$LIBRARY_PATH"
