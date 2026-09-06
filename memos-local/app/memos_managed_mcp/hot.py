from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import uuid

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


HOT_KINDS = {"fact", "goal", "constraint", "change", "todo", "profile"}
HOT_POLICIES = {"auto", "pin", "exclude"}
HOT_STATUSES = {"active", "suspended", "disputed", "archived"}
HISTORY_CUES = re.compile(
    r"(?:之前|上次|继续|还记得|那个项目|过去|历史|原来|曾经|偏好|习惯|决定|约束|冲突|remember|previous|last time|continue)",
    re.I,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class HotMemoryError(RuntimeError):
    """Raised for invalid or unavailable derived hot-memory state."""


class HotMemoryStore:
    def __init__(self, path: Path, context_path: Path, enabled: bool = True):
        self.path = path
        self.context_path = context_path
        self.enabled = enabled
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if enabled:
            self._prepare()
            self._reconcile_context_file()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _prepare(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS hot_snapshots (
                    version INTEGER PRIMARY KEY,
                    generated_at TEXT NOT NULL,
                    target_tokens INTEGER NOT NULL,
                    hard_limit_tokens INTEGER NOT NULL,
                    char_count INTEGER NOT NULL,
                    model TEXT,
                    source_summary TEXT NOT NULL,
                    status TEXT NOT NULL,
                    context_md TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS hot_items (
                    item_id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    heat REAL NOT NULL,
                    status TEXT NOT NULL,
                    hot_policy TEXT NOT NULL,
                    valid_until TEXT,
                    cube_id TEXT,
                    memory_id TEXT,
                    brain_page_id TEXT,
                    sources_json TEXT NOT NULL,
                    reason TEXT,
                    supersedes_memory_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_hot_items_status_heat
                    ON hot_items(status, heat DESC);
                CREATE TABLE IF NOT EXISTS hot_cube_map (
                    cube_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    active_topics_json TEXT NOT NULL,
                    search_when TEXT NOT NULL,
                    activity_score REAL NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS hot_candidates (
                    candidate_id TEXT PRIMARY KEY,
                    client TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    content TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    write_value REAL NOT NULL,
                    cube_id TEXT,
                    route_confidence REAL,
                    reason TEXT NOT NULL,
                    source_locator TEXT,
                    origin_kind TEXT NOT NULL DEFAULT 'unknown',
                    evidence_json TEXT NOT NULL DEFAULT '[]',
                    evidence_groups_json TEXT NOT NULL DEFAULT '[]',
                    evidence_verified INTEGER NOT NULL DEFAULT 0,
                    content_sha256 TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    resolved_at TEXT
                );
                CREATE TABLE IF NOT EXISTS hot_routes (
                    routing_decision_id TEXT PRIMARY KEY,
                    timestamp TEXT NOT NULL,
                    client TEXT,
                    query_sha256 TEXT NOT NULL,
                    query_preview TEXT NOT NULL,
                    hot_version INTEGER,
                    context_sufficient INTEGER NOT NULL,
                    need_memory INTEGER NOT NULL,
                    signals_json TEXT NOT NULL,
                    cube_ids_json TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    actual_cube_ids_json TEXT
                );
                CREATE TABLE IF NOT EXISTS hot_compile_runs (
                    run_id TEXT PRIMARY KEY,
                    trigger TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    status TEXT NOT NULL,
                    model TEXT,
                    source_count INTEGER NOT NULL DEFAULT 0,
                    item_count INTEGER NOT NULL DEFAULT 0,
                    version INTEGER,
                    warning TEXT,
                    error_type TEXT
                );
                CREATE TABLE IF NOT EXISTS client_sessions (
                    client TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    transcript_path TEXT,
                    consumed_offset INTEGER NOT NULL DEFAULT 0,
                    pending_offset INTEGER NOT NULL DEFAULT 0,
                    turn_count INTEGER NOT NULL DEFAULT 0,
                    last_event_at TEXT NOT NULL,
                    last_fingerprint TEXT,
                    status TEXT NOT NULL DEFAULT 'active',
                    PRIMARY KEY(client, session_id)
                );
                CREATE TABLE IF NOT EXISTS memory_policies (
                    cube_id TEXT NOT NULL,
                    memory_id TEXT NOT NULL,
                    hot_policy TEXT NOT NULL,
                    importance TEXT NOT NULL DEFAULT 'normal',
                    valid_until TEXT,
                    supersedes_memory_id TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(cube_id, memory_id)
                );
                CREATE TABLE IF NOT EXISTS hot_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR IGNORE INTO hot_meta(key,value) VALUES('schema_version','1');
                INSERT OR IGNORE INTO hot_meta(key,value) VALUES('dirty','1');
                """
            )
            candidate_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(hot_candidates)")
            }
            candidate_migrations = {
                "origin_kind": "TEXT NOT NULL DEFAULT 'unknown'",
                "evidence_json": "TEXT NOT NULL DEFAULT '[]'",
                "evidence_groups_json": "TEXT NOT NULL DEFAULT '[]'",
                "evidence_verified": "INTEGER NOT NULL DEFAULT 0",
            }
            for name, definition in candidate_migrations.items():
                if name not in candidate_columns:
                    connection.execute(
                        f"ALTER TABLE hot_candidates ADD COLUMN {name} {definition}"
                    )
            connection.execute(
                "INSERT OR REPLACE INTO hot_meta(key,value) VALUES('schema_version','2')"
            )
        os.chmod(self.path, 0o600)

    def _reconcile_context_file(self) -> None:
        """Repair the crash window between SQLite commit and atomic file replacement."""
        snapshot = self.latest_snapshot()
        if snapshot is None:
            return
        expected = str(snapshot["context_md"])
        try:
            current = self.context_path.read_text(encoding="utf-8")
        except OSError:
            current = None
        if current != expected:
            self._atomic_write_context(expected)

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        return dict(row)

    def set_meta(self, key: str, value: str) -> None:
        if not self.enabled:
            return
        with self._connection() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO hot_meta(key,value) VALUES(?,?)", (key, value)
            )

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        if not self.enabled:
            return default
        with self._connection() as connection:
            row = connection.execute("SELECT value FROM hot_meta WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else default

    def mark_dirty(self, reason: str) -> None:
        self.set_meta("dirty", "1")
        self.set_meta("dirty_reason", reason[:200])
        self.set_meta("dirty_at", utc_now())

    def settle_dirty_after_compile(self, expected_dirty_at: str | None) -> bool:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT value FROM hot_meta WHERE key='dirty_at'"
            ).fetchone()
            unchanged = (str(row[0]) if row else None) == expected_dirty_at
            connection.execute(
                "UPDATE hot_meta SET value=? WHERE key='dirty'",
                ("0" if unchanged else "1",),
            )
        return unchanged

    def refresh_cube_map(self, cubes: list[dict[str, Any]]) -> dict[str, int]:
        if not self.enabled:
            return {"active": 0, "cold": 0}
        now = utc_now()
        seen: set[str] = set()
        ordered = sorted(
            (
                cube
                for cube in cubes
                if str(cube["cube_id"]) != "index" and not cube.get("excluded")
            ),
            key=lambda value: (value.get("updated_at", ""), value["cube_id"]),
            reverse=True,
        )
        desired: dict[str, tuple[Any, ...]] = {}
        for position, cube in enumerate(ordered):
            cube_id = str(cube["cube_id"])
            status = "active" if position < 20 else "cold"
            description = str(cube.get("description") or "")
            search_when = str(
                cube.get("search_when")
                or f"问题涉及{cube.get('name', cube_id)}或其历史决策时搜索"
            )
            score = float(
                cube.get("activity_score", max(0.0, 1.0 - position / 20))
            )
            desired[cube_id] = (
                str(cube.get("name") or cube_id),
                description,
                json.dumps(cube.get("active_topics") or [], ensure_ascii=False),
                search_when,
                score,
                status,
                str(cube.get("updated_at") or now),
            )
        with self._connection() as connection:
            existing = {
                str(row["cube_id"]): (
                    str(row["name"]),
                    str(row["description"]),
                    str(row["active_topics_json"]),
                    str(row["search_when"]),
                    float(row["activity_score"]),
                    str(row["status"]),
                    str(row["updated_at"]),
                )
                for row in connection.execute("SELECT * FROM hot_cube_map").fetchall()
            }
            for cube_id, values in desired.items():
                seen.add(cube_id)
                connection.execute(
                    """
                    INSERT INTO hot_cube_map(
                        cube_id,name,description,active_topics_json,search_when,
                        activity_score,status,updated_at
                    ) VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(cube_id) DO UPDATE SET
                        name=excluded.name, description=excluded.description,
                        active_topics_json=excluded.active_topics_json,
                        search_when=excluded.search_when, activity_score=excluded.activity_score,
                        status=excluded.status, updated_at=excluded.updated_at
                    """,
                    (cube_id, *values),
                )
            for row in connection.execute("SELECT cube_id FROM hot_cube_map").fetchall():
                if row[0] not in seen:
                    connection.execute("DELETE FROM hot_cube_map WHERE cube_id=?", (row[0],))
        if existing != desired:
            self.mark_dirty("cube_map_changed")
        return {"active": min(20, len(seen)), "cold": max(0, len(seen) - 20)}

    def cube_map(self) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM hot_cube_map ORDER BY status='active' DESC, activity_score DESC, cube_id"
            ).fetchall()
        result = []
        for row in rows:
            item = self._row(row)
            item["active_topics"] = json.loads(item.pop("active_topics_json"))
            result.append(item)
        return result

    def set_policy(
        self,
        cube_id: str,
        memory_id: str,
        hot_policy: str,
        valid_until: str | None,
        supersedes_memory_id: str | None,
        importance: str = "normal",
    ) -> dict[str, Any]:
        if hot_policy not in HOT_POLICIES:
            raise HotMemoryError("hot_policy must be one of: auto, pin, exclude")
        now = utc_now()
        desired = (hot_policy, importance, valid_until, supersedes_memory_id)
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT hot_policy,importance,valid_until,supersedes_memory_id
                FROM memory_policies WHERE cube_id=? AND memory_id=?
                """,
                (cube_id, memory_id),
            ).fetchone()
            previous = tuple(row) if row else None
            connection.execute(
                """
                INSERT INTO memory_policies(
                    cube_id,memory_id,hot_policy,importance,valid_until,
                    supersedes_memory_id,updated_at
                ) VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(cube_id,memory_id) DO UPDATE SET
                    hot_policy=excluded.hot_policy, importance=excluded.importance,
                    valid_until=excluded.valid_until,
                    supersedes_memory_id=excluded.supersedes_memory_id,
                    updated_at=excluded.updated_at
                """,
                (cube_id, memory_id, hot_policy, importance, valid_until, supersedes_memory_id, now),
            )
        if previous != desired and (previous is not None or hot_policy != "exclude"):
            self.mark_dirty("memory_policy_changed")
        return {
            "updated": True,
            "cube_id": cube_id,
            "memory_id": memory_id,
            "hot_policy": hot_policy,
            "valid_until": valid_until,
            "supersedes_memory_id": supersedes_memory_id,
        }

    def policies(self) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        with self._connection() as connection:
            return [
                self._row(row)
                for row in connection.execute(
                    "SELECT * FROM memory_policies ORDER BY updated_at DESC"
                ).fetchall()
            ]

    def replace_items(self, items: list[dict[str, Any]]) -> None:
        if not self.enabled:
            return
        now = utc_now()
        with self._connection() as connection:
            self._replace_items_in_connection(connection, items, now)

    @staticmethod
    def _replace_items_in_connection(
        connection: sqlite3.Connection,
        items: list[dict[str, Any]],
        now: str,
    ) -> None:
        connection.execute("DELETE FROM hot_items")
        for item in items:
            kind = str(item.get("kind", "fact"))
            status = str(item.get("status", "active"))
            policy = str(item.get("hot_policy", "auto"))
            if kind not in HOT_KINDS or status not in HOT_STATUSES or policy not in HOT_POLICIES:
                raise HotMemoryError("Invalid hot item enum value")
            content = str(item["content"]).strip()
            if not content:
                raise HotMemoryError("Hot item content must not be empty")
            connection.execute(
                """
                INSERT INTO hot_items(
                    item_id,kind,content,heat,status,hot_policy,valid_until,cube_id,
                    memory_id,brain_page_id,sources_json,reason,supersedes_memory_id,
                    created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    str(item.get("item_id") or uuid.uuid4()), kind, content,
                    float(item.get("heat", 0.65)), status, policy,
                    item.get("valid_until"), item.get("cube_id"),
                    item.get("memory_id"), item.get("brain_page_id"),
                    json.dumps(item.get("sources") or [], ensure_ascii=False),
                    item.get("reason"), item.get("supersedes_memory_id"),
                    str(item.get("created_at") or now), now,
                ),
            )

    def list_items(self, include_inactive: bool = True) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        where = "" if include_inactive else "WHERE status='active'"
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM hot_items {where} ORDER BY hot_policy='pin' DESC, heat DESC, updated_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            item = self._row(row)
            item["sources"] = json.loads(item.pop("sources_json"))
            result.append(item)
        return result

    def latest_snapshot(self) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM hot_snapshots WHERE status='success' ORDER BY version DESC LIMIT 1"
            ).fetchone()
        return self._row(row) if row else None

    def write_snapshot(
        self,
        context_md: str,
        target_tokens: int,
        hard_limit_tokens: int,
        model: str,
        source_summary: dict[str, Any],
    ) -> dict[str, Any]:
        if len(context_md) > 9500:
            raise HotMemoryError("Hot context exceeds the 9500-character hook limit")
        previous = self.latest_snapshot()
        version = int(previous["version"] if previous else 0) + 1
        generated_at = utc_now()
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO hot_snapshots(
                    version,generated_at,target_tokens,hard_limit_tokens,char_count,
                    model,source_summary,status,context_md
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                (
                    version, generated_at, target_tokens, hard_limit_tokens,
                    len(context_md), model,
                    json.dumps(source_summary, ensure_ascii=False, sort_keys=True),
                    "success", context_md,
                ),
            )
            connection.execute("INSERT OR REPLACE INTO hot_meta(key,value) VALUES('dirty','0')")
            connection.execute(
                "INSERT OR REPLACE INTO hot_meta(key,value) VALUES('last_compile_at',?)",
                (generated_at,),
            )
        self._atomic_write_context(context_md)
        return {
            "version": version,
            "generated_at": generated_at,
            "char_count": len(context_md),
            "target_tokens": target_tokens,
            "hard_limit_tokens": hard_limit_tokens,
        }

    def write_compiled_snapshot(
        self,
        items: list[dict[str, Any]],
        context_md: str,
        target_tokens: int,
        hard_limit_tokens: int,
        model: str,
        source_summary: dict[str, Any],
    ) -> dict[str, Any]:
        """Commit hot items, version metadata and the hook file as one recoverable unit."""
        if len(context_md) > 9500:
            raise HotMemoryError("Hot context exceeds the 9500-character hook limit")
        previous = self.latest_snapshot()
        version = int(previous["version"] if previous else 0) + 1
        generated_at = utc_now()
        previous_file = (
            self.context_path.read_text(encoding="utf-8")
            if self.context_path.exists()
            else None
        )
        descriptor, temp_name = tempfile.mkstemp(
            prefix=self.context_path.name + ".", dir=self.context_path.parent
        )
        replaced = False
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(context_md)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, 0o600)
            with self._connection() as connection:
                self._replace_items_in_connection(connection, items, generated_at)
                connection.execute(
                    """
                    INSERT INTO hot_snapshots(
                        version,generated_at,target_tokens,hard_limit_tokens,char_count,
                        model,source_summary,status,context_md
                    ) VALUES(?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        version, generated_at, target_tokens, hard_limit_tokens,
                        len(context_md), model,
                        json.dumps(source_summary, ensure_ascii=False, sort_keys=True),
                        "success", context_md,
                    ),
                )
                connection.execute(
                    "INSERT OR REPLACE INTO hot_meta(key,value) VALUES('dirty','0')"
                )
                connection.execute(
                    "INSERT OR REPLACE INTO hot_meta(key,value) VALUES('last_compile_at',?)",
                    (generated_at,),
                )
                os.replace(temp_name, self.context_path)
                replaced = True
            os.chmod(self.context_path, 0o600)
        except Exception:
            if replaced:
                if previous_file is None:
                    try:
                        self.context_path.unlink()
                    except FileNotFoundError:
                        pass
                else:
                    self._atomic_write_context(previous_file)
            raise
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
        return {
            "version": version,
            "generated_at": generated_at,
            "char_count": len(context_md),
            "target_tokens": target_tokens,
            "hard_limit_tokens": hard_limit_tokens,
        }

    def _atomic_write_context(self, content: str) -> None:
        self.context_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temp_name = tempfile.mkstemp(
            prefix=self.context_path.name + ".", dir=self.context_path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, self.context_path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)

    def get_context(self, since_version: int | None = None) -> dict[str, Any]:
        snapshot = self.latest_snapshot()
        if not snapshot:
            return {"enabled": self.enabled, "version": 0, "unchanged": False, "context": ""}
        version = int(snapshot["version"])
        if since_version is not None and since_version == version:
            return {"enabled": True, "version": version, "unchanged": True}
        return {
            "enabled": True,
            "version": version,
            "unchanged": False,
            "generated_at": snapshot["generated_at"],
            "target_tokens": snapshot["target_tokens"],
            "hard_limit_tokens": snapshot["hard_limit_tokens"],
            "char_count": snapshot["char_count"],
            "model": snapshot["model"],
            "context": snapshot["context_md"],
            "items": self.list_items(include_inactive=False),
            "cube_map": self.cube_map(),
        }

    def route(
        self,
        query: str,
        context_sufficient: bool = False,
        hot_version: int | None = None,
        client: str = "mcp",
    ) -> dict[str, Any]:
        query = " ".join(query.split())
        if not query:
            raise HotMemoryError("query must not be empty")
        snapshot = self.latest_snapshot()
        version = int(snapshot["version"]) if snapshot else 0
        signals: list[str] = []
        if HISTORY_CUES.search(query):
            signals.append("history_reference")
        lowered = query.casefold()
        scored: list[tuple[float, str]] = []
        for cube in self.cube_map():
            haystack = " ".join(
                [cube["cube_id"], cube["name"], cube["description"], cube["search_when"]]
            ).casefold()
            terms = {term for term in re.split(r"[^\w\u4e00-\u9fff]+", lowered) if len(term) >= 2}
            overlap = sum(1 for term in terms if term in haystack)
            direct = cube["cube_id"].casefold() in lowered or cube["name"].casefold() in lowered
            score = float(overlap) + (3.0 if direct else 0.0) + float(cube["activity_score"]) * 0.1
            if score > 0.2:
                scored.append((score, cube["cube_id"]))
                if direct:
                    signals.append("cube_name")
        scored.sort(reverse=True)
        cube_ids = [cube_id for _score, cube_id in scored[:2]]
        need_memory = bool(not context_sufficient and (signals or cube_ids))
        if context_sufficient:
            reason = "当前上下文已被调用方标记为充足"
        elif need_memory:
            reason = "检测到历史回指或热地图中的相关知识库"
        else:
            reason = "未检测到需要长期背景的强信号"
        decision_id = str(uuid.uuid4())
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO hot_routes(
                    routing_decision_id,timestamp,client,query_sha256,query_preview,
                    hot_version,context_sufficient,need_memory,signals_json,cube_ids_json,reason
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    decision_id, utc_now(), client,
                    hashlib.sha256(query.encode("utf-8")).hexdigest(), query[:300],
                    hot_version if hot_version is not None else version,
                    int(context_sufficient), int(need_memory),
                    json.dumps(sorted(set(signals)), ensure_ascii=False),
                    json.dumps(cube_ids, ensure_ascii=False), reason,
                ),
            )
        return {
            "routing_decision_id": decision_id,
            "hot_version": version,
            "need_memory": need_memory,
            "cube_ids": cube_ids,
            "signals": sorted(set(signals)),
            "reason": reason,
        }

    def link_route(self, decision_id: str, cube_ids: list[str]) -> None:
        if not decision_id:
            return
        with self._connection() as connection:
            changed = connection.execute(
                "UPDATE hot_routes SET actual_cube_ids_json=? WHERE routing_decision_id=?",
                (json.dumps(cube_ids, ensure_ascii=False), decision_id),
            ).rowcount
        if not changed:
            raise HotMemoryError("routing_decision_id does not reference a known route")

    def list_routes(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM hot_routes ORDER BY timestamp DESC LIMIT ?", (limit,)
            ).fetchall()
        result = []
        for row in rows:
            item = self._row(row)
            item["context_sufficient"] = bool(item["context_sufficient"])
            item["need_memory"] = bool(item["need_memory"])
            item["signals"] = json.loads(item.pop("signals_json"))
            item["cube_ids"] = json.loads(item.pop("cube_ids_json"))
            raw_actual = item.pop("actual_cube_ids_json")
            item["actual_cube_ids"] = json.loads(raw_actual) if raw_actual else None
            result.append(item)
        return result

    def add_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
        content = " ".join(str(candidate["content"]).split())
        evidence_groups = sorted(
            {str(value) for value in candidate.get("evidence_group_ids") or []}
        )
        digest = hashlib.sha256(
            json.dumps(
                {"content": content, "evidence_group_ids": evidence_groups},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        candidate_id = str(uuid.uuid4())
        with self._connection() as connection:
            existing = connection.execute(
                "SELECT candidate_id,status FROM hot_candidates WHERE content_sha256=?", (digest,)
            ).fetchone()
            if existing:
                return {"created": False, "candidate_id": existing[0], "status": existing[1]}
            connection.execute(
                """
                INSERT INTO hot_candidates(
                    candidate_id,client,session_id,kind,content,confidence,write_value,
                    cube_id,route_confidence,reason,source_locator,origin_kind,
                    evidence_json,evidence_groups_json,evidence_verified,
                    content_sha256,status,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    candidate_id, candidate["client"], candidate["session_id"],
                    candidate["kind"], content, float(candidate["confidence"]),
                    float(candidate["write_value"]), candidate.get("cube_id"),
                    candidate.get("route_confidence"), candidate["reason"],
                    candidate.get("source_locator"), candidate.get("origin_kind", "unknown"),
                    json.dumps(candidate.get("evidence") or [], ensure_ascii=False),
                    json.dumps(evidence_groups, ensure_ascii=False),
                    int(candidate.get("evidence_verified") is True), digest,
                    candidate.get("status", "pending"), utc_now(),
                ),
            )
        return {"created": True, "candidate_id": candidate_id, "status": candidate.get("status", "pending")}

    def resolve_candidate(self, candidate_id: str, status: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE hot_candidates SET status=?, resolved_at=? WHERE candidate_id=?",
                (status, utc_now(), candidate_id),
            )

    def list_candidates(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM hot_candidates ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        results = []
        for row in rows:
            item = self._row(row)
            item["evidence"] = json.loads(item.pop("evidence_json"))
            item["evidence_group_ids"] = json.loads(item.pop("evidence_groups_json"))
            item["evidence_verified"] = bool(item["evidence_verified"])
            results.append(item)
        return results

    def record_compile_start(self, trigger: str, model: str, source_count: int) -> str:
        run_id = str(uuid.uuid4())
        started_at = utc_now()
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO hot_compile_runs(run_id,trigger,started_at,status,model,source_count) VALUES(?,?,?,?,?,?)",
                (run_id, trigger, started_at, "running", model, source_count),
            )
            connection.execute(
                "INSERT OR REPLACE INTO hot_meta(key,value) VALUES('last_compile_attempt_at',?)",
                (started_at,),
            )
        return run_id

    def finish_compile(
        self,
        run_id: str,
        status: str,
        item_count: int = 0,
        version: int | None = None,
        warning: str | None = None,
        error_type: str | None = None,
    ) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE hot_compile_runs SET completed_at=?,status=?,item_count=?,version=?,warning=?,error_type=?
                WHERE run_id=?
                """,
                (utc_now(), status, item_count, version, warning, error_type, run_id),
            )

    def list_runs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._connection() as connection:
            return [
                self._row(row)
                for row in connection.execute(
                    "SELECT * FROM hot_compile_runs ORDER BY started_at DESC LIMIT ?", (limit,)
                ).fetchall()
            ]

    def record_session_event(self, event: dict[str, Any]) -> dict[str, Any]:
        client = str(event["client"])
        session_id = str(event["session_id"])
        event_type = str(event["event_type"])
        if client not in {"codex", "claude", "cursor", "papertable"}:
            raise HotMemoryError("Unsupported hook client")
        if event_type not in {"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}:
            raise HotMemoryError("Unsupported hook event type")
        now = utc_now()
        transcript_path = event.get("transcript_path")
        pending_offset = max(0, int(event.get("transcript_offset") or 0))
        fingerprint = str(event.get("fingerprint") or "")[:128] or None
        with self._connection() as connection:
            current = connection.execute(
                "SELECT * FROM client_sessions WHERE client=? AND session_id=?",
                (client, session_id),
            ).fetchone()
            turn_count = int(current["turn_count"] if current else 0)
            if event_type == "Stop" and fingerprint != (current["last_fingerprint"] if current else None):
                turn_count += 1
            connection.execute(
                """
                INSERT INTO client_sessions(
                    client,session_id,transcript_path,consumed_offset,pending_offset,
                    turn_count,last_event_at,last_fingerprint,status
                ) VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(client,session_id) DO UPDATE SET
                    transcript_path=COALESCE(excluded.transcript_path,client_sessions.transcript_path),
                    pending_offset=MAX(client_sessions.pending_offset,excluded.pending_offset),
                    turn_count=excluded.turn_count,last_event_at=excluded.last_event_at,
                    last_fingerprint=COALESCE(excluded.last_fingerprint,client_sessions.last_fingerprint),
                    status=excluded.status
                """,
                (
                    client, session_id, transcript_path, int(current["consumed_offset"] if current else 0),
                    pending_offset, turn_count, now, fingerprint,
                    "ended" if event_type == "SessionEnd" else "active",
                ),
            )
        return {
            "accepted": True,
            "client": client,
            "session_id": session_id,
            "turn_count": turn_count,
            "extraction_due": event_type == "SessionEnd" or (turn_count > 0 and turn_count % 10 == 0),
        }

    def sessions_due(self, inactive_before: str | None = None) -> list[dict[str, Any]]:
        clauses = ["pending_offset > consumed_offset"]
        parameters: list[Any] = []
        if inactive_before:
            clauses.append("(status='ended' OR last_event_at < ? OR turn_count % 10 = 0)")
            parameters.append(inactive_before)
        else:
            clauses.append("(status='ended' OR turn_count % 10 = 0)")
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM client_sessions WHERE " + " AND ".join(clauses), parameters
            ).fetchall()
        return [self._row(row) for row in rows]

    def advance_session(self, client: str, session_id: str, offset: int) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE client_sessions SET consumed_offset=? WHERE client=? AND session_id=?",
                (offset, client, session_id),
            )

    def status(self) -> dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "status": "disabled", "version": 0}
        snapshot = self.latest_snapshot()
        with self._connection() as connection:
            counts = {
                "items": int(connection.execute("SELECT COUNT(*) FROM hot_items").fetchone()[0]),
                "cubes": int(connection.execute("SELECT COUNT(*) FROM hot_cube_map").fetchone()[0]),
                "candidates": int(connection.execute("SELECT COUNT(*) FROM hot_candidates WHERE status='pending'").fetchone()[0]),
                "routes": int(connection.execute("SELECT COUNT(*) FROM hot_routes").fetchone()[0]),
                "sessions": int(connection.execute("SELECT COUNT(*) FROM client_sessions").fetchone()[0]),
            }
        return {
            "enabled": True,
            "status": "ok",
            "version": int(snapshot["version"]) if snapshot else 0,
            "generated_at": snapshot["generated_at"] if snapshot else None,
            "char_count": int(snapshot["char_count"]) if snapshot else 0,
            "target_tokens": int(snapshot["target_tokens"]) if snapshot else 2000,
            "hard_limit_tokens": int(snapshot["hard_limit_tokens"]) if snapshot else 2500,
            "dirty": self.get_meta("dirty", "1") == "1",
            "dirty_reason": self.get_meta("dirty_reason"),
            "context_file": str(self.context_path),
            **counts,
        }
