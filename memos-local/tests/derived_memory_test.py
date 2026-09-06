from __future__ import annotations

import json
import tempfile
import threading
import types
import unittest

import httpx

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch
from openai import APIConnectionError

from memos_managed_mcp.brain import BrainStore
from memos_managed_mcp.hot import HotMemoryError, HotMemoryStore
from memos_managed_mcp.search_index import SearchIndex
from memos_managed_mcp.service import (
    ManagedMemoryError,
    ManagedMemoryService,
    openai_chat_completion,
)


class ChatCompletionTests(unittest.TestCase):
    @staticmethod
    def _response(
        content: str | None,
        *,
        reasoning_content: str = "",
        completion_tokens: int = 0,
        reasoning_tokens: int | None = None,
    ):
        message = types.SimpleNamespace(
            content=content,
            model_extra={"reasoning_content": reasoning_content},
        )
        choice = types.SimpleNamespace(
            message=message,
            finish_reason="stop",
        )
        details = types.SimpleNamespace(reasoning_tokens=reasoning_tokens)
        usage = types.SimpleNamespace(
            completion_tokens=completion_tokens,
            completion_tokens_details=details,
        )
        return types.SimpleNamespace(
            model="deepseek-v4-flash",
            choices=[choice],
            usage=usage,
        )

    def test_non_streaming_json_request_disables_hidden_retries(self):
        create = MagicMock(
            return_value=types.SimpleNamespace(
                model="deepseek-v4-flash",
                choices=[
                    types.SimpleNamespace(
                        message=types.SimpleNamespace(content='{"ok":true}')
                    )
                ],
            )
        )
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)
            )
        )
        settings = types.SimpleNamespace(
            chat_api_key="secret",
            chat_base_url="https://opencode.ai/zen/go/v1",
            chat_model="deepseek-v4-flash",
            request_timeout=90,
        )
        with patch("memos_managed_mcp.service.OpenAI", return_value=client) as factory:
            text, model = openai_chat_completion(
                settings,
                "Return JSON",
                max_tokens=64,
                json_object=True,
                timeout_seconds=300,
                reasoning_effort="low",
            )

        self.assertEqual((text, model), ('{"ok":true}', "deepseek-v4-flash"))
        self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
        self.assertFalse(create.call_args.kwargs["stream"])
        self.assertEqual(create.call_args.kwargs["reasoning_effort"], "low")
        self.assertEqual(create.call_args.kwargs["timeout"], 300)
        self.assertEqual(
            create.call_args.kwargs["response_format"], {"type": "json_object"}
        )

    def test_structured_calls_default_to_non_reasoning_mode(self):
        create = MagicMock(
            return_value=types.SimpleNamespace(
                model="deepseek-v4-flash",
                choices=[types.SimpleNamespace(message=types.SimpleNamespace(content="OK"))],
            )
        )
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(completions=types.SimpleNamespace(create=create))
        )
        settings = types.SimpleNamespace(
            chat_api_key="secret",
            chat_base_url="https://opencode.ai/zen/go/v1",
            chat_model="deepseek-v4-flash",
            request_timeout=90,
        )

        with patch("memos_managed_mcp.service.OpenAI", return_value=client):
            openai_chat_completion(settings, "Reply OK", max_tokens=256)

        self.assertEqual(create.call_args.kwargs["reasoning_effort"], "none")

    def test_chat_rejects_output_above_model_limit(self):
        settings = types.SimpleNamespace()
        with self.assertRaisesRegex(ManagedMemoryError, "384000"):
            openai_chat_completion(settings, "too much", max_tokens=384_001)

    def test_connection_errors_retry_twice(self):
        response = types.SimpleNamespace(
            model="deepseek-v4-flash",
            choices=[
                types.SimpleNamespace(message=types.SimpleNamespace(content="OK"))
            ],
        )
        error = APIConnectionError(request=httpx.Request("POST", "https://example.test"))
        create = MagicMock(side_effect=[error, error, response])
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)
            )
        )
        settings = types.SimpleNamespace(
            chat_api_key="secret",
            chat_base_url="https://opencode.ai/zen/go/v1",
            chat_model="deepseek-v4-flash",
            request_timeout=90,
        )

        with (
            patch("memos_managed_mcp.service.OpenAI", return_value=client),
            patch("memos_managed_mcp.service.time.sleep") as sleep,
        ):
            self.assertEqual(
                openai_chat_completion(settings, "Reply OK", max_tokens=16),
                ("OK", "deepseek-v4-flash"),
            )

        self.assertEqual(create.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_empty_final_text_retries_when_explicitly_enabled(self):
        create = MagicMock(
            side_effect=[
                self._response(
                    "<think>only private reasoning</think>",
                    reasoning_content="only private reasoning",
                    completion_tokens=128,
                    reasoning_tokens=128,
                ),
                self._response('{"pages":[]}', completion_tokens=8),
            ]
        )
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)
            )
        )
        settings = types.SimpleNamespace(
            chat_api_key="secret",
            chat_base_url="https://opencode.ai/zen/go/v1",
            chat_model="deepseek-v4-flash",
            request_timeout=90,
        )

        with (
            patch("memos_managed_mcp.service.OpenAI", return_value=client),
            patch("memos_managed_mcp.service.time.sleep") as sleep,
        ):
            result = openai_chat_completion(
                settings,
                "Return pages",
                max_tokens=256,
                retry_empty_text=True,
            )

        self.assertEqual(result, ('{"pages":[]}', "deepseek-v4-flash"))
        self.assertEqual(create.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_empty_final_text_stops_after_bounded_retries_with_diagnostics(self):
        empty = self._response(
            "",
            reasoning_content="private reasoning",
            completion_tokens=5264,
            reasoning_tokens=None,
        )
        create = MagicMock(side_effect=[empty, empty, empty])
        client = types.SimpleNamespace(
            chat=types.SimpleNamespace(
                completions=types.SimpleNamespace(create=create)
            )
        )
        settings = types.SimpleNamespace(
            chat_api_key="secret",
            chat_base_url="https://opencode.ai/zen/go/v1",
            chat_model="deepseek-v4-flash",
            request_timeout=90,
        )

        with (
            patch("memos_managed_mcp.service.OpenAI", return_value=client),
            patch("memos_managed_mcp.service.time.sleep") as sleep,
        ):
            with self.assertRaisesRegex(
                ManagedMemoryError,
                r"raw_content_chars=0, reasoning_content_chars=17, completion_tokens=5264",
            ):
                openai_chat_completion(
                    settings,
                    "Return pages",
                    max_tokens=256,
                    retry_empty_text=True,
                )

        self.assertEqual(create.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])


class SearchIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.index = SearchIndex(Path(self.temp.name) / "search.sqlite3")
        self.records = [
            {
                "cube_id": "alpha",
                "memory_id": "one",
                "memory": "MemOS 本地记忆使用 Qwen3-Embedding-4B 版本 v2.0.24",
                "updated_at": "2026-07-20T00:00:00+00:00",
            },
            {
                "cube_id": "beta",
                "memory_id": "two",
                "memory": "Mac mini M4 负责本地存储，容量进度是 100%_safe",
                "updated_at": "2026-07-20T00:00:01+00:00",
            },
        ]
        self.index.rebuild(self.records)

    def tearDown(self):
        self.temp.cleanup()

    def test_trigram_handles_chinese_english_and_versions(self):
        self.assertEqual(self.index.search("本地记忆", ["alpha"], 5)[0]["memory_id"], "one")
        self.assertEqual(self.index.search("Qwen3-Embedding", ["alpha"], 5)[0]["memory_id"], "one")
        self.assertEqual(self.index.search("v2.0.24", ["alpha"], 5)[0]["memory_id"], "one")

    def test_short_and_special_queries_are_safe(self):
        self.assertEqual(self.index.search("M4", ["beta"], 5)[0]["memory_id"], "two")
        self.assertEqual(self.index.search("100%_safe", ["beta"], 5)[0]["memory_id"], "two")
        self.assertEqual(self.index.search('" OR *', ["beta"], 5), [])

    def test_reconcile_updates_and_deletes_by_hash(self):
        changed = [{**self.records[0], "memory": "MemOS updated"}]
        result = self.index.reconcile(changed)
        self.assertEqual(result["documents"], 1)
        self.assertEqual(result["added_or_updated"], 1)
        self.assertEqual(result["deleted"], 1)


class HotMemoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.store = HotMemoryStore(root / "hot.sqlite3", root / "hot_context.md")
        self.cubes = [
                {
                    "cube_id": "alpha",
                    "name": "Alpha",
                    "description": "Alpha 项目决策和进度",
                    "updated_at": "2026-07-20T00:00:00+00:00",
                },
                {
                    "cube_id": "beta",
                    "name": "Beta",
                    "description": "Beta API 版本和错误码",
                    "updated_at": "2026-07-19T00:00:00+00:00",
                },
            ]
        self.store.refresh_cube_map(self.cubes)

    def tearDown(self):
        self.temp.cleanup()

    def test_versioned_snapshot_and_unchanged_response(self):
        snapshot = self.store.write_snapshot("# 热记忆\n", 2000, 2500, "local", {})
        self.assertEqual(snapshot["version"], 1)
        self.assertIn("热记忆", self.store.get_context()["context"])
        self.assertTrue(self.store.get_context(1)["unchanged"])

    def test_route_uses_strong_cues_and_at_most_two_cubes(self):
        self.store.write_snapshot("# 热记忆\n", 2000, 2500, "local", {})
        route = self.store.route("继续上次 Alpha 项目的决定")
        self.assertTrue(route["need_memory"])
        self.assertEqual(route["cube_ids"][0], "alpha")
        self.assertLessEqual(len(route["cube_ids"]), 2)
        quiet = self.store.route("把 2+2 算出来")
        self.assertFalse(quiet["need_memory"])

    def test_session_events_are_idempotent_and_due_every_ten_turns(self):
        last = None
        for turn in range(10):
            payload = {
                "client": "codex",
                "session_id": "session-a",
                "event_type": "Stop",
                "transcript_offset": turn + 1,
                "fingerprint": f"turn-{turn}",
            }
            last = self.store.record_session_event(payload)
        self.assertTrue(last["extraction_due"])
        duplicate = self.store.record_session_event(payload)
        self.assertEqual(duplicate["turn_count"], 10)

    def test_candidate_content_hash_prevents_duplicate_writes(self):
        candidate = {
            "client": "claude",
            "session_id": "s",
            "kind": "decision",
            "content": "使用混合召回",
            "confidence": 0.95,
            "write_value": 0.9,
            "cube_id": "alpha",
            "route_confidence": 0.9,
            "reason": "stable",
        }
        self.assertTrue(self.store.add_candidate(candidate)["created"])
        self.assertFalse(self.store.add_candidate(candidate)["created"])
        independent = {
            **candidate,
            "evidence_group_ids": ["conversation:claude:another-session"],
        }
        self.assertTrue(self.store.add_candidate(independent)["created"])

    def test_unchanged_cube_map_does_not_dirty_snapshot(self):
        self.store.write_snapshot("# 热记忆\n", 2000, 2500, "local", {})
        self.assertEqual(self.store.get_meta("dirty"), "0")
        self.store.refresh_cube_map(self.cubes)
        self.assertEqual(self.store.get_meta("dirty"), "0")

    def test_new_excluded_policy_does_not_dirty_snapshot(self):
        self.store.write_snapshot("# 热记忆\n", 2000, 2500, "local", {})
        self.store.set_policy("alpha", "ignored", "exclude", None, None)
        self.assertEqual(self.store.get_meta("dirty"), "0")
        self.store.set_policy("alpha", "ignored", "auto", None, None)
        self.assertEqual(self.store.get_meta("dirty"), "1")

    def test_excluded_memories_do_not_affect_hot_memory(self):
        service = ManagedMemoryService.__new__(ManagedMemoryService)
        service.hot_store = self.store
        self.store.set_policy("alpha", "ignored", "exclude", None, None)

        self.assertFalse(service._memory_affects_hot("alpha", "ignored"))
        self.assertFalse(
            service._memory_affects_hot("alpha", "included", ["brain:ignore"])
        )
        self.assertTrue(service._memory_affects_hot("alpha", "included"))

    def test_failed_compile_is_settled_unless_new_changes_arrive(self):
        self.store.mark_dirty("first")
        dirty_at = self.store.get_meta("dirty_at")
        self.store.record_compile_start("scheduled", "test", 1)
        self.assertIsNotNone(self.store.get_meta("last_compile_attempt_at"))
        self.assertTrue(self.store.settle_dirty_after_compile(dirty_at))
        self.assertEqual(self.store.get_meta("dirty"), "0")

        self.store.mark_dirty("second")
        dirty_at = self.store.get_meta("dirty_at")
        self.store.set_meta("dirty_at", "newer-change")
        self.assertFalse(self.store.settle_dirty_after_compile(dirty_at))
        self.assertEqual(self.store.get_meta("dirty"), "1")

    def test_compiled_snapshot_failure_preserves_previous_state(self):
        original = [{
            "item_id": "original",
            "kind": "fact",
            "content": "原有热事实",
            "heat": 0.9,
            "status": "active",
            "hot_policy": "auto",
            "sources": [{"cube_id": "alpha", "memory_id": "one"}],
        }]
        self.store.write_compiled_snapshot(
            original, "# 原有快照\n", 2000, 2500, "local", {}
        )
        invalid = [{**original[0], "item_id": "invalid", "kind": "not-a-kind"}]
        with self.assertRaises(Exception):
            self.store.write_compiled_snapshot(
                invalid, "# 不应提交\n", 2000, 2500, "local", {}
            )
        self.assertEqual(self.store.latest_snapshot()["version"], 1)
        self.assertEqual(self.store.get_context()["context"], "# 原有快照\n")
        self.assertEqual(self.store.list_items()[0]["content"], "原有热事实")

    def test_session_candidate_requires_explicit_no_conflict_for_auto_write(self):
        service = ManagedMemoryService.__new__(ManagedMemoryService)
        service.settings = types.SimpleNamespace()
        service.hot_store = self.store
        service.cubes = {"index": object(), "alpha": object()}
        session = {
            "client": "codex",
            "session_id": "session",
            "consumed_offset": 0,
            "pending_offset": 100,
        }
        response = {
            "candidates": [{
                "kind": "decision",
                "content": "长期采用混合召回",
                "confidence": 0.95,
                "write_value": 0.90,
                "cube_id": "alpha",
                "route_confidence": 0.91,
                "reason": "稳定技术决定",
                "evidence": [{"id": "codex:user_message:turn-1", "quote": "长期采用混合召回"}],
            }]
        }
        transcript = json.dumps(
            {
                "type": "event_msg",
                "timestamp": "2026-08-09T00:00:00Z",
                "payload": {
                    "type": "user_message",
                    "client_id": "turn-1",
                    "message": "长期采用混合召回",
                },
            },
            ensure_ascii=False,
        )
        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            return_value=(__import__("json").dumps(response, ensure_ascii=False), "test"),
        ):
            candidate = service._extract_session_candidates(session, transcript)[0]
        self.assertEqual(candidate["conflict"], "possible")
        self.assertEqual(candidate["status"], "disputed")
        self.assertTrue(candidate["evidence_verified"])
        self.assertEqual(
            candidate["evidence_group_ids"], ["conversation:codex:session"]
        )

    def test_session_parsers_ignore_non_human_roles(self):
        codex = "\n".join(
            json.dumps(value, ensure_ascii=False)
            for value in [
                {
                    "type": "response_item",
                    "payload": {"type": "message", "role": "user", "content": "平台注入"},
                },
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "user_message",
                        "client_id": "human-1",
                        "message": "真实用户决定",
                    },
                },
                {
                    "type": "response_item",
                    "payload": {"type": "message", "role": "assistant", "content": "助手建议"},
                },
            ]
        )
        codex_evidence = ManagedMemoryService._session_user_evidence(
            {"client": "codex", "session_id": "c1"}, codex, 10000
        )
        self.assertEqual([value["text"] for value in codex_evidence], ["真实用户决定"])

        claude = "\n".join(
            json.dumps(value, ensure_ascii=False)
            for value in [
                {
                    "type": "user",
                    "isMeta": True,
                    "uuid": "meta",
                    "message": {"role": "user", "content": "系统元消息"},
                },
                {
                    "type": "user",
                    "uuid": "tool",
                    "message": {"role": "user", "content": [{"type": "tool_result"}]},
                },
                {
                    "type": "user",
                    "uuid": "human-2",
                    "message": {"role": "user", "content": "真实 Claude 用户消息"},
                },
            ]
        )
        claude_evidence = ManagedMemoryService._session_user_evidence(
            {"client": "claude", "session_id": "c2"}, claude, 10000
        )
        self.assertEqual([value["text"] for value in claude_evidence], ["真实 Claude 用户消息"])

    def test_candidate_rejects_invented_quote(self):
        service = ManagedMemoryService.__new__(ManagedMemoryService)
        service.settings = types.SimpleNamespace()
        service.hot_store = self.store
        service.cubes = {"index": object(), "alpha": object()}
        session = {
            "client": "codex",
            "session_id": "session",
            "consumed_offset": 0,
            "pending_offset": 100,
        }
        transcript = json.dumps(
            {
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "client_id": "turn-1",
                    "message": "用户只说了使用混合召回",
                },
            },
            ensure_ascii=False,
        )
        response = {
            "candidates": [
                {
                    "kind": "decision",
                    "content": "部署已经完成",
                    "confidence": 0.99,
                    "write_value": 0.99,
                    "cube_id": "alpha",
                    "route_confidence": 0.99,
                    "conflict": "none",
                    "reason": "test",
                    "evidence": [
                        {"id": "codex:user_message:turn-1", "quote": "部署已经完成"}
                    ],
                }
            ]
        }
        with patch(
            "memos_managed_mcp.service.openai_chat_completion",
            return_value=(json.dumps(response, ensure_ascii=False), "test"),
        ):
            self.assertEqual(service._extract_session_candidates(session, transcript), [])


class HotRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.service = ManagedMemoryService.__new__(ManagedMemoryService)
        self.service.settings = types.SimpleNamespace(
            hot_target_tokens=2000,
            hot_hard_limit_tokens=2500,
            chat_model="unused",
            user_id="qinshu",
        )
        self.service.hot_store = HotMemoryStore(
            root / "hot.sqlite3", root / "hot_context.md"
        )
        self.service._maintenance_lock = threading.Lock()
        self.service._audit = MagicMock()

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def item(
        item_id: str,
        kind: str,
        content: str,
        *,
        policy: str = "auto",
        brain_page_id: str | None = None,
    ) -> dict:
        return {
            "item_id": item_id,
            "kind": kind,
            "content": content,
            "heat": 1.0 if policy == "pin" else 0.9,
            "status": "active",
            "hot_policy": policy,
            "valid_until": None,
            "cube_id": None if brain_page_id else "alpha",
            "memory_id": None if brain_page_id else item_id,
            "brain_page_id": brain_page_id,
            "sources": [{"cube_id": "alpha", "memory_id": item_id}],
            "reason": "test",
            "supersedes_memory_id": None,
        }

    def test_render_reserves_brain_budget_across_page_types(self):
        direct = [
            self.item(f"direct-{index}", "fact", "直接事实" * 100)
            for index in range(20)
        ]
        brain = [
            self.item("concept", "fact", "概念页", brain_page_id="concept"),
            self.item("workstream", "goal", "工作流页", brain_page_id="workstream"),
            self.item("entity", "profile", "实体页", brain_page_id="entity"),
        ]

        context = self.service._render_hot_context(direct + brain, version=1)

        self.assertIn("来源 brain:concept", context)
        self.assertIn("来源 brain:workstream", context)
        self.assertIn("来源 brain:entity", context)
        self.assertLessEqual(len(context), 9000)

    def test_render_rejects_pins_over_direct_budget(self):
        pins = [
            self.item(f"pin-{index}", "fact", "置顶事实" * 200, policy="pin")
            for index in range(10)
        ]

        with self.assertRaisesRegex(HotMemoryError, "55% context budget"):
            self.service._render_hot_context(pins)

    def test_hot_rebuild_is_deterministic_even_when_remote_requested(self):
        candidate = self.item("fact", "fact", "确定性热事实")
        self.service._hot_candidates_from_sources = MagicMock(return_value=[candidate])

        result = self.service.rebuild_hot_memory(trigger="test", use_remote=True)

        self.assertEqual(result["status"], "success")
        self.assertEqual(self.service.hot_store.latest_snapshot()["model"], "deterministic-local")

    def test_single_source_brain_pin_reaches_hot_candidates(self):
        metadata_payload = {
            "tags": ["brain:pin"],
            "updated_at": "2026-08-09T00:00:00+00:00",
            "info": {"managed_kind": "raw"},
        }
        memory = types.SimpleNamespace(
            id="source",
            memory="单来源证据",
            metadata=types.SimpleNamespace(
                tags=["brain:pin"],
                info={"managed_kind": "raw"},
                model_dump=lambda **_kwargs: metadata_payload,
            ),
        )
        self.service._cube = lambda _cube_id: types.SimpleNamespace(
            text_mem=types.SimpleNamespace(get=lambda _memory_id: memory)
        )
        self.service.brain_store = MagicMock()
        self.service.brain_store.list_pages.return_value = {
            "items": [{
                "page_id": "page",
                "page_type": "concept",
                "summary": "单来源置顶页面",
                "confidence": 0.9,
                "importance": 0.9,
                "mention_count": 1,
            }]
        }
        self.service.brain_store.get_page.return_value = {
            "sources": [{"cube_id": "alpha", "memory_id": "source"}]
        }

        candidates = self.service._hot_candidates_from_sources()

        self.assertEqual(candidates[0]["brain_page_id"], "page")
        self.assertIn("brain:pin", candidates[0]["reason"])

    def test_critical_auto_memory_is_not_direct_hot(self):
        metadata_payload = {
            "tags": ["session-extracted"],
            "updated_at": "2026-08-09T00:00:00+00:00",
            "info": {"managed_kind": "raw", "evidence_verified": True},
        }
        memory = types.SimpleNamespace(
            id="auto",
            memory="模型自动提取内容",
            metadata=types.SimpleNamespace(
                tags=["session-extracted"],
                info={"managed_kind": "raw", "evidence_verified": True},
                model_dump=lambda **_kwargs: metadata_payload,
            ),
        )
        self.service._cube = lambda _cube_id: types.SimpleNamespace(
            text_mem=types.SimpleNamespace(get=lambda _memory_id: memory)
        )
        self.service.brain_store = MagicMock()
        self.service.brain_store.list_pages.return_value = {"items": []}
        self.service.hot_store.set_policy(
            "alpha", "auto", "auto", None, None, "critical"
        )

        self.assertEqual(self.service._hot_candidates_from_sources(), [])

    def test_new_pin_is_rejected_when_existing_pins_fill_budget(self):
        existing = self.item("existing", "fact", "已置顶" * 2000, policy="pin")
        self.service._hot_candidates_from_sources = MagicMock(return_value=[existing])

        with self.assertRaisesRegex(ManagedMemoryError, "55% context budget"):
            self.service._ensure_hot_pin_capacity("新置顶")

    def test_full_pin_budget_does_not_block_durable_memory_write(self):
        text_mem = MagicMock()
        self.service.cubes = {"alpha": types.SimpleNamespace(text_mem=text_mem)}
        self.service.manifest = {"cubes": {"alpha": {"max_memories": 100}}}
        self.service._cube_locks = {"alpha": threading.RLock()}
        self.service._count = MagicMock(side_effect=[0, 1])
        self.service._safe_fts_upsert = MagicMock()
        self.service._memory_affects_hot = MagicMock(return_value=False)
        self.service._ensure_hot_pin_capacity = MagicMock(
            side_effect=ManagedMemoryError("Pinned hot memories exceed their 55% context budget")
        )

        result = self.service.add_memory(
            "alpha", "必须保存的记忆", hot_policy="pin"
        )

        saved = text_mem.add.call_args.args[0][0]
        self.assertTrue(result["added"])
        self.assertEqual(result["hot_policy"], "auto")
        self.assertEqual(result["requested_hot_policy"], "pin")
        self.assertFalse(result["pin_applied"])
        self.assertIn("Memory was saved", result["warning"])
        self.assertEqual(saved.metadata.info["hot_policy"], "auto")


class BrainScheduleTests(unittest.TestCase):
    def test_recent_failed_run_is_not_retried_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            service = ManagedMemoryService.__new__(ManagedMemoryService)
            service.settings = types.SimpleNamespace(brain_interval_hours=24)
            service.brain_store = BrainStore(Path(directory) / "brain.sqlite3")
            now = datetime.now(timezone.utc).isoformat()
            service.brain_store.start_run(
                {"run_id": "failed", "trigger": "scheduled", "started_at": now}
            )
            service.brain_store.fail_run("failed", now, "TestError", "failed")

            self.assertFalse(service._brain_rebuild_due())


if __name__ == "__main__":
    unittest.main()
