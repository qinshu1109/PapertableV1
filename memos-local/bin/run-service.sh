#!/bin/zsh
set -eu

APP_ROOT="/Users/qinshu/Documents/MemOSLocal"
RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
SECRETS_FILE="$RUNTIME_ROOT/secrets.env"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"

set -a
source "$SECRETS_FILE"
set +a
unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy

export PYTHONWARNINGS=ignore
export PYTHONPATH="$APP_ROOT/app"

exec "$PYTHON" -m memos_managed_mcp --host 127.0.0.1 --port 8002
