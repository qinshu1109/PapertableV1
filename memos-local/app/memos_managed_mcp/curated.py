from __future__ import annotations

import hashlib
import json
import re

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


KNOWLEDGE_ID_RE = re.compile(r"^kn-[0-9a-f]{12}$")
MANAGED_ROOTS = ("10_活跃知识", "20_项目")
KNOWLEDGE_STATUSES = {"active", "retired", "superseded"}
RETENTION_MODES = {"evidence", "synthesis", "mixed"}


class CuratedKnowledgeError(RuntimeError):
    """Raised when the human vault cannot be reconciled safely."""


@dataclass(frozen=True)
class CuratedNote:
    knowledge_id: str
    status: str
    retention_mode: str
    source_records: list[str]
    supersedes: list[str]
    relative_path: str
    title: str
    normalized_sha256: str
    card: str
    full_text: str
    modified_at: str


def normalize_markdown(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines).strip() + "\n"


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---\n"):
        return {}, normalized
    end = normalized.find("\n---\n", 4)
    if end < 0:
        raise CuratedKnowledgeError("Markdown frontmatter is not terminated")
    values: dict[str, Any] = {}
    for raw_line in normalized[4:end].splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        key, separator, raw_value = raw_line.partition(":")
        if not separator or not key.strip():
            raise CuratedKnowledgeError("Managed frontmatter contains an unsupported line")
        raw_value = raw_value.strip()
        try:
            values[key.strip()] = json.loads(raw_value)
        except json.JSONDecodeError:
            values[key.strip()] = raw_value
    return values, normalized[end + 5 :]


def _section_lines(body: str, heading: str) -> list[str]:
    lines = body.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == heading:
            start = index + 1
            break
    if start is None:
        return []
    result = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        stripped = line.strip()
        if stripped:
            result.append(stripped.lstrip("- "))
    return result


def _title(body: str, fallback: str) -> str:
    for line in body.splitlines():
        if line.startswith("# "):
            value = line[2:].strip()
            if value:
                return value[:160]
    return fallback


def _summary(body: str, title: str) -> str:
    lines = body.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "> [!summary] 我真正想保留的是":
            values = []
            for candidate in lines[index + 1 :]:
                if not candidate.startswith(">"):
                    break
                value = candidate.lstrip("> ").strip()
                if value:
                    values.append(value)
            if values:
                return " ".join(values)[:800]
    return f"经人工确认发布的知识：{title}。完整证据与原始措辞请读取正式笔记。"


def build_card(
    *,
    knowledge_id: str,
    title: str,
    status: str,
    retention_mode: str,
    relative_path: str,
    body: str,
    supersedes: list[str],
) -> str:
    pointer = f"vault://{relative_path}"
    if status != "active":
        return (
            f"精选知识已{ '被替代' if status == 'superseded' else '退役' }：{title}\n"
            f"knowledge_id：{knowledge_id}\n状态：{status}\n原文定位：{pointer}"
        )
    applicable = _section_lines(body, "## 什么时候想起它")
    boundaries = _section_lines(body, "## 适用边界")
    parts = [
        f"精选知识：{title}",
        f"摘要：{_summary(body, title)}",
    ]
    if applicable:
        parts.append("适用：" + "；".join(applicable[:8]))
    if boundaries:
        parts.append("边界：" + "；".join(boundaries[:6]))
    parts.extend(
        [
            f"保留方式：{retention_mode}",
            f"knowledge_id：{knowledge_id}",
            f"原文定位：{pointer}",
        ]
    )
    if supersedes:
        parts.append("明确替代：" + "、".join(supersedes))
    return "\n".join(parts)


def scan_curated_notes(vault: Path) -> dict[str, CuratedNote]:
    vault = vault.expanduser().resolve()
    if not vault.is_dir():
        raise CuratedKnowledgeError(f"Knowledge vault is unavailable: {vault}")
    notes: dict[str, CuratedNote] = {}
    for root_name in MANAGED_ROOTS:
        root = (vault / root_name).resolve()
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*.md")):
            if any(part.startswith(".") for part in path.relative_to(vault).parts):
                continue
            full_text = path.read_text(encoding="utf-8")
            frontmatter, body = parse_frontmatter(full_text)
            knowledge_id = frontmatter.get("knowledge_id")
            if knowledge_id is None:
                continue
            relative_path = path.relative_to(vault).as_posix()
            if not isinstance(knowledge_id, str) or not KNOWLEDGE_ID_RE.fullmatch(
                knowledge_id
            ):
                raise CuratedKnowledgeError(
                    f"Invalid knowledge_id in {relative_path}: {knowledge_id}"
                )
            if knowledge_id in notes:
                raise CuratedKnowledgeError(
                    f"Duplicate knowledge_id {knowledge_id}: "
                    f"{notes[knowledge_id].relative_path}, {relative_path}"
                )
            status = str(frontmatter.get("knowledge_status") or "").strip()
            retention_mode = str(frontmatter.get("retention_mode") or "").strip()
            if status not in KNOWLEDGE_STATUSES:
                raise CuratedKnowledgeError(
                    f"Invalid knowledge_status in {relative_path}: {status}"
                )
            if retention_mode not in RETENTION_MODES:
                raise CuratedKnowledgeError(
                    f"Invalid retention_mode in {relative_path}: {retention_mode}"
                )
            source_records = frontmatter.get("source_records")
            supersedes = frontmatter.get("supersedes")
            if not isinstance(source_records, list) or not all(
                isinstance(value, str) and value for value in source_records
            ):
                raise CuratedKnowledgeError(
                    f"source_records must be a non-empty string list in {relative_path}"
                )
            if not source_records:
                raise CuratedKnowledgeError(f"source_records is empty in {relative_path}")
            if not isinstance(supersedes, list) or not all(
                isinstance(value, str) and KNOWLEDGE_ID_RE.fullmatch(value)
                for value in supersedes
            ):
                raise CuratedKnowledgeError(
                    f"supersedes must contain knowledge IDs in {relative_path}"
                )
            normalized = normalize_markdown(full_text)
            title = _title(body, path.stem)
            modified_at = datetime.fromtimestamp(
                path.stat().st_mtime, timezone.utc
            ).isoformat()
            notes[knowledge_id] = CuratedNote(
                knowledge_id=knowledge_id,
                status=status,
                retention_mode=retention_mode,
                source_records=list(dict.fromkeys(source_records)),
                supersedes=list(dict.fromkeys(supersedes)),
                relative_path=relative_path,
                title=title,
                normalized_sha256=hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
                card=build_card(
                    knowledge_id=knowledge_id,
                    title=title,
                    status=status,
                    retention_mode=retention_mode,
                    relative_path=relative_path,
                    body=body,
                    supersedes=supersedes,
                ),
                full_text=full_text,
                modified_at=modified_at,
            )
    return notes

