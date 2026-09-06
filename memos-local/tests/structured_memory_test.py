from __future__ import annotations

import sqlite3
import tempfile
import threading
import types
import unittest

from pathlib import Path

from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata

from memos_managed_mcp.memory_schema import (
    MemorySchemaError,
    descriptor_from_metadata,
    normalize_memory_fields,
)
from memos_managed_mcp.search_index import SearchIndex
from memos_managed_mcp.service import ManagedMemoryError, ManagedMemoryService


def make_item(
    memory_id: str,
    content: str,
    semantic_type: str,
    *,
    occurred_at: str | None = None,
    attributes: dict | None = None,
    locked_fields: list[str] | None = None,
) -> TextualMemoryItem:
    return TextualMemoryItem(
        id=memory_id,
        memory=content,
        metadata=TextualMemoryMetadata(
            user_id="qinshu",
            status="activated",
            type=semantic_type,
            source="conversation",
            visibility="private",
            updated_at="2026-07-22T00:00:00+00:00",
            info={
                "schema_version": 2,
                "managed_kind": "raw",
                "semantic_type": semantic_type,
                "subject_type": "user",
                "subject_id": "qinshu",
                "attributes": attributes or {},
                "occurred_at": occurred_at,
                "participants": [],
                "evidence_memory_ids": [],
                "locked_fields": locked_fields or [],
            },
        ),
    )


class FakePoint:
    def __init__(self, item: TextualMemoryItem, score: float):
        self.payload = item.model_dump()
        self.score = score


class FakeVectorDb:
    def __init__(self, items: list[tuple[TextualMemoryItem, float]]):
        self.points = [FakePoint(item, score) for item, score in items]

    def search(self, _vector, limit: int):
        return self.points[:limit]


class FakeMemory:
    def __init__(self, items: list[tuple[TextualMemoryItem, float]]):
        self.embedder = types.SimpleNamespace(embed=lambda _texts: [[0.1, 0.2]])
        self.vector_db = FakeVectorDb(items)
        self.saved = {item.id: item for item, _score in items}

    def get(self, memory_id: str):
        return self.saved[memory_id]

    def update(self, memory_id: str, item: TextualMemoryItem):
        self.saved[memory_id] = item
        for point in self.vector_db.points:
            if point.payload["id"] == memory_id:
                point.payload = item.model_dump()


class MemorySchemaTests(unittest.TestCase):
    def test_event_requires_grounded_time_and_normalizes_to_utc(self):
        with self.assertRaises(MemorySchemaError):
            normalize_memory_fields(default_user_id="qinshu", semantic_type="event")
        fields = normalize_memory_fields(
            default_user_id="qinshu",
            semantic_type="event",
            occurred_at="2026-07-22T10:30:00+08:00",
            participants=["qinshu", "Agent-A", "qinshu"],
        )
        self.assertEqual(fields["occurred_at"], "2026-07-22T02:30:00+00:00")
        self.assertEqual(fields["participants"], ["qinshu", "Agent-A"])

    def test_legacy_metadata_has_safe_defaults(self):
        metadata = TextualMemoryMetadata(user_id="qinshu", info={"managed_kind": "raw"})
        view = descriptor_from_metadata(metadata)
        self.assertEqual(view["semantic_type"], "fact")
        self.assertEqual(view["subject_id"], "qinshu")
        self.assertEqual(view["status"], "activated")


