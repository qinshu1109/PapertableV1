from __future__ import annotations

import tempfile
import unittest

from pathlib import Path

from memos_managed_mcp.curated import CuratedKnowledgeError, scan_curated_notes


class CuratedKnowledgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.vault = Path(self.temporary.name) / "主知识库_AI"
        (self.vault / "10_活跃知识").mkdir(parents=True)
        (self.vault / "20_项目").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_note(
        self,
        relative: str,
        knowledge_id: str = "kn-0123456789ab",
        status: str = "active",
    ) -> Path:
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "---\n"
            f"knowledge_id: {knowledge_id}\n"
            f"knowledge_status: {status}\n"
            "retention_mode: synthesis\n"
            'source_records: ["kc-20260720-01234567"]\n'
            "supersedes: []\n"
            "---\n"
            "# 检索与压缩边界\n\n"
            "> [!summary] 我真正想保留的是\n"
            "> 正式笔记是事实来源，MemOS 只是检索卡。\n\n"
            "## 什么时候想起它\n"
            "- 调整长期记忆架构时\n\n"
            "## 来源原话或转写\n"
            "> 这里是只留在人类笔记中的完整证据。\n",
            encoding="utf-8",
        )
        return path

    def test_builds_short_card_without_copying_full_evidence(self) -> None:
        self.write_note("10_活跃知识/架构.md")
        notes = scan_curated_notes(self.vault)
        note = notes["kn-0123456789ab"]
        self.assertIn("正式笔记是事实来源", note.card)
        self.assertIn("vault://10_活跃知识/架构.md", note.card)
        self.assertNotIn("这里是只留在人类笔记中的完整证据", note.card)
        self.assertEqual(note.status, "active")

    def test_unmanaged_markdown_is_ignored(self) -> None:
        (self.vault / "10_活跃知识" / "旧笔记.md").write_text(
            "# 没有 knowledge_id\n", encoding="utf-8"
        )
        self.assertEqual(scan_curated_notes(self.vault), {})

    def test_duplicate_knowledge_id_stops_reconciliation(self) -> None:
        self.write_note("10_活跃知识/A.md")
        self.write_note("20_项目/B.md")
        with self.assertRaisesRegex(CuratedKnowledgeError, "Duplicate knowledge_id"):
            scan_curated_notes(self.vault)

    def test_retired_note_becomes_tombstone_card(self) -> None:
        self.write_note("20_项目/退役.md", status="retired")
        note = scan_curated_notes(self.vault)["kn-0123456789ab"]
        self.assertIn("已退役", note.card)
        self.assertNotIn("正式笔记是事实来源", note.card)


if __name__ == "__main__":
    unittest.main()

