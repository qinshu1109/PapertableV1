#!/bin/zsh
set -eu

APP_ROOT="/Users/qinshu/Documents/MemOSLocal"
RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
SECRETS_FILE="$RUNTIME_ROOT/secrets.env"
PID_FILE="$RUNTIME_ROOT/run/memos-managed.pid"
CONSOLE_LOG="$RUNTIME_ROOT/logs/console.log"
RUNTIME_APP="$RUNTIME_ROOT/runtime-app"
RUNNER_SOURCE="$APP_ROOT/bin/run-service-runtime.sh"
RUNNER="$RUNTIME_ROOT/run/run-service.sh"
WATCHDOG_SOURCE="$APP_ROOT/bin/watchdog.sh"
WATCHDOG="$RUNTIME_ROOT/run/watchdog.sh"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"
HEALTH_URL="http://127.0.0.1:8002/healthz"
MAIN_LABEL="com.qinshu.memos-local"
WATCHDOG_LABEL="com.qinshu.memos-local.watchdog"
GUI_DOMAIN="gui/$(id -u)"
MAIN_DOMAIN="$GUI_DOMAIN/$MAIN_LABEL"
WATCHDOG_DOMAIN="$GUI_DOMAIN/$WATCHDOG_LABEL"
MAIN_PLIST_SOURCE="$APP_ROOT/launchd/$MAIN_LABEL.plist"
WATCHDOG_PLIST_SOURCE="$APP_ROOT/launchd/$WATCHDOG_LABEL.plist"
MAIN_PLIST="$HOME/Library/LaunchAgents/$MAIN_LABEL.plist"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "缺少密钥文件：$SECRETS_FILE"
  exit 1
fi
mode=$(stat -f '%Lp' "$SECRETS_FILE")
if [[ "$mode" != "600" && "$mode" != "400" ]]; then
  echo "密钥文件权限必须为 600 或 400，当前为 $mode"
  exit 1
fi
if [[ ! -x "$PYTHON" ]]; then
  echo "未找到 memos-local Python 环境：$PYTHON"
  exit 1
fi

mkdir -p "$RUNTIME_ROOT/run" "$RUNTIME_ROOT/logs"
chmod 700 "$RUNTIME_ROOT" "$RUNTIME_ROOT/run" "$RUNTIME_ROOT/logs"

if [[ -f "$CONSOLE_LOG" ]] && (( $(stat -f '%z' "$CONSOLE_LOG") > 10485760 )); then
  for index in 5 4 3 2 1; do
    previous=$((index - 1))
    if (( previous == 0 )); then
      source_log="$CONSOLE_LOG"
    else
      source_log="$CONSOLE_LOG.$previous"
    fi
    [[ -f "$source_log" ]] && mv -f "$source_log" "$CONSOLE_LOG.$index"
  done
fi

# launchd background jobs do not inherit Codex/Terminal access to Documents.
# Deploy a read-only runtime copy under Application Support before every start.
mkdir -p "$RUNTIME_APP"
ditto "$APP_ROOT/app/memos_managed_mcp" "$RUNTIME_APP/memos_managed_mcp"
cp "$RUNNER_SOURCE" "$RUNNER"
cp "$WATCHDOG_SOURCE" "$WATCHDOG"
chmod 700 "$RUNTIME_APP" "$RUNTIME_APP/memos_managed_mcp" "$RUNNER" "$WATCHDOG"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$MAIN_PLIST_SOURCE" "$MAIN_PLIST"
cp "$WATCHDOG_PLIST_SOURCE" "$WATCHDOG_PLIST"
chmod 644 "$MAIN_PLIST" "$WATCHDOG_PLIST"
plutil -lint "$MAIN_PLIST" "$WATCHDOG_PLIST" >/dev/null

# Replace the old ad-hoc submitted job, then install persistent per-user agents.
launchctl bootout "$WATCHDOG_DOMAIN" >/dev/null 2>&1 || true
launchctl bootout "$MAIN_DOMAIN" >/dev/null 2>&1 || true
launchctl remove "$WATCHDOG_LABEL" >/dev/null 2>&1 || true
launchctl remove "$MAIN_LABEL" >/dev/null 2>&1 || true
rm -f "$PID_FILE" "$RUNTIME_ROOT/run/watchdog-failures"

# bootout is asynchronous on some macOS releases.  Do not let a final health
# response from the retiring process masquerade as the newly installed service.
retired=false
for _attempt in {1..30}; do
  if ! launchctl print "$MAIN_DOMAIN" >/dev/null 2>&1 \
      && ! launchctl print "$WATCHDOG_DOMAIN" >/dev/null 2>&1 \
      && ! lsof -nP -iTCP:8002 -sTCP:LISTEN >/dev/null 2>&1; then
    retired=true
    break
  fi
  sleep 1
done
if [[ "$retired" != "true" ]]; then
  echo "旧 MemOS 服务未在 30 秒内完全退出，拒绝并发启动第二个实例。"
  exit 1
fi

bootstrap_agent() {
  local service_domain="$1"
  local plist_path="$2"
  local attempt
  for attempt in {1..5}; do
    if launchctl bootstrap "$GUI_DOMAIN" "$plist_path" >/dev/null 2>&1; then
      return 0
    fi
    # Once retirement has been confirmed above, a visible service can only be
    # the new definition.  Some macOS releases still return a transient I/O
    # error even though that definition was accepted.
    if launchctl print "$service_domain" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "无法加载常驻任务：$service_domain"
  return 1
}

bootstrap_agent "$MAIN_DOMAIN" "$MAIN_PLIST"
bootstrap_agent "$WATCHDOG_DOMAIN" "$WATCHDOG_PLIST"
launchctl enable "$MAIN_DOMAIN"
launchctl enable "$WATCHDOG_DOMAIN"

for _attempt in {1..600}; do
  if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    new_pid=$(launchctl print "$MAIN_DOMAIN" | awk '/pid =/{print $3; exit}')
    if [[ "$new_pid" != <-> ]] || ! kill -0 "$new_pid" 2>/dev/null; then
      echo "MemOS 健康检查成功，但无法确认 launchd 托管进程，拒绝写入 PID。"
      exit 1
    fi
    print -r -- "$new_pid" >"$PID_FILE"
    chmod 600 "$PID_FILE" "$CONSOLE_LOG"
    echo "MemOS 常驻服务安装并启动成功："
    echo "  MCP：http://127.0.0.1:8002/mcp"
    echo "  只读管理台：http://127.0.0.1:8002/ui/"
    echo "  托管：登录自动启动、崩溃自动重启、健康看门狗"
    echo "  睡眠：允许屏幕熄灭，阻止整机空闲睡眠"
    exit 0
  fi
  if ! launchctl print "$MAIN_DOMAIN" >/dev/null 2>&1; then
    echo "MemOS 启动失败。最近日志："
    tail -n 30 "$CONSOLE_LOG"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 1
done

echo "MemOS 启动超时。最近日志："
tail -n 30 "$CONSOLE_LOG"
exit 1
