#!/bin/sh
set -eu

export DSH_HOME=/Users/qinshu/.dsh-source
export HOME=/Users/qinshu
export PATH=/Users/qinshu/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

cd /Users/qinshu/Documents/ChatGPT/MemOS/deepseek-harness
exec /Users/qinshu/.local/node/bin/pnpm dsh web --trusted-host dsh.cozai.net --no-open
