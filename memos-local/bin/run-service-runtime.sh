#!/bin/zsh
set -eu

RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
SECRETS_FILE="$RUNTIME_ROOT/secrets.env"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"
PID_FILE="$RUNTIME_ROOT/run/memos-managed.pid"
STARTED_FILE="$RUNTIME_ROOT/run/service-started-at"

set -a
source "$SECRETS_FILE"
set +a
unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy

export PYTHONWARNINGS=ignore
export PYTHONPATH="$RUNTIME_ROOT/runtime-app"

# Keep the Mac awake while allowing the display to sleep normally.  caffeinate
# watches this PID; exec below preserves it for the lifetime of the Python server.
umask 077
mkdir -p "$RUNTIME_ROOT/run"
print -r -- "$$" >"$PID_FILE"
date +%s >"$STARTED_FILE"
/usr/bin/caffeinate -i -s -w "$$" >/dev/null 2>&1 &

exec "$PYTHON" -m memos_managed_mcp --host 127.0.0.1 --port 8002
