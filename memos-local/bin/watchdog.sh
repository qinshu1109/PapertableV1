#!/bin/zsh
set -eu

RUNTIME_ROOT="/Users/qinshu/Library/Application Support/MemOSLocal"
HEALTH_URL="http://127.0.0.1:8002/healthz"
FAILURE_FILE="$RUNTIME_ROOT/run/watchdog-failures"
STARTED_FILE="$RUNTIME_ROOT/run/service-started-at"
MAIN_DOMAIN="gui/$(id -u)/com.qinshu.memos-local"
STARTUP_GRACE_SECONDS=600
FAILURES_BEFORE_RESTART=3

mkdir -p "$RUNTIME_ROOT/run" "$RUNTIME_ROOT/logs"
umask 077

if curl -fsS --max-time 8 "$HEALTH_URL" >/dev/null 2>&1; then
  rm -f "$FAILURE_FILE"
  exit 0
fi

now=$(date +%s)
if [[ -f "$STARTED_FILE" ]]; then
  started=$(<"$STARTED_FILE")
  if [[ "$started" == <-> ]] && (( now - started < STARTUP_GRACE_SECONDS )); then
    exit 0
  fi
fi

failures=0
if [[ -f "$FAILURE_FILE" ]]; then
  recorded=$(<"$FAILURE_FILE")
  [[ "$recorded" == <-> ]] && failures=$recorded
fi
failures=$((failures + 1))
tmp_file="$FAILURE_FILE.$$"
print -r -- "$failures" >"$tmp_file"
mv -f "$tmp_file" "$FAILURE_FILE"

if (( failures < FAILURES_BEFORE_RESTART )); then
  print -r -- "$(date -Iseconds) health check failed ($failures/$FAILURES_BEFORE_RESTART)"
  exit 0
fi

print -r -- "$(date -Iseconds) health check failed $failures times; restarting MemOS"
rm -f "$FAILURE_FILE"
launchctl kickstart -k "$MAIN_DOMAIN"
