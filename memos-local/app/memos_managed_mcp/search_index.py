from __future__ import annotations

import hashlib
import json
import os
import sqlite3

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator


class SearchIndexError(RuntimeError):
    """Raised when the disposable lexical index cannot be used safely."""


class SearchIndex:
    """Rebuildable SQLite FTS5 index for canonical Qdrant memories."""

    def __init__(self, path: Path, enabled: bool = True):
        self.path = path
        self.enabled = enabled
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if enabled:
            self._prepare()

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
        try:
            with self._connection() as connection:
                connection.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS documents (
                        rowid INTEGER PRIMARY KEY,
                        cube_id TEXT NOT NULL,
                        memory_id TEXT NOT NULL,
                        content TEXT NOT NULL,
                        content_sha256 TEXT NOT NULL,
                        updated_at TEXT,
                        UNIQUE(cube_id, memory_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_documents_cube
                        ON documents(cube_id, memory_id);
                    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                        content,
                        cube_id UNINDEXED,
                        memory_id UNINDEXED,
                        tokenize='trigram'
                    );
                    CREATE TABLE IF NOT EXISTS search_meta (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    """
                )
                columns = {
                    str(row[1])
                    for row in connection.execute("PRAGMA table_info(documents)").fetchall()
                }
                additions = {
                    "semantic_type": "TEXT NOT NULL DEFAULT 'fact'",
                    "managed_kind": "TEXT NOT NULL DEFAULT 'raw'",
                    "subject_type": "TEXT NOT NULL DEFAULT 'user'",
                    "subject_id": "TEXT",
                    "status": "TEXT NOT NULL DEFAULT 'activated'",
                    "occurred_at": "TEXT",
                    "ended_at": "TEXT",
                    "valid_until": "TEXT",
                }
                for name, declaration in additions.items():
                    if name not in columns:
                        connection.execute(
                            f"ALTER TABLE documents ADD COLUMN {name} {declaration}"
                        )
                connection.executescript(
                    """
                    CREATE INDEX IF NOT EXISTS idx_documents_semantic_type
                        ON documents(semantic_type, cube_id);
                    CREATE INDEX IF NOT EXISTS idx_documents_subject
                        ON documents(subject_type, subject_id, cube_id);
                    CREATE INDEX IF NOT EXISTS idx_documents_event_time
                        ON documents(occurred_at, cube_id);
                    CREATE INDEX IF NOT EXISTS idx_documents_status
                        ON documents(status, cube_id);
                    """
                )
                connection.execute(
                    "INSERT OR REPLACE INTO search_meta(key, value) VALUES('schema_version', '2')"
                )
            os.chmod(self.path, 0o600)
        except sqlite3.Error as exc:
            raise SearchIndexError(f"Unable to initialize FTS5: {type(exc).__name__}") from exc

    @staticmethod
    def content_hash(content: str, metadata: dict[str, Any] | None = None) -> str:
        payload = {"content": content, "metadata": metadata or {}}
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    @staticmethod
    def _index_metadata(metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        source = metadata or {}
        return {
            "semantic_type": str(source.get("semantic_type") or "fact"),
            "managed_kind": str(source.get("managed_kind") or "raw"),
            "subject_type": str(source.get("subject_type") or "user"),
            "subject_id": source.get("subject_id"),
            "status": str(source.get("status") or "activated"),
            "occurred_at": source.get("occurred_at"),
            "ended_at": source.get("ended_at"),
            "valid_until": source.get("valid_until"),
        }

    def upsert(
        self,
        cube_id: str,
        memory_id: str,
        content: str,
        updated_at: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        if not self.enabled:
            return False
        indexed = self._index_metadata(metadata)
        digest = self.content_hash(content, indexed)
        try:
            with self._connection() as connection:
                existing = connection.execute(
                    "SELECT rowid, content_sha256 FROM documents WHERE cube_id=? AND memory_id=?",
                    (cube_id, memory_id),
                ).fetchone()
                if existing and existing["content_sha256"] == digest:
                    return False
                if existing:
                    rowid = int(existing["rowid"])
                    connection.execute("DELETE FROM memory_fts WHERE rowid=?", (rowid,))
                    connection.execute(
                        """
                        UPDATE documents
                        SET content=?, content_sha256=?, updated_at=?, semantic_type=?,
                            managed_kind=?, subject_type=?, subject_id=?, status=?,
                            occurred_at=?, ended_at=?, valid_until=?
                        WHERE rowid=?
                        """,
                        (
                            content,
                            digest,
                            updated_at,
                            indexed["semantic_type"],
                            indexed["managed_kind"],
                            indexed["subject_type"],
                            indexed["subject_id"],
                            indexed["status"],
                            indexed["occurred_at"],
                            indexed["ended_at"],
                            indexed["valid_until"],
                            rowid,
                        ),
                    )
                else:
                    cursor = connection.execute(
                        """
                        INSERT INTO documents(
                            cube_id,memory_id,content,content_sha256,updated_at,
                            semantic_type,managed_kind,subject_type,subject_id,status,
                            occurred_at,ended_at,valid_until
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            cube_id,
                            memory_id,
                            content,
                            digest,
                            updated_at,
                            indexed["semantic_type"],
                            indexed["managed_kind"],
                            indexed["subject_type"],
                            indexed["subject_id"],
                            indexed["status"],
                            indexed["occurred_at"],
                            indexed["ended_at"],
                            indexed["valid_until"],
                        ),
                    )
                    rowid = int(cursor.lastrowid)
                connection.execute(
                    "INSERT INTO memory_fts(rowid,content,cube_id,memory_id) VALUES(?,?,?,?)",
                    (rowid, content, cube_id, memory_id),
                )
            return True
        except sqlite3.Error as exc:
            raise SearchIndexError(f"Unable to update FTS5: {type(exc).__name__}") from exc

    def delete(self, cube_id: str, memory_id: str) -> bool:
        if not self.enabled:
            return False
        try:
            with self._connection() as connection:
                row = connection.execute(
                    "SELECT rowid FROM documents WHERE cube_id=? AND memory_id=?",
                    (cube_id, memory_id),
                ).fetchone()
                if not row:
                    return False
                connection.execute("DELETE FROM memory_fts WHERE rowid=?", (row["rowid"],))
                connection.execute("DELETE FROM documents WHERE rowid=?", (row["rowid"],))
            return True
        except sqlite3.Error as exc:
            raise SearchIndexError(f"Unable to delete from FTS5: {type(exc).__name__}") from exc

    @staticmethod
    def _filter_sql(filters: dict[str, Any] | None, alias: str = "") -> tuple[str, list[Any]]:
        filters = filters or {}
        prefix = f"{alias}." if alias else ""
        clauses: list[str] = []
        params: list[Any] = []
        for filter_name, column in (
            ("semantic_types", "semantic_type"),
            ("managed_kinds", "managed_kind"),
            ("subject_types", "subject_type"),
            ("subject_ids", "subject_id"),
            ("statuses", "status"),
        ):
            values = filters.get(filter_name) or []
            if values:
                clauses.append(f"{prefix}{column} IN ({','.join('?' for _ in values)})")
                params.extend(values)
        if filters.get("occurred_from"):
            clauses.append(f"{prefix}occurred_at IS NOT NULL AND {prefix}occurred_at >= ?")
            params.append(filters["occurred_from"])
        if filters.get("occurred_to"):
            clauses.append(f"{prefix}occurred_at IS NOT NULL AND {prefix}occurred_at <= ?")
            params.append(filters["occurred_to"])
        if not filters.get("include_expired") and filters.get("current_time"):
            clauses.append(f"({prefix}valid_until IS NULL OR {prefix}valid_until > ?)")
            params.append(filters["current_time"])
        return (" AND " + " AND ".join(clauses) if clauses else ""), params

    def search(
        self,
        query: str,
        cube_ids: list[str],
        limit: int = 20,
        filters: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        if not self.enabled:
            raise SearchIndexError("FTS5 is disabled")
        query = query.strip()
        if not query or not cube_ids:
            return []
        placeholders = ",".join("?" for _ in cube_ids)
        document_filters, document_params = self._filter_sql(filters)
        joined_filters, joined_params = self._filter_sql(filters, "d")
        try:
            with self._connection() as connection:
                # The trigram tokenizer deliberately cannot match strings shorter than
                # three Unicode characters. A bounded LIKE fallback preserves useful
                # exact searches such as "M4" without changing tokenizer semantics.
                if len(query) < 3:
                    rows = connection.execute(
                        f"""
                        SELECT cube_id, memory_id, content, 0.0 AS rank_value
                        FROM documents
                        WHERE cube_id IN ({placeholders}) AND content LIKE ? ESCAPE '\\'
                            {document_filters}
                        ORDER BY updated_at DESC, rowid DESC
                        LIMIT ?
                        """,
                        (
                            *cube_ids,
                            "%" + self._escape_like(query) + "%",
                            *document_params,
                            limit,
                        ),
                    ).fetchall()
                else:
                    match = '"' + query.replace('"', '""') + '"'
                    rows = connection.execute(
                        f"""
                        SELECT d.cube_id, d.memory_id, d.content, bm25(memory_fts) AS rank_value
                        FROM memory_fts AS f
                        JOIN documents AS d ON d.rowid = f.rowid
                        WHERE memory_fts MATCH ? AND d.cube_id IN ({placeholders})
                            {joined_filters}
                        ORDER BY rank_value ASC
                        LIMIT ?
                        """,
                        (match, *cube_ids, *joined_params, limit),
                    ).fetchall()
        except sqlite3.Error as exc:
            raise SearchIndexError(f"FTS5 search failed: {type(exc).__name__}") from exc
        results = []
        for index, row in enumerate(rows, start=1):
            raw_score = float(row["rank_value"] or 0.0)
            results.append(
                {
                    "cube_id": row["cube_id"],
                    "memory_id": row["memory_id"],
                    "memory": row["content"],
                    "fts_rank": index,
                    "fts_score": round(1.0 / (1.0 + max(0.0, raw_score)), 8),
                }
            )
        return results

    @staticmethod
    def _escape_like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    def reconcile(self, records: Iterable[dict[str, Any]]) -> dict[str, int]:
        if not self.enabled:
            return {"documents": 0, "added_or_updated": 0, "deleted": 0}
        canonical: dict[tuple[str, str], dict[str, Any]] = {}
        for record in records:
            canonical[(str(record["cube_id"]), str(record["memory_id"]))] = record
        with self._connection() as connection:
            existing = {
                (row["cube_id"], row["memory_id"]): row["content_sha256"]
                for row in connection.execute(
                    "SELECT cube_id,memory_id,content_sha256 FROM documents"
                ).fetchall()
            }
        changed = 0
        for key, record in canonical.items():
            indexed = self._index_metadata(record.get("metadata"))
            if existing.get(key) != self.content_hash(str(record["memory"]), indexed):
                self.upsert(
                    key[0],
                    key[1],
                    str(record["memory"]),
                    record.get("updated_at"),
                    indexed,
                )
                changed += 1
        deleted = 0
        for key in set(existing) - set(canonical):
            if self.delete(*key):
                deleted += 1
        return {
            "documents": len(canonical),
            "added_or_updated": changed,
            "deleted": deleted,
        }

    def rebuild(self, records: Iterable[dict[str, Any]]) -> dict[str, int]:
        if not self.enabled:
            return {"documents": 0, "added_or_updated": 0, "deleted": 0}
        try:
            with self._connection() as connection:
                connection.execute("DELETE FROM memory_fts")
                connection.execute("DELETE FROM documents")
        except sqlite3.Error as exc:
            raise SearchIndexError(f"Unable to reset FTS5: {type(exc).__name__}") from exc
        return self.reconcile(records)

    def status(self) -> dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "status": "disabled", "documents": 0}
        try:
            with self._connection() as connection:
                count = int(connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
                schema_row = connection.execute(
                    "SELECT value FROM search_meta WHERE key='schema_version'"
                ).fetchone()
            return {
                "enabled": True,
                "status": "ok",
                "documents": count,
                "path": str(self.path),
                "tokenizer": "trigram",
                "schema_version": int(schema_row[0]) if schema_row else 1,
            }
        except sqlite3.Error as exc:
            return {
                "enabled": True,
                "status": "degraded",
                "documents": 0,
                "error_type": type(exc).__name__,
            }

    def document_hashes(self) -> dict[tuple[str, str], str]:
        if not self.enabled:
            return {}
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT cube_id,memory_id,content_sha256 FROM documents"
            ).fetchall()
        return {
            (str(row["cube_id"]), str(row["memory_id"])): str(row["content_sha256"])
            for row in rows
        }
