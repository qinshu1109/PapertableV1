from __future__ import annotations

import json
import sqlite3

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


BRAIN_PAGE_TYPES = ("note", "concept", "entity", "workstream")
BRAIN_PAGE_STATUSES = ("active", "stale", "archived")


class BrainStoreError(RuntimeError):
    """Raised when the derived Brain Pages store is invalid or unavailable."""


class BrainStore:
    """Transactional SQLite store for derived, source-grounded Brain Pages."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.parent.chmod(0o700)
        self._prepare()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        try:
            yield connection
        finally:
            connection.close()

    def _prepare(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                PRAGMA synchronous = FULL;

                CREATE TABLE IF NOT EXISTS brain_pages (
                    page_id TEXT PRIMARY KEY,
                    page_type TEXT NOT NULL CHECK (
                        page_type IN ('note', 'concept', 'entity', 'workstream')
                    ),
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    sections_json TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    importance REAL NOT NULL,
                    mention_count INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('active', 'stale', 'archived')
                    ),
                    first_seen TEXT NOT NULL,
                    last_updated TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS brain_page_sources (
                    page_id TEXT NOT NULL REFERENCES brain_pages(page_id) ON DELETE CASCADE,
                    cube_id TEXT NOT NULL,
                    memory_id TEXT NOT NULL,
                    evidence_excerpt TEXT NOT NULL,
                    source_updated_at TEXT,
                    root_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
                    evidence_group_ids_json TEXT NOT NULL DEFAULT '[]',
                    PRIMARY KEY (page_id, cube_id, memory_id)
                );

                CREATE INDEX IF NOT EXISTS idx_brain_sources_memory
                    ON brain_page_sources(cube_id, memory_id);
                CREATE INDEX IF NOT EXISTS idx_brain_sources_page
                    ON brain_page_sources(page_id);

                CREATE TABLE IF NOT EXISTS brain_relations (
                    source_page_id TEXT NOT NULL REFERENCES brain_pages(page_id) ON DELETE CASCADE,
                    target_page_id TEXT NOT NULL REFERENCES brain_pages(page_id) ON DELETE CASCADE,
                    relation TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    evidence_json TEXT NOT NULL,
                    last_updated TEXT NOT NULL,
                    PRIMARY KEY (source_page_id, target_page_id, relation),
                    CHECK (source_page_id < target_page_id)
                );

                CREATE INDEX IF NOT EXISTS idx_brain_relations_target
                    ON brain_relations(target_page_id);

                CREATE TABLE IF NOT EXISTS brain_runs (
                    run_id TEXT PRIMARY KEY,
                    trigger TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    source_count INTEGER NOT NULL DEFAULT 0,
                    eligible_count INTEGER NOT NULL DEFAULT 0,
                    page_count INTEGER NOT NULL DEFAULT 0,
                    relation_count INTEGER NOT NULL DEFAULT 0,
                    model TEXT,
                    snapshot_sha256 TEXT,
                    warning TEXT,
                    error_type TEXT
                );

                CREATE TABLE IF NOT EXISTS brain_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            source_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(brain_page_sources)")
            }
            for name in ("root_evidence_ids_json", "evidence_group_ids_json"):
                if name not in source_columns:
                    connection.execute(
                        f"ALTER TABLE brain_page_sources ADD COLUMN {name} "
                        "TEXT NOT NULL DEFAULT '[]'"
                    )
            connection.commit()
        self.path.chmod(0o600)

    @staticmethod
    def _decode_page(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["sections"] = json.loads(result.pop("sections_json"))
        result["source_count"] = int(result.get("source_count") or 0)
        return result

    def counts(self) -> dict[str, int]:
        with self._connection() as connection:
            page_count = int(
                connection.execute("SELECT COUNT(*) FROM brain_pages").fetchone()[0]
            )
            relation_count = int(
                connection.execute("SELECT COUNT(*) FROM brain_relations").fetchone()[0]
            )
        return {"pages": page_count, "relations": relation_count}

    def latest_run(self) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM brain_runs
                ORDER BY started_at DESC
                LIMIT 1
                """
            ).fetchone()
        return dict(row) if row else None

    def latest_successful_run(self) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM brain_runs
                WHERE status = 'completed'
                ORDER BY completed_at DESC
                LIMIT 1
                """
            ).fetchone()
        return dict(row) if row else None

    def start_run(self, record: dict[str, Any]) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                INSERT INTO brain_runs (
                    run_id, trigger, status, started_at, source_count,
                    eligible_count, model, snapshot_sha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["run_id"],
                    record["trigger"],
                    record.get("status", "started"),
                    record["started_at"],
                    int(record.get("source_count", 0)),
                    int(record.get("eligible_count", 0)),
                    record.get("model"),
                    record.get("snapshot_sha256"),
                ),
            )
            connection.commit()

    def fail_run(
        self,
        run_id: str,
        completed_at: str,
        error_type: str,
        warning: str,
    ) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE brain_runs
                SET status = 'failed', completed_at = ?, error_type = ?, warning = ?
                WHERE run_id = ?
                """,
                (completed_at, error_type, warning[:500], run_id),
            )
            connection.commit()

    def _backup(self) -> None:
        if not self.path.exists() or self.counts()["pages"] == 0:
            return
        backup_path = self.path.with_suffix(self.path.suffix + ".bak")
        with self._connection() as source:
            destination = sqlite3.connect(backup_path)
            try:
                source.backup(destination)
            finally:
                destination.close()
        backup_path.chmod(0o600)

    def replace_snapshot(
        self,
        pages: list[dict[str, Any]],
        relations: list[dict[str, Any]],
        run_id: str,
        completed_at: str,
        warning: str | None = None,
    ) -> None:
        """Replace the derived graph atomically after a complete validated run."""
        self._backup()
        page_ids = {str(page["page_id"]) for page in pages}
        if len(page_ids) != len(pages):
            raise BrainStoreError("Brain snapshot contains duplicate page IDs")
        for relation in relations:
            if relation["source_page_id"] not in page_ids or relation["target_page_id"] not in page_ids:
                raise BrainStoreError("Brain relation refers to an unknown page")

        with self._connection() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("DELETE FROM brain_relations")
                connection.execute("DELETE FROM brain_page_sources")
                connection.execute("DELETE FROM brain_pages")
                for page in pages:
                    connection.execute(
                        """
                        INSERT INTO brain_pages (
                            page_id, page_type, title, summary, sections_json,
                            confidence, importance, mention_count, status,
                            first_seen, last_updated
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            page["page_id"],
                            page["page_type"],
                            page["title"],
                            page["summary"],
                            json.dumps(page.get("sections", []), ensure_ascii=False),
                            float(page["confidence"]),
                            float(page["importance"]),
                            int(page["mention_count"]),
                            page.get("status", "active"),
                            page["first_seen"],
                            page["last_updated"],
                        ),
                    )
                    for source in page.get("sources", []):
                        connection.execute(
                            """
                            INSERT INTO brain_page_sources (
                                page_id, cube_id, memory_id, evidence_excerpt,
                                source_updated_at, root_evidence_ids_json,
                                evidence_group_ids_json
                            ) VALUES (?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                page["page_id"],
                                source["cube_id"],
                                source["memory_id"],
                                source.get("evidence_excerpt", ""),
                                source.get("source_updated_at"),
                                json.dumps(source.get("root_evidence_ids", []), ensure_ascii=False),
                                json.dumps(source.get("evidence_group_ids", []), ensure_ascii=False),
                            ),
                        )
                for relation in relations:
                    connection.execute(
                        """
                        INSERT INTO brain_relations (
                            source_page_id, target_page_id, relation,
                            confidence, evidence_json, last_updated
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            relation["source_page_id"],
                            relation["target_page_id"],
                            relation["relation"],
                            float(relation["confidence"]),
                            json.dumps(relation.get("evidence_memory_ids", []), ensure_ascii=False),
                            relation["last_updated"],
                        ),
                    )
                connection.execute(
                    """
                    UPDATE brain_runs
                    SET status = 'completed', completed_at = ?, page_count = ?,
                        relation_count = ?, warning = ?
                    WHERE run_id = ?
                    """,
                    (completed_at, len(pages), len(relations), warning, run_id),
                )
                connection.execute(
                    """
                    INSERT INTO brain_meta(key, value) VALUES('last_completed_at', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                    (completed_at,),
                )
                connection.commit()
            except Exception:
                connection.rollback()
                raise

    def list_pages(
        self,
        page_type: str | None = None,
        cube_id: str | None = None,
        query: str | None = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        if page_type and page_type not in BRAIN_PAGE_TYPES:
            raise BrainStoreError(f"Unknown Brain page type: {page_type}")
        clauses = ["p.status = 'active'"]
        parameters: list[Any] = []
        if page_type:
            clauses.append("p.page_type = ?")
            parameters.append(page_type)
        if cube_id and cube_id != "all":
            clauses.append(
                "EXISTS (SELECT 1 FROM brain_page_sources s2 WHERE s2.page_id = p.page_id AND s2.cube_id = ?)"
            )
            parameters.append(cube_id)
        if query:
            clauses.append("(LOWER(p.title) LIKE ? OR LOWER(p.summary) LIKE ?)")
            needle = f"%{query.casefold()}%"
            parameters.extend((needle, needle))
        parameters.append(limit)
        sql = f"""
            SELECT p.*, COUNT(s.memory_id) AS source_count
            FROM brain_pages p
            LEFT JOIN brain_page_sources s ON s.page_id = p.page_id
            WHERE {' AND '.join(clauses)}
            GROUP BY p.page_id
            ORDER BY p.importance DESC, p.last_updated DESC, p.title ASC
            LIMIT ?
        """
        with self._connection() as connection:
            rows = connection.execute(sql, parameters).fetchall()
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM brain_pages p WHERE {' AND '.join(clauses)}",
                    parameters[:-1],
                ).fetchone()[0]
            )
        return {"items": [self._decode_page(row) for row in rows], "total": total}

    def get_page(self, page_id: str) -> dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT p.*, COUNT(s.memory_id) AS source_count
                FROM brain_pages p
                LEFT JOIN brain_page_sources s ON s.page_id = p.page_id
                WHERE p.page_id = ?
                GROUP BY p.page_id
                """,
                (page_id,),
            ).fetchone()
            if row is None:
                raise BrainStoreError(f"Unknown Brain page: {page_id}")
            sources = []
            for value in connection.execute(
                    """
                    SELECT cube_id, memory_id, evidence_excerpt, source_updated_at,
                           root_evidence_ids_json, evidence_group_ids_json
                    FROM brain_page_sources
                    WHERE page_id = ?
                    ORDER BY source_updated_at DESC, cube_id, memory_id
                    """,
                    (page_id,),
                ).fetchall():
                source = dict(value)
                source["root_evidence_ids"] = json.loads(
                    source.pop("root_evidence_ids_json")
                )
                source["evidence_group_ids"] = json.loads(
                    source.pop("evidence_group_ids_json")
                )
                sources.append(source)
            relation_rows = connection.execute(
                """
                SELECT r.*, p.page_type AS related_type, p.title AS related_title,
                       p.summary AS related_summary
                FROM brain_relations r
                JOIN brain_pages p ON p.page_id = CASE
                    WHEN r.source_page_id = ? THEN r.target_page_id
                    ELSE r.source_page_id
                END
                WHERE r.source_page_id = ? OR r.target_page_id = ?
                ORDER BY r.confidence DESC, p.title ASC
                """,
                (page_id, page_id, page_id),
            ).fetchall()
        page = self._decode_page(row)
        page["sources"] = sources
        page["related_pages"] = [
            {
                "page_id": value["target_page_id"]
                if value["source_page_id"] == page_id
                else value["source_page_id"],
                "page_type": value["related_type"],
                "title": value["related_title"],
                "summary": value["related_summary"],
                "relation": value["relation"],
                "confidence": value["confidence"],
                "evidence_memory_ids": json.loads(value["evidence_json"]),
            }
            for value in relation_rows
        ]
        return page

    def mark_pages_stale_by_source(self, cube_id: str, memory_id: str) -> int:
        """Immediately retire active pages whose live evidence was explicitly deleted."""
        with self._connection() as connection:
            changed = connection.execute(
                """
                UPDATE brain_pages
                SET status = 'stale'
                WHERE status = 'active'
                  AND page_id IN (
                      SELECT page_id FROM brain_page_sources
                      WHERE cube_id = ? AND memory_id = ?
                  )
                """,
                (cube_id, memory_id),
            ).rowcount
            connection.commit()
        return int(changed)

    def graph(self, cube_id: str | None = None, limit: int = 200) -> dict[str, Any]:
        page_result = self.list_pages(cube_id=cube_id, limit=limit)
        pages = page_result["items"]
        page_ids = {page["page_id"] for page in pages}
        links: list[dict[str, Any]] = []
        if page_ids:
            placeholders = ",".join("?" for _value in page_ids)
            with self._connection() as connection:
                rows = connection.execute(
                    f"""
                    SELECT * FROM brain_relations
                    WHERE source_page_id IN ({placeholders})
                      AND target_page_id IN ({placeholders})
                    ORDER BY confidence DESC
                    """,
                    (*page_ids, *page_ids),
                ).fetchall()
            links = [
                {
                    "source": row["source_page_id"],
                    "target": row["target_page_id"],
                    "kind": row["relation"],
                    "weight": row["confidence"],
                    "confidence": row["confidence"],
                    "evidence_memory_ids": json.loads(row["evidence_json"]),
                }
                for row in rows
            ]

        degree = {page_id: 0 for page_id in page_ids}
        for link in links:
            degree[link["source"]] += 1
            degree[link["target"]] += 1
        nodes = [
            {
                "id": page["page_id"],
                "kind": page["page_type"],
                "label": page["title"],
                "summary": page["summary"],
                "preview": page["summary"][:500],
                "source_count": page["source_count"],
                "updated_at": page["last_updated"],
                "confidence": page["confidence"],
                "importance": page["importance"],
                "degree": degree[page["page_id"]],
                "value": 2.0 + page["importance"] * 4.0 + min(2.0, degree[page["page_id"]] * 0.25),
            }
            for page in pages
        ]
        counts = {
            page_type: sum(node["kind"] == page_type for node in nodes)
            for page_type in BRAIN_PAGE_TYPES
        }
        return {
            "scope": cube_id or "all",
            "nodes": nodes,
            "links": links,
            "stats": {
                **counts,
                "pages": len(nodes),
                "relations": len(links),
                "available_pages": page_result["total"],
                "truncated": page_result["total"] > len(nodes),
            },
            "limits": {"max_pages": 200, "requested_pages": limit},
        }

    def list_runs(self, limit: int = 30) -> dict[str, Any]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM brain_runs ORDER BY started_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            total = int(connection.execute("SELECT COUNT(*) FROM brain_runs").fetchone()[0])
        return {"items": [dict(row) for row in rows], "total": total}
