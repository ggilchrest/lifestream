#!/bin/sh
set -eu
if [ ! -e /usr/local/lib/libcuda.so ]; then
  driver="$(find /usr/lib/wsl/drivers -name libcuda.so.1 -print -quit 2>/dev/null || true)"
  if [ -n "$driver" ]; then
    ln -s "$driver" /usr/local/lib/libcuda.so
  fi
fi
export LIBRARY_PATH="/usr/local/lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
exec "$@"
