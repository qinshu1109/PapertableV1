#!/Users/qinshu/miniforge3/envs/memos-local/bin/python
from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

from pathlib import Path
from typing import Any


BASE_URL = "http://127.0.0.1:8002"
HOT_CONTEXT_FILE = Path(
    "/Users/qinshu/Library/Application Support/MemOSLocal/data/.memos/hot_context.md"
)


def read_input() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def request_json(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        BASE_URL + path,
        data=data,
        method="POST" if data is not None else "GET",
        headers={"content-type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            value = json.loads(response.read().decode("utf-8"))
            return value if isinstance(value, dict) else {}
    except (OSError, ValueError, urllib.error.URLError):
        return {}


def hook_output(event_name: str, context: str) -> None:
    context = context[:9500]
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": event_name,
                    "additionalContext": context,
                }
            },
            ensure_ascii=False,
        )
    )


def main() -> None:
    client = sys.argv[1] if len(sys.argv) > 1 else "codex"
    payload = read_input()
    event_name = str(
        payload.get("hook_event_name")
        or payload.get("hookEventName")
        or payload.get("event")
        or ""
    )
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "unknown")
    transcript_path = payload.get("transcript_path") or payload.get("transcriptPath")
    transcript_offset = 0
    if transcript_path:
        try:
            transcript_offset = os.path.getsize(str(transcript_path))
        except OSError:
            transcript_offset = 0
    fingerprint_source = "|".join(
        [
            event_name,
            str(payload.get("turn_id") or payload.get("turnId") or payload.get("turn") or ""),
            str(payload.get("last_assistant_message") or payload.get("lastAssistantText") or "")[-500:],
        ]
    )
    event_payload = {
        "client": client,
        "session_id": session_id,
        "event_type": event_name,
        "transcript_path": transcript_path,
        "transcript_offset": transcript_offset,
        "fingerprint": hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest(),
    }
    request_json("/hooks/v1/events", event_payload)

    if event_name == "SessionStart":
        result = request_json("/ui/api/hot/context")
        context = str(result.get("context") or "")
        if not context:
            try:
                context = HOT_CONTEXT_FILE.read_text(encoding="utf-8")
            except OSError:
                context = ""
        if context:
            hook_output(event_name, context)
        else:
            print("{}")
        return

    if event_name == "UserPromptSubmit":
        prompt = str(payload.get("prompt") or "")
        route = request_json(
            "/ui/api/hot/route",
            {"query": prompt, "context_sufficient": False},
        )
        if route.get("need_memory"):
            cubes = ", ".join(str(value) for value in route.get("cube_ids") or [])
            suggestion = (
                "MemOS 本地路由判断：当前问题可能依赖长期背景。"
                + (f"优先搜索 Cube：{cubes}。" if cubes else "热地图未明确选库，先搜索 index。")
                + f" 路由决策 ID：{route.get('routing_decision_id', 'unknown')}。"
                "调用 search_memories 时传入该 routing_decision_id；当前上下文已经充足时可以不搜索。"
            )
            hook_output(event_name, suggestion[:1200])
        else:
            print("{}")
        return

    # Stop and SessionEnd are side-effect-only. Codex requires valid JSON on
    # successful Stop hooks; Claude also accepts this empty structured output.
    print("{}")


if __name__ == "__main__":
    main()
