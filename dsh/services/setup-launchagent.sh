#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.deepseek-harness.web.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
UID_NUM="$(id -u)"

usage() {
  echo "Usage: $0 {install|start|stop|restart|status|logs}"
  echo "  install  - 将 plist 复制到 ~/Library/LaunchAgents/"
  echo "  start    - 通过 launchctl bootstrap 启动服务"
  echo "  stop     - 停止服务 (bootout)"
  echo "  restart  - 强制重启服务 (kickstart -k)"
  echo "  status   - 检查服务运行状态与监听端口 (3080)"
  echo "  logs     - 实时查看标准输出与错误日志"
  exit 1
}

case "${1:-}" in
  install)
    mkdir -p "${TARGET_DIR}"
    cp "${SCRIPT_DIR}/${PLIST_NAME}" "${TARGET_PLIST}"
    echo "已安装 ${TARGET_PLIST}"
    ;;
  start)
    if [ ! -f "${TARGET_PLIST}" ]; then
      echo "错误：未找到 ${TARGET_PLIST}，请先运行 $0 install"
      exit 1
    fi
    launchctl bootstrap "gui/${UID_NUM}" "${TARGET_PLIST}"
    echo "已提交启动请求 (bootstrap)"
    ;;
  stop)
    launchctl bootout "gui/${UID_NUM}/com.deepseek-harness.web" || true
    echo "已停止服务"
    ;;
  restart)
    echo "正在重启 com.deepseek-harness.web ..."
    launchctl kickstart -k "gui/${UID_NUM}/com.deepseek-harness.web"
    echo "重启命令已发送，等待服务就绪（约 10 秒）..."
    sleep 3
    "${0}" status
    ;;
  status)
    echo "=== Launchctl 状态 ==="
    launchctl list | grep -i "deepseek-harness" || echo "未在 launchctl 中运行"
    echo ""
    echo "=== 3080 端口监听 ==="
    lsof -i :3080 2>/dev/null || echo "端口 3080 未被监听"
    ;;
  logs)
    echo "=== 正在跟踪 ~/Library/Logs/dsh-web*.log ==="
    tail -f "${HOME}/Library/Logs/dsh-web.log" "${HOME}/Library/Logs/dsh-web.err.log"
    ;;
  *)
    usage
    ;;
esac
