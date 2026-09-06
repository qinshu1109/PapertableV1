#!/bin/zsh
set -eu

RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
PID_FILE="$RUNTIME_ROOT/run/memos-managed.pid"
HEALTH_URL="http://127.0.0.1:8002/healthz"
PYTHON="/Users/qinshu/miniforge3/envs/memos-local/bin/python"
MAIN_LABEL="com.qinshu.memos-local"
WATCHDOG_LABEL="com.qinshu.memos-local.watchdog"
MAIN_DOMAIN="gui/$(id -u)/$MAIN_LABEL"
WATCHDOG_DOMAIN="gui/$(id -u)/$WATCHDOG_LABEL"
MAIN_PLIST="$HOME/Library/LaunchAgents/$MAIN_LABEL.plist"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/$WATCHDOG_LABEL.plist"

if launchctl print "$MAIN_DOMAIN" >/dev/null 2>&1; then
  target_pid=$(launchctl print "$MAIN_DOMAIN" | awk '/pid =/{print $3; exit}')
  if [[ "$target_pid" == <-> ]] && kill -0 "$target_pid" 2>/dev/null; then
    echo "进程：运行中（PID $target_pid）"
  else
    echo "进程：launchd 已加载，正在等待重启"
  fi
else
  echo "进程：未运行"
fi

if [[ -f "$MAIN_PLIST" && -f "$WATCHDOG_PLIST" ]]; then
  echo "安装：常驻 LaunchAgent 已安装（登录自动启动）"
else
  echo "安装：未安装常驻 LaunchAgent"
fi
if launchctl print "$WATCHDOG_DOMAIN" >/dev/null 2>&1; then
  echo "看门狗：已加载（连续 3 次失败自动重启）"
else
  echo "看门狗：未加载"
fi
if pgrep -f '/usr/bin/caffeinate -i -s -w' >/dev/null 2>&1; then
  echo "睡眠策略：屏幕可熄灭，整机空闲睡眠已阻止"
else
  echo "睡眠策略：未检测到常驻防睡眠断言"
fi

if health_json=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null); then
  health_state=$(print -r -- "$health_json" | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin).get("status","unknown"))')
  if [[ "$health_state" == "ok" ]]; then
    echo "健康检查：正常"
  else
    echo "健康检查：服务可用，上游状态为 $health_state"
  fi
  print -r -- "$health_json" | "$PYTHON" -m json.tool
  print -r -- "$health_json" | "$PYTHON" -c '
import json,sys
d=json.load(sys.stdin)
h=d.get("hot_memory",{})
f=h.get("fts",{})
c=d.get("curated_knowledge",{})
print("热快照：v{} · {} 字符 · dirty={}".format(h.get("version",0),h.get("char_count",0),h.get("dirty","unknown")))
print("FTS：{} · {} 文档".format(f.get("status","unknown"),f.get("documents",0)))
print("精选知识：{} · 压缩={}".format(c.get("status","unknown"),"启用" if c.get("compression_enabled") else "禁用"))
print("客户端 Hook：{}".format("启用" if h.get("client_ingest_enabled") else "停用"))
'
  echo "只读管理台：http://127.0.0.1:8002/ui/"
else
  echo "健康检查：不可用"
fi

if [[ -d "$RUNTIME_ROOT/data" ]]; then
  echo "本地数据占用：$(du -sh "$RUNTIME_ROOT/data" | awk '{print $1}')"
fi
