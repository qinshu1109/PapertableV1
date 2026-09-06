#!/bin/sh
# dsh-web 原子启动 wrapper（简报 34 · A 级）：preflight 失败则拒绝启动，
# 通过后 exec dsh web（含 --trusted-host，简报 33 落地）。
set -u

NODE_BIN=/Users/qinshu/.local/node/bin/node
PREFLIGHT=/Users/qinshu/.dsh/scripts/dsh-web-preflight.mjs
DSH_BIN=/Users/qinshu/.local/bin/dsh

if ! "$NODE_BIN" "$PREFLIGHT"; then
  echo "dsh-web: PREFLIGHT FAILED — refusing to start dsh web. Fix the entries listed above, then restart." >&2
  exit 1
fi

exec "$DSH_BIN" web --trusted-host dsh.cozai.net
