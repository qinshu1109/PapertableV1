#!/bin/zsh
set -eu

if [[ "${1:-}" != "--confirm" ]]; then
  echo "默认不删除验收数据。确认删除时运行：cleanup-tests.sh --confirm"
  exit 1
fi

source '/Users/qinshu/Library/Application Support/MemOSLocal/secrets.env'
unset ALL_PROXY all_proxy HTTP_PROXY http_proxy HTTPS_PROXY https_proxy
exec env PYTHONWARNINGS=ignore PYTHONPATH=/Users/qinshu/Documents/MemOSLocal/app \
  /Users/qinshu/miniforge3/envs/memos-local/bin/python -m memos_managed_mcp.admin \
  cleanup-tests --confirm DELETE-ACCEPTANCE-DATA
