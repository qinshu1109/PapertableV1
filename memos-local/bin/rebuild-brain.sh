#!/bin/zsh
set -eu

APP_ROOT="/Users/qinshu/Documents/MemOSLocal"
RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
SECRETS_FILE="$RUNTIME_ROOT/secrets.env"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"

if curl -fsS --max-time 2 "http://127.0.0.1:8002/healthz" >/dev/null 2>&1; then
  echo "请先运行 stop.command；嵌入式 Qdrant 运行期间不能执行离线 Brain 重建。"
  exit 1
fi

set -a
source "$SECRETS_FILE"
set +a
unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy

export PYTHONWARNINGS=ignore
export PYTHONPATH="$APP_ROOT/app"

exec "$PYTHON" -m memos_managed_mcp.admin rebuild-brain
