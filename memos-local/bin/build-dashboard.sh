#!/bin/zsh
set -eu

APP_ROOT="/Users/qinshu/Documents/MemOSLocal"
NODE_ROOT="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin"
NPM="$NODE_ROOT/npm"

if [[ ! -x "$NPM" ]]; then
  echo "未找到构建用 npm：$NPM"
  exit 1
fi

export PATH="$NODE_ROOT:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$APP_ROOT/ui"
"$NPM" ci
"$NPM" audit --audit-level=high
"$NPM" run build
echo "管理台构建完成：$APP_ROOT/app/memos_managed_mcp/ui_dist"
