#!/usr/bin/env bash
set -euo pipefail
out="${1:?telemetry output path required}"
duration="${VOXCPM_TELEMETRY_SECONDS:-60}"
timeout "$duration" bash -c 'while :; do date -u +%Y-%m-%dT%H:%M:%S.%3NZ; nvidia-smi --query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits; sleep 1; done' > "$out" || [[ "$?" == 124 ]]
