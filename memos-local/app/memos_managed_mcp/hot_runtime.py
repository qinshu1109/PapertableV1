from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .brain import BrainStoreError
from .hot import HOT_KINDS, HOT_POLICIES, HotMemoryError
from .memory_schema import MemorySchemaError, normalize_timestamp


class HotRuntime:
    """Hot-memory, routing and session-ingestion behavior mixed into the service."""

    @staticmethod
    def _hot_item_line(item: dict[str, Any]) -> str:
        source = (
            f"{item['cube_id']}:{item['memory_id']}"
            if item.get("memory_id") else f"brain:{item['brain_page_id']}"
        )
        return f"- {item['content']}  `来源 {source}`"

    def _hot_render_limits(self) -> tuple[int, int, int, int]:
        hard_tokens = int(getattr(self.settings, "hot_hard_limit_tokens", 2500))
        max_chars = min(9500, int(hard_tokens * 3.6))
        usable = max(0, max_chars - 600)
        return max_chars, int(usable * 0.55), int(usable * 0.35), int(usable * 0.10)

    def _ensure_hot_pin_capacity(
        self,
        content: str,
        exclude_source: tuple[str, str] | None = None,
    ) -> None:
        from .service import ManagedMemoryError

        _max_chars, direct_limit, _brain_limit, _map_limit = self._hot_render_limits()
        pinned = [
            item
            for item in self._hot_candidates_from_sources()
            if item["hot_policy"] == "pin"
            and item["status"] == "active"
            and (item.get("cube_id"), item.get("memory_id")) != exclude_source
        ]
        used = sum(len(self._hot_item_line(item)) + 1 for item in pinned)
        if used + len(content.strip()) + 80 > direct_limit:
            raise ManagedMemoryError(
                "Pinned hot memories exceed their 55% context budget; shorten or unpin an older memory first"
            )

    def _hot_candidates_from_sources(self) -> list[dict[str, Any]]:
        from .service import BRAIN_MAX_PAGES, BRAIN_MIN_SOURCES, BRAIN_NAMESPACE

        if not self.hot_store.enabled:
            return []
        now = datetime.now(timezone.utc)
        policies = {
            (item["cube_id"], item["memory_id"]): item
            for item in self.hot_store.policies()
        }
        superseded = {
            value["supersedes_memory_id"]
            for value in policies.values()
            if value.get("supersedes_memory_id")
        }
        candidates: list[dict[str, Any]] = []
        for (cube_id, memory_id), policy in policies.items():
            is_pin = policy["hot_policy"] == "pin"
            is_correction = bool(policy.get("supersedes_memory_id"))
            if not (is_pin or is_correction):
                continue
            try:
                memory = self._cube(cube_id).text_mem.get(memory_id)
            except Exception:
                continue
            tags = {str(tag).casefold() for tag in (memory.metadata.tags or [])}
            info = memory.metadata.info or {}
            if self._excluded_from_derived(cube_id, list(tags)):
                continue
            if (
                "session-extracted" in tags
                and info.get("evidence_verified") is not True
                and not is_pin
            ):
                continue
            status = "archived" if memory_id in superseded else "active"
            valid_until = policy.get("valid_until")
            if valid_until:
                try:
                    if datetime.fromisoformat(valid_until.replace("Z", "+00:00")) < now:
                        status = "suspended"
                except ValueError:
                    status = "disputed"
            candidates.append(
                {
                    "item_id": str(uuid.uuid5(BRAIN_NAMESPACE, f"hot:{cube_id}:{memory_id}")),
                    "kind": "fact",
                    "content": memory.memory,
                    "heat": 1.0 if is_pin else 0.9,
                    "status": status,
                    "hot_policy": "pin" if is_pin else "auto",
                    "valid_until": valid_until,
                    "cube_id": cube_id,
                    "memory_id": memory_id,
                    "brain_page_id": None,
                    "sources": [{"cube_id": cube_id, "memory_id": memory_id}],
                    "reason": "明确置顶" if is_pin else "明确纠错并保留旧来源",
                    "supersedes_memory_id": policy.get("supersedes_memory_id"),
                }
            )

        pages = self.brain_store.list_pages(limit=BRAIN_MAX_PAGES).get("items", [])
        archives = self._archive_memory_records()
        provenance_records = dict(archives)
        provenance_cache: dict[str, dict[str, Any]] = {}
        for page in pages:
            try:
                detail = self.brain_store.get_page(page["page_id"])
            except BrainStoreError:
                continue
            sources: list[dict[str, Any]] = []
            brain_pinned = False
            evidence_groups: set[str] = set()
            page_blocked = False
            for source in detail.get("sources", []):
                try:
                    record, _archived = self._memory_record(
                        source["cube_id"], source["memory_id"], archives
                    )
                except Exception:
                    page_blocked = True
                    break
                source_id = self._brain_source_id(source["cube_id"], source["memory_id"])
                provenance_records[source_id] = record
                metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
                tags = {str(tag).casefold() for tag in metadata.get("tags") or []}
                if self._excluded_from_derived(source["cube_id"], list(tags)):
                    page_blocked = True
                    break
                if policies.get((source["cube_id"], source["memory_id"]), {}).get("hot_policy") == "exclude":
                    page_blocked = True
                    break
                provenance = self._provenance_for_record(
                    source_id, provenance_records, provenance_cache
                )
                if provenance["has_unverified_session_evidence"]:
                    page_blocked = True
                    break
                groups = source.get("evidence_group_ids") or provenance["evidence_group_ids"]
                evidence_groups.update(str(value) for value in groups if str(value).strip())
                sources.append(source)
                brain_pinned = brain_pinned or "brain:pin" in tags
            if page_blocked:
                continue
            if len(evidence_groups) < BRAIN_MIN_SOURCES and not brain_pinned:
                continue
            importance = float(page.get("importance", 0.0))
            confidence = float(page.get("confidence", 0.0))
            reuse = min(1.0, float(len(evidence_groups)) / 5.0)
            heat = min(1.0, 0.40 * importance + 0.35 * confidence + 0.15 * reuse + 0.10)
            if heat < 0.65:
                continue
            candidates.append(
                {
                    "item_id": str(uuid.uuid5(BRAIN_NAMESPACE, f"hot:brain:{page['page_id']}")),
                    "kind": {"workstream": "goal", "entity": "profile"}.get(page["page_type"], "fact"),
                    "content": page["summary"],
                    "heat": round(heat, 4),
                    "status": "active",
                    "hot_policy": "auto",
                    "valid_until": None,
                    "cube_id": sources[0]["cube_id"] if len({s["cube_id"] for s in sources}) == 1 else None,
                    "memory_id": None,
                    "brain_page_id": page["page_id"],
                    "sources": [
                        {"cube_id": source["cube_id"], "memory_id": source["memory_id"]}
                        for source in sources
                    ],
                    "reason": (
                        "brain:pin 单来源 Brain Page"
                        if len(evidence_groups) < BRAIN_MIN_SOURCES
                        else "至少两个独立证据组支持的 Brain Page"
                    ),
                    "supersedes_memory_id": None,
                }
            )
        return candidates

    def _render_hot_context(self, items: list[dict[str, Any]], version: int | None = None) -> str:
        max_chars, direct_limit, brain_limit, map_limit = self._hot_render_limits()
        headings = {
            "fact": "稳定事实", "profile": "核心画像", "constraint": "当前约束",
            "goal": "活跃目标", "change": "最近变化", "todo": "未完成事项",
        }
        eligible = [
            item for item in items
            if item["status"] == "active"
            and (item["hot_policy"] == "pin" or float(item["heat"]) >= 0.65)
        ]
        direct = sorted(
            (item for item in eligible if not item.get("brain_page_id")),
            key=lambda item: (item["hot_policy"] == "pin", float(item["heat"])),
            reverse=True,
        )
        brain = sorted(
            (item for item in eligible if item.get("brain_page_id")),
            key=lambda item: float(item["heat"]),
            reverse=True,
        )

        def take(values: list[dict[str, Any]], budget: int) -> list[dict[str, Any]]:
            selected: list[dict[str, Any]] = []
            used = 0
            for item in values:
                size = len(self._hot_item_line(item)) + 1
                if used + size <= budget:
                    selected.append(item)
                    used += size
            return selected

        pinned = [item for item in direct if item["hot_policy"] == "pin"]
        if sum(len(self._hot_item_line(item)) + 1 for item in pinned) > direct_limit:
            raise HotMemoryError("Pinned hot memories exceed their 55% context budget")
        selected_direct = take(direct, direct_limit)
        brain_seeds = [
            next((item for item in brain if item["kind"] == kind), None)
            for kind in ("fact", "goal", "profile")
        ]
        brain_order = [item for item in brain_seeds if item is not None]
        brain_order.extend(item for item in brain if item not in brain_order)
        selected = selected_direct + take(brain_order, brain_limit)

        lines = [
            f"# MemOS 热记忆 · v{version or 0}", "",
            "> 可重建的只读派生快照；详细证据仍以 MemOS 原始记忆为准。",
        ]
        for kind in ("constraint", "goal", "change", "todo", "fact", "profile"):
            section = [item for item in selected if item["kind"] == kind]
            if not section:
                continue
            lines.extend(["", f"## {headings[kind]}"])
            lines.extend(self._hot_item_line(item) for item in section)
        cube_map = self.hot_store.cube_map()
        if cube_map:
            lines.extend(["", "## 检索地图"])
            map_used = 0
            active = [cube for cube in cube_map if cube["status"] == "active"]
            cold = [cube for cube in cube_map if cube["status"] != "active"]
            for cube in active:
                line = f"- `{cube['cube_id']}` {cube['name']}：{cube['description']}；{cube['search_when']}"
                if map_used + len(line) + 1 > map_limit:
                    break
                lines.append(line)
                map_used += len(line) + 1
            if cold:
                line = "- 冷库：" + "、".join(f"`{cube['cube_id']}`" for cube in cold)
                if map_used + len(line) + 1 <= map_limit:
                    lines.append(line)
                    map_used += len(line) + 1
            fallback = "- 热地图不明确时搜索 `index`；全库搜索只能显式调用。"
            if map_used + len(fallback) + 1 <= map_limit:
                lines.append(fallback)
        return ("\n".join(lines).strip() + "\n")[:max_chars]

    def rebuild_hot_memory(self, trigger: str = "manual", use_remote: bool = True) -> dict[str, Any]:
        from .service import ManagedMemoryError

        if not self.hot_store.enabled:
            return {"enabled": False, "status": "disabled"}
        if not self._maintenance_lock.acquire(blocking=False):
            return {"enabled": True, "status": "busy"}
        run_id = ""
        candidates: list[dict[str, Any]] = []
        dirty_at = self.hot_store.get_meta("dirty_at")
        try:
            candidates = self._hot_candidates_from_sources()
            run_id = self.hot_store.record_compile_start(trigger, "deterministic-local", len(candidates))
            items = candidates
            items.sort(
                key=lambda value: (value["hot_policy"] == "pin", float(value["heat"])),
                reverse=True,
            )
            latest = self.hot_store.latest_snapshot()
            next_version = int(latest["version"] if latest else 0) + 1
            snapshot = self.hot_store.write_compiled_snapshot(
                items,
                self._render_hot_context(items, next_version),
                int(getattr(self.settings, "hot_target_tokens", 2000)),
                int(getattr(self.settings, "hot_hard_limit_tokens", 2500)),
                "deterministic-local",
                {"candidate_count": len(candidates), "item_count": len(items), "trigger": trigger},
            )
            self.hot_store.finish_compile(run_id, "success", len(items), snapshot["version"])
            self.hot_store.settle_dirty_after_compile(dirty_at)
            self._audit("hot_memory_rebuilt", version=snapshot["version"], trigger=trigger, item_count=len(items))
            return {"enabled": True, "status": "success", "item_count": len(items), **snapshot}
        except Exception as exc:
            if run_id:
                self.hot_store.finish_compile(run_id, "failed", len(candidates), error_type=type(exc).__name__)
                self.hot_store.settle_dirty_after_compile(dirty_at)
            self._audit("hot_memory_rebuild_failed", trigger=trigger, error_type=type(exc).__name__)
            raise ManagedMemoryError(
                f"Hot-memory compilation failed; previous snapshot preserved ({type(exc).__name__})"
            ) from exc
        finally:
            self._maintenance_lock.release()

    def hot_status(self) -> dict[str, Any]:
        return {
            **self.hot_store.status(),
            "fts": self.search_index.status(),
            "client_ingest_enabled": bool(getattr(self.settings, "client_ingest_enabled", True)),
        }

    def get_hot_context(self, since_version: int | None = None) -> dict[str, Any]:
        from .service import ManagedMemoryError

        if since_version is not None and since_version < 0:
            raise ManagedMemoryError("since_version must be zero or greater")
        return self.hot_store.get_context(since_version)

    def route_memory(
        self,
        query: str,
        context_sufficient: bool = False,
        hot_version: int | None = None,
        caller: str = "mcp",
    ) -> dict[str, Any]:
        from .service import ManagedMemoryError

        try:
            return self.hot_store.route(query, context_sufficient, hot_version, caller)
        except HotMemoryError as exc:
            raise ManagedMemoryError(str(exc)) from exc

    def set_memory_policy(
        self,
        cube_id: str,
        memory_id: str,
        hot_policy: str,
        valid_until: str | None = None,
        supersedes_memory_id: str | None = None,
    ) -> dict[str, Any]:
        from .service import ManagedMemoryError

        self._validate_cube_id(cube_id)
        memory = self._cube(cube_id).text_mem.get(memory_id)
        if supersedes_memory_id:
            self._cube(cube_id).text_mem.get(supersedes_memory_id)
        if hot_policy.strip().lower() == "pin":
            self._ensure_hot_pin_capacity(
                memory.memory,
                exclude_source=(cube_id, memory_id),
            )
        try:
            result = self.hot_store.set_policy(
                cube_id, memory_id, hot_policy.strip().lower(), valid_until, supersedes_memory_id
            )
        except HotMemoryError as exc:
            raise ManagedMemoryError(str(exc)) from exc
        self.rebuild_hot_memory(trigger="memory_policy", use_remote=False)
        self._audit("memory_policy_updated", cube_id=cube_id, memory_id=memory_id, hot_policy=hot_policy)
        return result

    def list_hot_items(self, limit: int = 200) -> dict[str, Any]:
        return {"items": self.hot_store.list_items()[: max(1, min(limit, 500))]}

    def list_hot_cubes(self) -> dict[str, Any]:
        return {"items": self.hot_store.cube_map()}

    def list_hot_candidates(self, limit: int = 200) -> dict[str, Any]:
        return {"items": self.hot_store.list_candidates(max(1, min(limit, 500)))}

    def list_hot_routes(self, limit: int = 100) -> dict[str, Any]:
        return {"items": self.hot_store.list_routes(max(1, min(limit, 500)))}

    def list_hot_runs(self, limit: int = 100) -> dict[str, Any]:
        return {"items": self.hot_store.list_runs(max(1, min(limit, 500)))}

    def record_hook_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        from .service import ManagedMemoryError

        if not bool(getattr(self.settings, "client_ingest_enabled", True)):
            return {"accepted": False, "reason": "client_ingest_disabled"}
        client = str(payload.get("client") or "")
        transcript_path = payload.get("transcript_path")
        if transcript_path:
            resolved = Path(str(transcript_path)).expanduser().resolve()
            allowed_root = (
                Path.home() / ".codex" if client == "codex"
                else Path.home() / ".claude" if client == "claude"
                else Path.home() / "Library" / "Application Support" / "Papertable"
                if client == "papertable"
                else None
            )
            if allowed_root is None or allowed_root.resolve() not in resolved.parents:
                raise ManagedMemoryError("Transcript path is outside the client data root")
            payload = {**payload, "transcript_path": str(resolved)}
        try:
            result = self.hot_store.record_session_event(payload)
        except (HotMemoryError, KeyError, TypeError, ValueError) as exc:
            raise ManagedMemoryError(str(exc)) from exc
        if result["extraction_due"]:
            threading.Thread(
                target=self.process_due_sessions,
                kwargs={"trigger": "hook"},
                name="memos-session-extractor",
                daemon=True,
            ).start()
        self._audit(
            "hook_event",
            client=result["client"],
            session_id_sha256=hashlib.sha256(result["session_id"].encode()).hexdigest(),
            turn_count=result["turn_count"],
            extraction_due=result["extraction_due"],
        )
        return result

    @staticmethod
    def _papertable_stage_behavior(text: str) -> dict[str, int]:
        """Read deterministic interaction evidence from complete Papertable stages."""
        evidence = {
            "follow_up_depth": 0,
            "branch_count": 0,
            "completed_turns": 0,
            "acceptance": 0,
        }
        for line in text.splitlines():
            try:
                stage = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(stage, dict):
                continue
            if stage.get("memoryMode") == "acceptance":
                evidence["acceptance"] = 1
            phase = stage.get("phase")
            if not isinstance(phase, dict):
                continue
            try:
                evidence["follow_up_depth"] = max(
                    evidence["follow_up_depth"],
                    int(phase.get("followUpDepth") or 0),
                )
                evidence["branch_count"] = max(
                    evidence["branch_count"],
                    int(phase.get("branchCount") or 0),
                )
                evidence["completed_turns"] = max(
                    evidence["completed_turns"],
                    int(phase.get("completedTurns") or 0),
                )
            except (TypeError, ValueError):
                continue
        return evidence

    @staticmethod
    def _papertable_behavior_is_strong(evidence: dict[str, int]) -> bool:
        """Only repeated entry can cross MemOS' existing auto-write threshold."""
        follow_up_depth = evidence["follow_up_depth"]
        branch_count = evidence["branch_count"]
        return (
            follow_up_depth >= 2
            or (follow_up_depth >= 1 and branch_count >= 2)
            or branch_count >= 4
        )

    @staticmethod
    def _session_user_evidence(
        session: dict[str, Any], text: str, max_chars: int
    ) -> list[dict[str, Any]]:
        """Parse only genuine human-message events; unknown clients fail closed."""
        client = str(session.get("client") or "")
        session_id = str(session.get("session_id") or "")
        group_id = f"conversation:{client}:{session_id}"
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        used = 0
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(event, dict):
                continue
            raw_id = ""
            occurred_at = event.get("timestamp")
            message = ""
            if client == "codex":
                payload = event.get("payload")
                if event.get("type") != "event_msg" or not isinstance(payload, dict):
                    continue
                if payload.get("type") != "user_message":
                    continue
                message = payload.get("message") if isinstance(payload.get("message"), str) else ""
                raw_id = str(payload.get("client_id") or event.get("id") or "")
            elif client == "claude":
                payload = event.get("message")
                if (
                    event.get("type") != "user"
                    or event.get("isMeta") is True
                    or not isinstance(payload, dict)
                    or payload.get("role") != "user"
                    or not isinstance(payload.get("content"), str)
                ):
                    continue
                message = re.sub(
                    r"<system-reminder>.*?</system-reminder>",
                    "",
                    payload["content"],
                    flags=re.DOTALL | re.IGNORECASE,
                )
                raw_id = str(event.get("uuid") or "")
            else:
                return []

            message = message.strip()
            if not message or used >= max_chars:
                continue
            full_hash = hashlib.sha256(message.encode("utf-8")).hexdigest()
            if not raw_id:
                raw_id = full_hash
            evidence_id = f"{client}:user_message:{raw_id}"
            if evidence_id in seen:
                continue
            excerpt = message[: max_chars - used]
            if not excerpt:
                continue
            results.append(
                {
                    "id": evidence_id,
                    "group_id": group_id,
                    "role": "human_user",
                    "text": excerpt,
                    "occurred_at": occurred_at,
                    "sha256": full_hash,
                }
            )
            seen.add(evidence_id)
            used += len(excerpt)
        return results

    def _extract_session_candidates(self, session: dict[str, Any], text: str) -> list[dict[str, Any]]:
        from .service import (
            CHAT_CONTEXT_TOKENS,
            STRUCTURED_OUTPUT_TOKENS,
            ManagedMemoryError,
            openai_chat_completion,
        )

        is_papertable = session.get("client") == "papertable"
        papertable_behavior = (
            self._papertable_stage_behavior(text) if is_papertable else {}
        )
        if is_papertable and not (
            papertable_behavior["acceptance"] == 0
            and (
                papertable_behavior["follow_up_depth"] > 0
                or papertable_behavior["branch_count"] > 0
            )
        ):
            return []
        papertable_behavior_is_strong = (
            self._papertable_behavior_is_strong(papertable_behavior)
            if is_papertable
            else False
        )
        max_input_chars = CHAT_CONTEXT_TOKENS // 4
        user_evidence = (
            []
            if is_papertable
            else self._session_user_evidence(session, text, max_input_chars)
        )
        if not is_papertable and not user_evidence:
            return []
        session_text = text[:max_input_chars]
        cubes = [
            {"cube_id": cube["cube_id"], "description": cube["description"]}
            for cube in self.hot_store.cube_map()
        ]
        prompt = (
            "这是 Papertable 已完成阶段的 JSONL。只根据用户真实发生的追问链，以及深挖、"
            "发散、改道行为，提取用户已经反复进入的概念和概念之间的关系。一次性浅问不提取；"
            "不要把整篇助手回答抄成记忆，不要把来源原文冒充成用户观点。每个候选只写一条简洁、"
            "可供 Brain 整理的概念或关系，并把 cube_id 固定为 knowledge-universe。"
            "行为强度只由阶段包计数判断：followUpDepth 至少 2，或 followUpDepth 至少 1 且"
            "branchCount 至少 2，或 branchCount 至少 4，才属于强证据；其余只能作为待观察候选。"
            '返回严格 JSON：{"candidates":[{"kind":"stable_fact","content":"概念或关系",'
            '"confidence":0.0,"write_value":0.0,"cube_id":"knowledge-universe",'
            '"route_confidence":1.0,"conflict":"none|possible","reason":"对应的追问/分支行为"}]}。'
            "没有足够行为证据就返回空 candidates。\n阶段 JSONL："
            + session_text
            if is_papertable
            else
            "从会话增量中只提取用户本人明确表达的稳定事实、长期偏好、已形成的决定、"
            "有效约束、长期目标或有明确时间依据的事件。不要把助手建议归属于用户。"
            '返回严格 JSON：{"candidates":[{"kind":"stable_fact|preference|decision|constraint|goal|event",'
            '"content":"...","confidence":0.0,"write_value":0.0,"cube_id":"existing-id-or-null",'
            '"route_confidence":0.0,"conflict":"none|possible|explicit_correction",'
            '"occurred_at":"ISO-8601-or-null","ended_at":"ISO-8601-or-null",'
            '"location":"string-or-null","participants":["明确出现的参与者"],'
            '"reason":"...","evidence":[{"id":"允许的证据 ID","quote":"逐字短引文"}]}]}。'
            '每个候选必须引用至少一条下面提供的用户消息；id 必须完全匹配，quote 必须是该消息中'
            '不超过 1000 字符的逐字子串，否则候选无效。如果出现“不是、改为、纠正、以前说错”等新旧事实信号，'
            '必须标为 possible 或 explicit_correction；没有精确旧 memory_id 时不得自行覆盖。'
            '事件没有明确日期或可依据会话时间确定的时间时不要提取；地点和参与者不得猜测。'
            '禁止创建新 Cube。\n现有 Cube：'
            + json.dumps(cubes, ensure_ascii=False)
            + "\n仅允许使用的真实用户消息："
            + json.dumps(
                [
                    {
                        "id": value["id"],
                        "occurred_at": value.get("occurred_at"),
                        "text": value["text"],
                    }
                    for value in user_evidence
                ],
                ensure_ascii=False,
            )
        )
        raw_candidates = None
        for attempt in range(2 if is_papertable else 1):
            response, _model = openai_chat_completion(
                self.settings,
                prompt=(
                    prompt
                    if attempt == 0
                    else prompt
                    + "\n上一次响应不符合协议。只重发严格 JSON 对象，顶层必须包含 candidates 数组。"
                ),
                max_tokens=STRUCTURED_OUTPUT_TOKENS,
                json_object=True,
            )
            raw_candidates = self._parse_json_object(response).get("candidates")
            if isinstance(raw_candidates, list):
                break
        if not isinstance(raw_candidates, list):
            raise ManagedMemoryError("Session extractor returned no candidates array")
        allowed = {"stable_fact", "preference", "decision", "constraint", "goal", "event"}
        known_cubes = set(self.cubes) - {"index"}
        evidence_lookup = {value["id"]: value for value in user_evidence}
        if is_papertable:
            behavior_json = json.dumps(papertable_behavior, ensure_ascii=False, sort_keys=True)
            behavior_id = "papertable:behavior:" + hashlib.sha256(
                f"{session['session_id']}:{behavior_json}".encode("utf-8")
            ).hexdigest()
            papertable_evidence = [
                {
                    "id": behavior_id,
                    "group_id": f"conversation:papertable:{session['session_id']}",
                    "role": "behavioral_observation",
                    "quote": behavior_json,
                    "occurred_at": None,
                    "sha256": hashlib.sha256(behavior_json.encode("utf-8")).hexdigest(),
                }
            ]
        else:
            papertable_evidence = []
        results = []
        for raw in raw_candidates:
            if not isinstance(raw, dict) or raw.get("kind") not in allowed:
                continue
            content = " ".join(str(raw.get("content") or "").split())
            if not content or len(content) > 2000:
                continue
            try:
                confidence = max(0.0, min(1.0, float(raw.get("confidence", 0))))
                write_value = max(0.0, min(1.0, float(raw.get("write_value", 0))))
                route_confidence = max(0.0, min(1.0, float(raw.get("route_confidence", 0))))
            except (TypeError, ValueError):
                continue
            if is_papertable and papertable_behavior_is_strong:
                confidence = max(confidence, 0.92)
                write_value = max(write_value, 0.82)
            elif is_papertable:
                confidence = min(confidence, 0.89)
                write_value = min(write_value, 0.79)
            cube_id = (
                "knowledge-universe"
                if is_papertable and "knowledge-universe" in known_cubes
                else raw.get("cube_id") if raw.get("cube_id") in known_cubes else None
            )
            conflict = str(raw.get("conflict") or "possible").strip().lower()
            if conflict not in {"none", "possible", "explicit_correction"}:
                conflict = "possible"
            occurred_at = None
            ended_at = None
            if raw["kind"] == "event":
                try:
                    occurred_at = normalize_timestamp(raw.get("occurred_at"), "occurred_at")
                    ended_at = normalize_timestamp(raw.get("ended_at"), "ended_at")
                except MemorySchemaError:
                    continue
                if not occurred_at:
                    continue
            participants = raw.get("participants")
            if not isinstance(participants, list) or not all(
                isinstance(value, str) for value in participants
            ):
                participants = []
            candidate_evidence = list(papertable_evidence)
            if not is_papertable:
                references = raw.get("evidence")
                if not isinstance(references, list) or not references or len(references) > 8:
                    continue
                candidate_evidence = []
                referenced: set[str] = set()
                valid_evidence = True
                for reference in references:
                    if not isinstance(reference, dict):
                        valid_evidence = False
                        break
                    evidence_id = str(reference.get("id") or "")
                    quote = str(reference.get("quote") or "").strip()
                    source = evidence_lookup.get(evidence_id)
                    if (
                        source is None
                        or not quote
                        or len(quote) > 1000
                        or quote not in source["text"]
                    ):
                        valid_evidence = False
                        break
                    if evidence_id in referenced:
                        continue
                    referenced.add(evidence_id)
                    candidate_evidence.append(
                        {
                            "id": evidence_id,
                            "group_id": source["group_id"],
                            "role": source["role"],
                            "quote": quote,
                            "occurred_at": source.get("occurred_at"),
                            "sha256": source["sha256"],
                        }
                    )
                if not valid_evidence or not candidate_evidence:
                    continue
            root_evidence_ids = list(
                dict.fromkeys(value["id"] for value in candidate_evidence)
            )
            evidence_group_ids = list(
                dict.fromkeys(value["group_id"] for value in candidate_evidence)
            )
            results.append(
                {
                    "client": session["client"], "session_id": session["session_id"],
                    "kind": "stable_fact" if is_papertable else raw["kind"],
                    "content": content,
                    "confidence": confidence, "write_value": write_value,
                    "cube_id": cube_id,
                    "route_confidence": 1.0 if is_papertable and cube_id else route_confidence,
                    "reason": str(raw.get("reason") or "模型未提供原因")[:500],
                    "conflict": conflict,
                    "occurred_at": occurred_at,
                    "ended_at": ended_at,
                    "location": (
                        str(raw.get("location")).strip()[:500]
                        if raw.get("location")
                        else None
                    ),
                    "participants": participants[:50],
                    "origin_kind": (
                        "behavioral_observation" if is_papertable else "human_user_message"
                    ),
                    "evidence": candidate_evidence,
                    "root_evidence_ids": root_evidence_ids,
                    "evidence_group_ids": evidence_group_ids,
                    "evidence_verified": True,
                    "status": "pending" if conflict == "none" else "disputed",
                    "source_locator": (
                        f"{session['client']}:{session['session_id']}:"
                        f"{session['consumed_offset']}-{session['pending_offset']}"
                    ),
                }
            )
        return results

    def process_due_sessions(self, trigger: str = "scheduler") -> dict[str, Any]:
        if not bool(getattr(self.settings, "client_ingest_enabled", True)):
            return {"status": "disabled", "processed": 0}
        cutoff = datetime.fromtimestamp(time.time() - 1800, timezone.utc).isoformat()
        sessions = self.hot_store.sessions_due(inactive_before=cutoff)
        processed = written = pending = 0
        for session in sessions:
            transcript_path = session.get("transcript_path")
            if not transcript_path:
                continue
            try:
                path = Path(transcript_path).expanduser()
                size = path.stat().st_size
                start = int(session["consumed_offset"])
                end = min(int(session["pending_offset"] or size), size)
                if end <= start or end - start > 2_000_000:
                    continue
                with path.open("rb") as handle:
                    handle.seek(start)
                    text = handle.read(end - start).decode("utf-8", errors="replace")
                for candidate in self._extract_session_candidates(session, text):
                    saved = self.hot_store.add_candidate(candidate)
                    if not saved["created"] and not (
                        candidate["client"] == "papertable"
                        and saved["status"] == "pending"
                    ):
                        continue
                    if (
                        candidate["confidence"] >= 0.90
                        and candidate["write_value"] >= 0.80
                        and candidate["route_confidence"] >= 0.85
                        and candidate["cube_id"]
                        and candidate.get("conflict") == "none"
                        and candidate.get("evidence_verified") is True
                    ):
                        is_papertable = candidate["client"] == "papertable"
                        self.add_memory(
                            candidate["cube_id"], candidate["content"],
                            tags=(
                                ["papertable-stage", "session-extracted", "source-verified"]
                                if is_papertable else ["session-extracted", "source-verified"]
                            ),
                            source=candidate["source_locator"],
                            importance="normal",
                            semantic_type=(
                                "knowledge"
                                if is_papertable
                                else "fact" if candidate["kind"] == "stable_fact" else candidate["kind"]
                            ),
                            subject_type="system" if is_papertable else "user",
                            subject_id="papertable" if is_papertable else self.settings.user_id,
                            asserted_by="papertable" if is_papertable else self.settings.user_id,
                            client_id=candidate["client"],
                            conversation_id=candidate["session_id"],
                            occurred_at=candidate.get("occurred_at"),
                            ended_at=candidate.get("ended_at"),
                            location=candidate.get("location"),
                            participants=candidate.get("participants"),
                            confidence=candidate["confidence"],
                            attributes={"source_evidence": candidate["evidence"]},
                            origin_kind=candidate["origin_kind"],
                            root_evidence_ids=candidate["root_evidence_ids"],
                            evidence_group_ids=candidate["evidence_group_ids"],
                            evidence_verified=True,
                        )
                        self.hot_store.resolve_candidate(saved["candidate_id"], "auto_written")
                        written += 1
                    elif saved["created"]:
                        pending += 1
                self.hot_store.advance_session(session["client"], session["session_id"], end)
                processed += 1
            except Exception as exc:
                self._logger_warning("Session extraction deferred", exc)
                # Offset is intentionally unchanged; the next run remains idempotent.
        return {"status": "ok", "trigger": trigger, "processed": processed, "written": written, "pending": pending}

    @staticmethod
    def _logger_warning(message: str, exc: Exception) -> None:
        import logging

        detail = " ".join(str(exc).split())[:300]
        logging.getLogger("memos_managed_mcp").warning(
            "%s after %s: %s",
            message,
            type(exc).__name__,
            detail or "no detail",
        )
