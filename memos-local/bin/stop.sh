#!/bin/zsh
set -eu

RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
PID_FILE="$RUNTIME_ROOT/run/memos-managed.pid"
MAIN_LABEL="com.qinshu.memos-local"
WATCHDOG_LABEL="com.qinshu.memos-local.watchdog"
MAIN_DOMAIN="gui/$(id -u)/$MAIN_LABEL"
WATCHDOG_DOMAIN="gui/$(id -u)/$WATCHDOG_LABEL"

# Stop the watchdog first so an intentional shutdown cannot be mistaken for a fault.
launchctl bootout "$WATCHDOG_DOMAIN" >/dev/null 2>&1 || true
launchctl bootout "$MAIN_DOMAIN" >/dev/null 2>&1 || true
launchctl remove "$WATCHDOG_LABEL" >/dev/null 2>&1 || true
launchctl remove "$MAIN_LABEL" >/dev/null 2>&1 || true
rm -f "$PID_FILE" "$RUNTIME_ROOT/run/watchdog-failures" "$RUNTIME_ROOT/run/service-started-at"

echo "MemOS 已停止；下次运行 start.command 会重新加载常驻服务。"