class SearchIndexV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "search.sqlite3"

    def tearDown(self):
        self.temp.cleanup()

    def test_v1_index_is_migrated_in_place(self):
        connection = sqlite3.connect(self.path)
        connection.executescript(
            """
            CREATE TABLE documents (
                rowid INTEGER PRIMARY KEY,
                cube_id TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                content TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                updated_at TEXT,
                UNIQUE(cube_id, memory_id)
            );
            CREATE VIRTUAL TABLE memory_fts USING fts5(
                content, cube_id UNINDEXED, memory_id UNINDEXED, tokenize='trigram'
            );
            CREATE TABLE search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO search_meta(key,value) VALUES('schema_version','1');
            """
        )
        connection.close()
        index = SearchIndex(self.path)
        self.assertEqual(index.status()["schema_version"], 2)
        with sqlite3.connect(self.path) as migrated:
            columns = {row[1] for row in migrated.execute("PRAGMA table_info(documents)")}
        self.assertTrue({"semantic_type", "subject_id", "occurred_at", "status"} <= columns)

    def test_type_subject_and_event_time_filters(self):
        index = SearchIndex(self.path)
        index.rebuild(
            [
                {
                    "cube_id": "alpha",
                    "memory_id": "fact",
                    "memory": "MemOS 发布计划",
                    "updated_at": "2026-07-20T00:00:00+00:00",
                    "metadata": {
                        "semantic_type": "fact",
                        "subject_type": "user",
                        "subject_id": "qinshu",
                        "status": "activated",
                    },
                },
                {
                    "cube_id": "alpha",
                    "memory_id": "event",
                    "memory": "MemOS 发布完成",
                    "updated_at": "2026-07-22T00:00:00+00:00",
                    "metadata": {
                        "semantic_type": "event",
                        "subject_type": "user",
                        "subject_id": "qinshu",
                        "status": "activated",
                        "occurred_at": "2026-07-22T00:00:00+00:00",
                    },
                },
            ]
        )
        filters = {
            "semantic_types": ["event"],
            "subject_ids": ["qinshu"],
            "statuses": ["activated"],
            "occurred_from": "2026-07-21T00:00:00+00:00",
            "current_time": "2026-07-22T12:00:00+00:00",
        }
        results = index.search("MemOS 发布", ["alpha"], filters=filters)
        self.assertEqual([item["memory_id"] for item in results], ["event"])


class StructuredServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        fact = make_item(
            "00000000-0000-0000-0000-000000000101", "最近的 MemOS 计划", "fact"
        )
        event = make_item(
            "00000000-0000-0000-0000-000000000102",
            "最近的 MemOS 发布事件",
            "event",
            occurred_at="2026-07-22T00:00:00+00:00",
        )
        self.memory = FakeMemory([(fact, 0.80), (event, 0.795)])
        self.service = ManagedMemoryService.__new__(ManagedMemoryService)
        self.service.settings = types.SimpleNamespace(
            user_id="qinshu",
            embed_model="test-embedding",
            rerank_model="test-reranker",
            retrieval_trace_path=root / "traces.jsonl",
            audit_path=root / "audit.jsonl",
        )
        self.service.cubes = {"alpha": types.SimpleNamespace(text_mem=self.memory)}
        self.service._cube_locks = {"alpha": threading.RLock()}
        self.service._last_probe = {}

    def tearDown(self):
        self.temp.cleanup()

    def test_event_query_gets_type_boost_and_filtering(self):
        result = self.service.search_memories(
            "最近发生的 MemOS 是什么",
            ["alpha"],
            top_k=2,
            rerank="off",
            search_mode="vector",
        )
        self.assertEqual(result["type_intent"], "event")
        self.assertEqual(
            result["results"][0]["memory_id"], "00000000-0000-0000-0000-000000000102"
        )
        filtered = self.service.search_memories(
            "MemOS",
            ["alpha"],
            rerank="off",
            search_mode="vector",
            semantic_types=["event"],
        )
        self.assertEqual(
            [item["memory_id"] for item in filtered["results"]],
            ["00000000-0000-0000-0000-000000000102"],
        )

    def test_profile_attribute_lock_requires_explicit_unlock(self):
        profile = make_item(
            "00000000-0000-0000-0000-000000000103",
            "用户公开名为秦述",
            "profile",
            attributes={"display_name": "秦述"},
            locked_fields=["display_name"],
        )
        self.memory.saved[profile.id] = profile
        self.memory.vector_db.points.append(FakePoint(profile, 0.7))
        with self.assertRaises(ManagedMemoryError):
            self.service.update_memory(
                "alpha",
                "00000000-0000-0000-0000-000000000103",
                attributes={"display_name": "其他名字"},
            )
        result = self.service.update_memory(
            "alpha",
            "00000000-0000-0000-0000-000000000103",
            attributes={"display_name": "秦述本人"},
            locked_fields=[],
        )
        self.assertEqual(result["memory_view"]["attributes"]["display_name"], "秦述本人")
        self.assertEqual(result["memory_view"]["locked_fields"], [])


if __name__ == "__main__":
    unittest.main()
