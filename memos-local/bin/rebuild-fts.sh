#!/bin/zsh
set -eu

ROOT="/Users/qinshu/Documents/MemOSLocal"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"
set -a
source "/Users/qinshu/Library/Application Support/MemOSLocal/secrets.env"
set +a
unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy
PYTHONPATH="$ROOT/app" "$PYTHON" -m memos_managed_mcp.admin rebuild-fts
