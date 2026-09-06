from __future__ import annotations

import json
import tempfile
import threading
import types
import unittest

from pathlib import Path
from unittest.mock import patch

from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata

from memos_managed_mcp.brain import BrainStore
from memos_managed_mcp.service import ManagedMemoryError, ManagedMemoryService


class FakePoint:
    def __init__(self, item: TextualMemoryItem, score: float, vector: list[float] | None = None):
        self.id = item.id
        self.payload = item.model_dump()
        self.score = score
        self.vector = vector or [score, 1 - score]


class FakeVectorDb:
    def __init__(self, points: list[FakePoint]):
        self.points = points

    def search(self, _vector, limit: int):
        return self.points[:limit]

    def get_by_ids(self, ids: list[str]):
        return [point for point in self.points if point.id in ids]


class FakeMemory:
    def __init__(self, items: list[tuple[TextualMemoryItem, float]]):
        self.embedder = types.SimpleNamespace(embed=lambda _texts: [[0.1, 0.2]])
        self.vector_db = FakeVectorDb([FakePoint(item, score) for item, score in items])
        self.saved: dict[str, TextualMemoryItem] = {}
        self.deleted: list[str] = []

    def add(self, items):
        for item in items:
            self.saved[item.id] = item

    def get(self, memory_id):
        return self.saved[memory_id]

    def delete(self, memory_ids):
        self.deleted.extend(memory_ids)
        for memory_id in memory_ids:
            self.saved.pop(memory_id, None)


def make_item(memory_id: str, text: str, cube_id: str) -> TextualMemoryItem:
    return TextualMemoryItem(
        id=memory_id,
        memory=text,
        metadata=TextualMemoryMetadata(
            user_id="qinshu",
            source="conversation",
            tags=["test"],
            updated_at="2026-07-20T00:00:00+00:00",
            info={"managed_kind": "raw", "cube_id": cube_id},
        ),
    )


class DashboardFeatureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.service = ManagedMemoryService.__new__(ManagedMemoryService)
        self.service.settings = types.SimpleNamespace(
            retrieval_trace_path=root / "traces.jsonl",
            audit_path=root / "audit.jsonl",
            compaction_journal_path=root / "compactions.jsonl",
            compaction_archive_path=root / "archive.jsonl",
            embed_model="test-embedding",
            rerank_model="test-reranker",
            chat_model="test-chat",
            user_id="qinshu",
            brain_enabled=True,
            brain_interval_hours=24.0,
        )
        self.service._last_probe = {}
        self.service.operation_lock = threading.RLock()
        self.service._brain_run_lock = threading.Lock()
        self.service.brain_store = BrainStore(root / "brain.sqlite3")
        alpha = make_item("00000000-0000-0000-0000-000000000001", "alpha design", "alpha")
        beta = make_item("00000000-0000-0000-0000-000000000002", "beta design", "beta")
        index = make_item("00000000-0000-0000-0000-000000000003", "Cube alpha", "index")
        self.memories = {
            "alpha": FakeMemory([(alpha, 0.72)]),
            "beta": FakeMemory([(beta, 0.82)]),
            "index": FakeMemory([(index, 0.91)]),
        }
        self.service.cubes = {
            cube_id: types.SimpleNamespace(text_mem=memory)
            for cube_id, memory in self.memories.items()
        }
        self.service.manifest = {
            "cubes": {
                "alpha": {"name": "Alpha", "description": "Alpha project memories"},
                "beta": {"name": "Beta", "description": "Beta project memories"},
                "index": {"name": "Index", "description": "Cube routing index"},
            }
        }
        self.service._all_items = types.MethodType(
            lambda service, cube_id: [
                TextualMemoryItem(**point.payload)
                for point in service.cubes[cube_id].text_mem.vector_db.points
            ],
            self.service,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_targeted_search_requires_explicit_cube(self):
        with self.assertRaises(ManagedMemoryError):
            self.service.search_memories("design", [])
        result = self.service.search_memories("design", ["alpha"], rerank="off")
        self.assertEqual(result["searched_cube_ids"], ["alpha"])
        self.assertEqual(result["results"][0]["cube_id"], "alpha")
        self.assertEqual(result["reranker"]["status"], "not_requested")

    def test_full_search_reranks_and_records_trace(self):
        with patch(
            "memos_managed_mcp.service.request_rerank",
            return_value=[(1, 0.99), (0, 0.25)],
        ):
            result = self.service.search_all_memories("design", top_k=2, rerank="auto")
        self.assertEqual(result["searched_cube_ids"], ["alpha", "beta"])
        self.assertEqual(result["results"][0]["cube_id"], "alpha")
        self.assertEqual(result["reranker"]["status"], "ok")
        traces = [
            json.loads(line)
            for line in self.service.settings.retrieval_trace_path.read_text().splitlines()
        ]
        self.assertEqual(traces[0]["query"], "design")
        self.assertEqual(traces[0]["scope"], "all")
        self.assertEqual(len(traces[0]["candidates"]), 2)

    def test_rerank_failure_falls_back_to_vector_order(self):
        with patch(
            "memos_managed_mcp.service.request_rerank",
            side_effect=ManagedMemoryError("upstream unavailable"),
        ):
            result = self.service.search_all_memories("design", top_k=2, rerank="auto")
        self.assertEqual(result["results"][0]["cube_id"], "beta")
        self.assertEqual(result["reranker"]["status"], "degraded")
        self.assertIn("vector ranking", result["warning"])

    def test_compaction_archives_sources_before_deleting(self):
        batch = [
            make_item("00000000-0000-0000-0000-000000000011", "fact one", "alpha"),
            make_item("00000000-0000-0000-0000-000000000012", "fact two", "alpha"),
        ]
        for index, item in enumerate(batch, 1):
            item.metadata.info.update(
                {
                    "root_evidence_ids": [f"root-{index}"],
                    "evidence_group_ids": [f"group-{index}"],
                    "evidence_verified": True,
                }
            )
        memory = self.memories["alpha"]
        memory.saved.update({item.id: item for item in batch})
        self.service._request_compaction_summary = types.MethodType(
            lambda _self, _batch, _ids: "fact one and fact two", self.service
        )
        result = self.service._compact_batch("alpha", batch)
        archive = [
            json.loads(line)
            for line in self.service.settings.compaction_archive_path.read_text().splitlines()
        ]
        self.assertEqual(archive[0]["status"], "sources_archived")
        self.assertEqual(len(archive[0]["sources"]), 2)
        self.assertEqual(archive[1]["status"], "summary_verified")
        self.assertEqual(set(result["source_ids"]), set(memory.deleted))
        summary = memory.saved[result["summary_ids"][0]]
        self.assertEqual(summary.metadata.info["root_evidence_ids"], ["root-1", "root-2"])
        self.assertEqual(summary.metadata.info["evidence_group_ids"], ["group-1", "group-2"])
        archived_source = self.service.get_memory("alpha", batch[0].id)
        self.assertTrue(archived_source["archived_by_compaction"])

    def test_compaction_summary_does_not_make_model_echo_source_ids(self):
        batch = [
            make_item("00000000-0000-0000-0000-000000000011", "fact one", "alpha"),
            make_item("00000000-0000-0000-0000-000000000012", "fact two", "alpha"),
        ]
        calls = []

        def complete(_settings, *, prompt, **kwargs):
            calls.append((prompt, kwargs))
            return '{"memory":"fact one and fact two"}', "test-model"

        with patch("memos_managed_mcp.service.openai_chat_completion", side_effect=complete):
            summary = self.service._request_compaction_summary(
                batch, [item.id for item in batch]
            )

        self.assertEqual(summary, "fact one and fact two")
        self.assertEqual(calls[0][1]["max_tokens"], 4096)
        self.assertTrue(calls[0][1]["json_object"])
        self.assertTrue(calls[0][0].endswith("explanations or extra fields."))
        self.assertNotIn('"source_ids"', calls[0][0])

    def test_compaction_summary_retries_one_invalid_model_response(self):
        batch = [
            make_item("00000000-0000-0000-0000-000000000011", "fact one", "alpha"),
            make_item("00000000-0000-0000-0000-000000000012", "fact two", "alpha"),
        ]

        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            side_effect=[
                ("not json", "test-model"),
                ('{"memory":"fact one and fact two"}', "test-model"),
            ],
        ) as complete:
            summary = self.service._request_compaction_summary(
                batch, [item.id for item in batch]
            )

        self.assertEqual(summary, "fact one and fact two")
        self.assertEqual(complete.call_count, 2)

    def test_legacy_bare_parent_id_resolves_within_cube(self):
        raw_id = "00000000-0000-0000-0000-000000000061"
        summary_id = "00000000-0000-0000-0000-000000000062"
        raw = self.service._serialize_item("alpha", make_item(raw_id, "raw fact", "alpha"))
        summary = self.service._serialize_item(
            "alpha", make_item(summary_id, "summary fact", "alpha")
        )
        summary["metadata"]["info"].update({"evidence_memory_ids": [raw_id]})
        summary["memory_view"]["evidence_memory_ids"] = [raw_id]
        records = {
            f"alpha::{raw_id}": raw,
            f"alpha::{summary_id}": summary,
        }

        provenance = self.service._provenance_for_record(
            f"alpha::{summary_id}", records
        )

        self.assertEqual(provenance["root_evidence_ids"], [f"alpha::{raw_id}"])
        self.assertEqual(provenance["evidence_group_ids"], [f"memory:alpha::{raw_id}"])

    def test_memory_graph_only_contains_curated_brain_pages(self):
        run_id = "00000000-0000-0000-0000-000000000090"
        self.service.brain_store.start_run(
            {
                "run_id": run_id,
                "trigger": "test",
                "started_at": "2026-07-20T00:00:00+00:00",
                "source_count": 2,
                "eligible_count": 2,
                "model": "test-chat",
                "snapshot_sha256": "abc",
            }
        )
        pages = [
            {
                "page_id": "00000000-0000-0000-0000-000000000091",
                "page_type": "concept",
                "title": "分层记忆",
                "summary": "使用索引选择少量知识库，再执行定向检索。",
                "sections": [{"heading": "规则", "content": "先索引后检索"}],
                "confidence": 0.91,
                "importance": 0.84,
                "mention_count": 2,
                "status": "active",
                "first_seen": "2026-07-20T00:00:00+00:00",
                "last_updated": "2026-07-20T00:00:01+00:00",
                "sources": [
                    {
                        "cube_id": "alpha",
                        "memory_id": "00000000-0000-0000-0000-000000000001",
                        "evidence_excerpt": "alpha design",
                        "source_updated_at": "2026-07-20T00:00:00+00:00",
                    },
                    {
                        "cube_id": "beta",
                        "memory_id": "00000000-0000-0000-0000-000000000002",
                        "evidence_excerpt": "beta design",
                        "source_updated_at": "2026-07-20T00:00:00+00:00",
                    },
                ],
            },
            {
                "page_id": "00000000-0000-0000-0000-000000000092",
                "page_type": "workstream",
                "title": "本地记忆系统",
                "summary": "面向多个 AI 工具的本地共享记忆工作流。",
                "sections": [],
                "confidence": 0.90,
                "importance": 0.88,
                "mention_count": 2,
                "status": "active",
                "first_seen": "2026-07-20T00:00:00+00:00",
                "last_updated": "2026-07-20T00:00:01+00:00",
                "sources": [
                    {
                        "cube_id": "alpha",
                        "memory_id": "00000000-0000-0000-0000-000000000001",
                        "evidence_excerpt": "alpha design",
                        "source_updated_at": "2026-07-20T00:00:00+00:00",
                    },
                    {
                        "cube_id": "beta",
                        "memory_id": "00000000-0000-0000-0000-000000000002",
                        "evidence_excerpt": "beta design",
                        "source_updated_at": "2026-07-20T00:00:00+00:00",
                    },
                ],
            },
        ]
        self.service.brain_store.replace_snapshot(
            pages,
            [
                {
                    "source_page_id": pages[0]["page_id"],
                    "target_page_id": pages[1]["page_id"],
                    "relation": "supports",
                    "confidence": 0.86,
                    "evidence_memory_ids": ["alpha::00000000-0000-0000-0000-000000000001"],
                    "last_updated": "2026-07-20T00:00:01+00:00",
                }
            ],
            run_id,
            "2026-07-20T00:00:01+00:00",
        )

        result = self.service.memory_graph(limit=10)

        self.assertEqual(result["stats"]["pages"], 2)
        self.assertEqual(result["stats"]["relations"], 1)
        self.assertEqual(result["stats"]["note"], 0)
        self.assertNotIn("memory_id", result["nodes"][0])
        detail = self.service.get_brain_page(pages[0]["page_id"])
        self.assertEqual(len(detail["sources"]), 2)
        self.assertEqual(detail["sources"][0]["root_evidence_ids"], [])
        self.assertEqual(detail["related_pages"][0]["page_id"], pages[1]["page_id"])

    def test_brain_snapshot_excludes_acceptance_memories(self):
        for cube_id in ("alpha", "beta"):
            point = self.memories[cube_id].vector_db.points[0]
            point.payload["metadata"]["tags"] = ["memos-acceptance"]
        total, eligible, _digest = self.service._brain_snapshot()
        self.assertEqual(total, 2)
        self.assertEqual(eligible, [])

    def test_brain_snapshot_quarantines_unverified_session_memories(self):
        point = self.memories["alpha"].vector_db.points[0]
        point.payload["metadata"]["tags"] = ["session-extracted"]
        point.payload["metadata"]["info"]["evidence_verified"] = False

        _total, eligible, _digest = self.service._brain_snapshot()

        self.assertNotIn(
            "alpha::00000000-0000-0000-0000-000000000001",
            {record["source_id"] for record in eligible},
        )

    def test_brain_candidate_prompt_declares_required_contract(self):
        source_id = "alpha::00000000-0000-0000-0000-000000000071"
        records = [
            {
                "source_id": source_id,
                "cube_id": "alpha",
                "prompt_content": "长期记忆回答前先查看索引。",
                "tags": ["durable"],
                "pinned": False,
            }
        ]
        calls = []

        def complete(_settings, *, prompt, **kwargs):
            calls.append((prompt, kwargs))
            return '{"unexpected":[]}', "test-model"

        with patch("memos_managed_mcp.service.openai_chat_completion", side_effect=complete):
            with self.assertRaisesRegex(ManagedMemoryError, "violated its output contract"):
                self.service._request_brain_candidates(records)

        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][1]["retry_empty_text"])
        self.assertIn("只返回一个 JSON 对象", calls[0][0])
        self.assertIn('{"pages":[]}', calls[0][0])
        self.assertIn("顶层必须且只能包含 pages 数组", calls[0][0])
        self.assertIn(source_id, calls[0][0])

    def test_brain_candidate_accepts_one_valid_unwrapped_page(self):
        source_id = "alpha::00000000-0000-0000-0000-000000000071"
        records = [
            {
                "source_id": source_id,
                "cube_id": "alpha",
                "prompt_content": "长期记忆回答前先查看索引。",
                "tags": ["durable"],
                "pinned": False,
            }
        ]
        response = {
            "page_key": "routing",
            "page_type": "concept",
            "title": "分层记忆路由",
            "summary": "回答长期记忆问题前先查看索引并限定检索范围。",
            "sections": [],
            "source_memory_ids": [source_id],
            "confidence": 0.9,
            "importance": 0.8,
        }

        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            return_value=(json.dumps(response, ensure_ascii=False), "test-model"),
        ):
            pages = self.service._request_brain_candidates(records)

        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["source_ids"], [source_id])

    def test_brain_candidate_discards_page_with_unknown_source(self):
        source_id = "alpha::00000000-0000-0000-0000-000000000071"
        records = [
            {
                "source_id": source_id,
                "cube_id": "alpha",
                "prompt_content": "长期记忆回答前先查看索引。",
                "tags": ["durable"],
                "pinned": False,
            }
        ]
        pages = [
            {
                "page_key": key,
                "page_type": "concept",
                "title": "分层记忆路由",
                "summary": "回答长期记忆问题前先查看索引并限定检索范围。",
                "sections": [],
                "source_memory_ids": [source],
                "confidence": 0.9,
                "importance": 0.8,
            }
            for key, source in (("bad", "invented::source"), ("good", source_id))
        ]

        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            return_value=(json.dumps({"pages": pages}, ensure_ascii=False), "test-model"),
        ):
            result = self.service._request_brain_candidates(records)

        self.assertEqual([page["page_key"] for page in result], ["good"])

    def test_brain_consolidation_prompt_declares_required_contract(self):
        source_id = "alpha::00000000-0000-0000-0000-000000000071"
        candidate = {
            "page_key": "routing",
            "page_type": "concept",
            "title": "分层记忆路由",
            "summary": "回答前先查看索引，再选择相关知识库。",
            "sections": [],
            "source_ids": [source_id],
            "confidence": 0.9,
            "importance": 0.8,
        }
        prompts = []

        def complete(_settings, *, prompt, **_kwargs):
            prompts.append(prompt)
            return (
                '{"pages":[{"page_type":"concept","title":"分层记忆路由",'
                '"summary":"回答前先查看索引，再选择相关知识库。",'
                f'"source_memory_ids":["{source_id}"],'
                '"confidence":0.9,"importance":0.8}]}',
                "test-model",
            )

        with patch("memos_managed_mcp.service.openai_chat_completion", side_effect=complete):
            pages, relations = self.service._request_brain_consolidation(
                [candidate], [], {source_id}, True, False, 10
            )

        self.assertEqual(pages[0]["source_ids"], [source_id])
        self.assertEqual(relations, [])
        self.assertEqual(len(prompts), 1)
        self.assertIn("只返回一个 JSON 对象", prompts[0])
        self.assertIn('{"pages":[]}', prompts[0])
        self.assertIn("顶层必须且只能包含 pages 数组", prompts[0])
        self.assertIn(source_id, prompts[0])

    def test_brain_consolidation_accepts_one_valid_unwrapped_page(self):
        source_id = "alpha::00000000-0000-0000-0000-000000000071"
        candidate = {
            "page_key": "routing",
            "page_type": "concept",
            "title": "分层记忆路由",
            "summary": "回答长期记忆问题前先查看索引并限定检索范围。",
            "sections": [],
            "source_ids": [source_id],
            "confidence": 0.9,
            "importance": 0.8,
        }
        response = {
            **candidate,
            "existing_page_id": None,
            "source_memory_ids": [source_id],
        }
        response.pop("source_ids")

        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            return_value=(json.dumps(response, ensure_ascii=False), "test-model"),
        ):
            pages, relations = self.service._request_brain_consolidation(
                [candidate], [], {source_id}, True, False, 10
            )

        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["source_ids"], [source_id])
        self.assertEqual(relations, [])

    def test_brain_relations_use_a_separate_output_contract(self):
        first_source = "alpha::00000000-0000-0000-0000-000000000071"
        second_source = "beta::00000000-0000-0000-0000-000000000072"
        candidates = [
            {
                "page_key": "routing",
                "page_type": "concept",
                "title": "分层记忆路由",
                "summary": "回答前先查看索引，再选择相关知识库。",
                "sections": [],
                "source_ids": [first_source],
                "confidence": 0.9,
                "importance": 0.8,
            },
            {
                "page_key": "shared",
                "page_type": "workstream",
                "title": "共享记忆",
                "summary": "多个客户端通过同一本地服务共享记忆。",
                "sections": [],
                "source_ids": [second_source],
                "confidence": 0.9,
                "importance": 0.8,
            },
        ]
        responses = iter(
            [
                '{"pages":['
                '{"page_key":"routing","page_type":"concept","title":"分层记忆路由",'
                '"summary":"回答前先查看索引，再选择相关知识库。",'
                f'"source_memory_ids":["{first_source}"],"confidence":0.9,"importance":0.8}},'
                '{"page_key":"shared","page_type":"workstream","title":"共享记忆",'
                '"summary":"多个客户端通过同一本地服务共享记忆。",'
                f'"source_memory_ids":["{second_source}"],"confidence":0.9,"importance":0.8}}]}}',
                '{"relations":[]}',
            ]
        )
        prompts = []

        def complete(_settings, *, prompt, **_kwargs):
            prompts.append(prompt)
            return next(responses), "test-model"

        with patch("memos_managed_mcp.service.openai_chat_completion", side_effect=complete):
            pages, relations = self.service._request_brain_consolidation(
                candidates, [], {first_source, second_source}, True, True, 10
            )

        self.assertEqual(len(pages), 2)
        self.assertEqual(relations, [])
        self.assertEqual(len(prompts), 2)
        self.assertIn("顶层必须且只能包含 pages 数组", prompts[0])
        self.assertIn("顶层必须且只能包含 relations数组", prompts[1])
        self.assertIn('{"relations":[]}', prompts[1])

    def test_brain_rebuild_promotes_only_grounded_pages_and_bounded_relations(self):
        first = make_item(
            "00000000-0000-0000-0000-000000000071",
            "长期记忆回答前先查看索引，再选择相关知识库。",
            "alpha",
        )
        second = make_item(
            "00000000-0000-0000-0000-000000000072",
            "跨工具共享记忆时继续使用索引路由并限制检索范围。",
            "beta",
        )
        first.metadata.tags = ["durable"]
        second.metadata.tags = ["durable"]
        self.memories["alpha"].vector_db.points = [FakePoint(first, 0.8)]
        self.memories["beta"].vector_db.points = [FakePoint(second, 0.8)]

        def candidates(_service, records):
            source_ids = [record["source_id"] for record in records]
            return [
                {
                    "page_key": "routing",
                    "existing_page_id": None,
                    "page_type": "concept",
                    "title": "分层记忆路由",
                    "summary": "先搜索索引，再选择少量相关知识库执行定向检索。",
                    "sections": [],
                    "source_ids": source_ids,
                    "confidence": 0.92,
                    "importance": 0.86,
                },
                {
                    "page_key": "shared-memory",
                    "existing_page_id": None,
                    "page_type": "workstream",
                    "title": "跨工具共享记忆",
                    "summary": "多个 AI 客户端通过同一个本地服务共享可控记忆。",
                    "sections": [],
                    "source_ids": source_ids,
                    "confidence": 0.90,
                    "importance": 0.82,
                },
            ]

        self.service._request_brain_candidates = types.MethodType(candidates, self.service)

        result = self.service.rebuild_brain_pages(trigger="test")

        self.assertTrue(result["rebuilt"])
        self.assertEqual(result["page_count"], 2)
        self.assertEqual(result["relation_count"], 0)
        graph = self.service.memory_graph()
        self.assertEqual({node["kind"] for node in graph["nodes"]}, {"concept", "workstream"})
        self.assertEqual(graph["stats"]["relations"], 0)

    def test_brain_rebuild_failure_records_batch_context(self):
        def fail_candidates(_service, _records):
            raise ManagedMemoryError("Chat Completions returned no text")

        self.service._request_brain_candidates = types.MethodType(
            fail_candidates,
            self.service,
        )

        with self.assertRaisesRegex(
            ManagedMemoryError,
            r"Brain candidate batch 1/1 failed \(records=2, evidence_chars=23\)",
        ):
            self.service.rebuild_brain_pages(trigger="test")

        latest = self.service.brain_store.latest_run()
        self.assertEqual(latest["status"], "failed")
        self.assertIn("Brain candidate batch 1/1 failed", latest["warning"])

    def test_brain_rebuild_does_not_count_one_conversation_twice(self):
        first = make_item(
            "00000000-0000-0000-0000-000000000081",
            "同一会话提取出的决定一。",
            "alpha",
        )
        second = make_item(
            "00000000-0000-0000-0000-000000000082",
            "同一会话提取出的决定二。",
            "beta",
        )
        for index, item in enumerate((first, second), 1):
            item.metadata.tags = ["session-extracted", "source-verified"]
            item.metadata.info.update(
                {
                    "origin_kind": "human_user_message",
                    "root_evidence_ids": [f"turn-{index}"],
                    "evidence_group_ids": ["conversation:codex:same-session"],
                    "evidence_verified": True,
                }
            )
        self.memories["alpha"].vector_db.points = [FakePoint(first, 0.8)]
        self.memories["beta"].vector_db.points = [FakePoint(second, 0.8)]

        def candidates(_service, records):
            return [
                {
                    "page_key": "same-session",
                    "existing_page_id": None,
                    "page_type": "concept",
                    "title": "同一会话",
                    "summary": "两条记忆实际来自同一会话，不能当成独立佐证。",
                    "sections": [],
                    "source_ids": [record["source_id"] for record in records],
                    "confidence": 0.95,
                    "importance": 0.90,
                }
            ]

        self.service._request_brain_candidates = types.MethodType(candidates, self.service)
        result = self.service.rebuild_brain_pages(trigger="test")

        self.assertTrue(result["rebuilt"])
        self.assertEqual(result["page_count"], 0)


if __name__ == "__main__":
    unittest.main()
