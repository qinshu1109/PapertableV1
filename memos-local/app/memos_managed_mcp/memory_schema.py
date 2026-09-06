from __future__ import annotations

import json
import re

from datetime import datetime, timezone
from typing import Any, Mapping


MEMORY_SCHEMA_VERSION = 3
SEMANTIC_TYPES = {
    "fact",
    "preference",
    "profile",
    "event",
    "decision",
    "constraint",
    "goal",
    "todo",
    "knowledge",
    "procedure",
    "opinion",
    "skill",
    "tool",
    "other",
}
SUBJECT_TYPES = {"user", "agent", "person", "organization", "group", "system", "other"}
SUBJECT_TYPE_ALIASES = {
    # Compatibility with memory plugins that describe the object rather than
    # the entity the memory is about.
    "human": "person",
    "ai": "agent",
    "assistant": "agent",
    "memory": "user",
    "task": "user",
    "project": "organization",
}
MEMORY_STATUSES = {"activated", "resolving", "archived", "deleted"}
VISIBILITIES = {"private", "public", "session"}
MANAGED_KINDS = {"raw", "compacted", "curated_card", "cube_index", "derived"}
ORIGIN_KINDS = {
    "unknown",
    "human_user_message",
    "behavioral_observation",
    "agent_observation",
    "system_context",
    "tool_output",
    "curated_note",
    "derived",
}

_EVENT_QUERY_RE = re.compile(
    r"(?:什么时候|何时|哪天|最近|发生|时间线|时间|经历|timeline|when|recent|event)", re.I
)
_PROFILE_QUERY_RE = re.compile(
    r"(?:我是谁|我的(?:偏好|习惯|风格|画像|信息)|画像|属性|偏好|习惯|profile|preference)", re.I
)
_PROCEDURE_QUERY_RE = re.compile(r"(?:如何|怎么|步骤|方法|流程|how\s+to|procedure)", re.I)


class MemorySchemaError(ValueError):
    """Raised when typed-memory metadata is invalid."""


def normalize_timestamp(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MemorySchemaError(f"{field_name} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _normalize_string(
    value: str | None,
    field_name: str,
    *,
    required: bool = False,
    max_length: int = 500,
) -> str | None:
    if value is None:
        if required:
            raise MemorySchemaError(f"{field_name} is required")
        return None
    normalized = str(value).strip()
    if not normalized:
        if required:
            raise MemorySchemaError(f"{field_name} is required")
        return None
    if len(normalized) > max_length:
        raise MemorySchemaError(f"{field_name} exceeds {max_length} characters")
    return normalized


def _normalize_enum(value: str, field_name: str, allowed: set[str]) -> str:
    normalized = str(value).strip().casefold()
    if normalized not in allowed:
        choices = ", ".join(sorted(allowed))
        raise MemorySchemaError(f"{field_name} must be one of: {choices}")
    return normalized


def normalize_string_list(
    values: list[str] | None,
    field_name: str,
    *,
    max_items: int = 100,
    max_length: int = 300,
) -> list[str]:
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > max_items:
        raise MemorySchemaError(f"{field_name} must be a list with at most {max_items} items")
    normalized: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _normalize_string(value, field_name, required=True, max_length=max_length)
        assert item is not None
        if item not in seen:
            normalized.append(item)
            seen.add(item)
    return normalized


def normalize_attributes(attributes: dict[str, Any] | None) -> dict[str, Any]:
    if attributes is None:
        return {}
    if not isinstance(attributes, dict) or len(attributes) > 100:
        raise MemorySchemaError("attributes must be an object with at most 100 fields")
    normalized: dict[str, Any] = {}
    for key, value in attributes.items():
        normalized_key = _normalize_string(str(key), "attribute key", required=True, max_length=80)
        assert normalized_key is not None
        normalized[normalized_key] = value
    try:
        encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise MemorySchemaError("attributes must contain only JSON-compatible values") from exc
    if len(encoded.encode("utf-8")) > 32768:
        raise MemorySchemaError("attributes exceeds the 32 KiB limit")
    return normalized


def normalize_memory_fields(
    *,
    default_user_id: str,
    semantic_type: str = "fact",
    subject_type: str = "user",
    subject_id: str | None = None,
    asserted_by: str | None = None,
    client_id: str | None = None,
    conversation_id: str | None = None,
    attributes: dict[str, Any] | None = None,
    occurred_at: str | None = None,
    ended_at: str | None = None,
    location: str | None = None,
    participants: list[str] | None = None,
    confidence: float | None = None,
    visibility: str = "private",
    status: str = "activated",
    evidence_memory_ids: list[str] | None = None,
    origin_kind: str = "unknown",
    root_evidence_ids: list[str] | None = None,
    evidence_group_ids: list[str] | None = None,
    evidence_verified: bool = False,
    locked_fields: list[str] | None = None,
) -> dict[str, Any]:
    semantic_type = _normalize_enum(semantic_type, "semantic_type", SEMANTIC_TYPES)
    subject_type = str(subject_type or "user").strip().casefold()
    subject_type = SUBJECT_TYPE_ALIASES.get(subject_type, subject_type)
    subject_type = _normalize_enum(subject_type, "subject_type", SUBJECT_TYPES)
    status = _normalize_enum(status, "status", MEMORY_STATUSES)
    visibility = _normalize_enum(visibility, "visibility", VISIBILITIES)
    origin_kind = _normalize_enum(origin_kind, "origin_kind", ORIGIN_KINDS)
    if not isinstance(evidence_verified, bool):
        raise MemorySchemaError("evidence_verified must be a boolean")
    normalized_subject_id = _normalize_string(
        subject_id or (default_user_id if subject_type == "user" else None),
        "subject_id",
        required=True,
        max_length=300,
    )
    normalized_occurred_at = normalize_timestamp(occurred_at, "occurred_at")
    normalized_ended_at = normalize_timestamp(ended_at, "ended_at")
    if semantic_type == "event" and not normalized_occurred_at:
        raise MemorySchemaError("occurred_at is required when semantic_type is event")
    if normalized_occurred_at and normalized_ended_at:
        if datetime.fromisoformat(normalized_ended_at) < datetime.fromisoformat(normalized_occurred_at):
            raise MemorySchemaError("ended_at must not be earlier than occurred_at")
    if confidence is not None:
        try:
            confidence = float(confidence)
        except (TypeError, ValueError) as exc:
            raise MemorySchemaError("confidence must be a number between 0 and 1") from exc
        if not 0.0 <= confidence <= 1.0:
            raise MemorySchemaError("confidence must be between 0 and 1")
    normalized_attributes = normalize_attributes(attributes)
    normalized_locks = normalize_string_list(
        locked_fields, "locked_fields", max_items=100, max_length=80
    )
    unknown_locks = set(normalized_locks) - set(normalized_attributes)
    if unknown_locks:
        raise MemorySchemaError(
            "locked_fields must reference existing attributes: " + ", ".join(sorted(unknown_locks))
        )
    return {
        "schema_version": MEMORY_SCHEMA_VERSION,
        "semantic_type": semantic_type,
        "subject_type": subject_type,
        "subject_id": normalized_subject_id,
        "asserted_by": _normalize_string(asserted_by, "asserted_by", max_length=300),
        "client_id": _normalize_string(client_id, "client_id", max_length=200),
        "conversation_id": _normalize_string(
            conversation_id, "conversation_id", max_length=300
        ),
        "attributes": normalized_attributes,
        "occurred_at": normalized_occurred_at,
        "ended_at": normalized_ended_at,
        "location": _normalize_string(location, "location", max_length=500),
        "participants": normalize_string_list(
            participants, "participants", max_items=50, max_length=300
        ),
        "confidence": confidence,
        "visibility": visibility,
        "status": status,
        "evidence_memory_ids": normalize_string_list(
            evidence_memory_ids, "evidence_memory_ids", max_items=100, max_length=300
        ),
        "origin_kind": origin_kind,
        "root_evidence_ids": normalize_string_list(
            root_evidence_ids, "root_evidence_ids", max_items=1000, max_length=500
        ),
        "evidence_group_ids": normalize_string_list(
            evidence_group_ids, "evidence_group_ids", max_items=1000, max_length=500
        ),
        "evidence_verified": evidence_verified,
        "locked_fields": normalized_locks,
    }


def descriptor_from_metadata(metadata: Any, default_user_id: str | None = None) -> dict[str, Any]:
    if hasattr(metadata, "model_dump"):
        data = metadata.model_dump(exclude_none=True)
    elif isinstance(metadata, Mapping):
        data = dict(metadata)
    else:
        data = {}
    info = data.get("info") if isinstance(data.get("info"), dict) else {}
    semantic_type = str(info.get("semantic_type") or data.get("type") or "fact").casefold()
    if semantic_type == "stable_fact":
        semantic_type = "fact"
    if semantic_type not in SEMANTIC_TYPES:
        semantic_type = "other"
    subject_type = str(info.get("subject_type") or "user").casefold()
    if subject_type not in SUBJECT_TYPES:
        subject_type = "other"
    status = str(data.get("status") or info.get("status") or "activated").casefold()
    if status not in MEMORY_STATUSES:
        status = "activated"
    visibility = str(data.get("visibility") or info.get("visibility") or "private").casefold()
    if visibility not in VISIBILITIES:
        visibility = "private"
    attributes = info.get("attributes") if isinstance(info.get("attributes"), dict) else {}
    return {
        "schema_version": int(info.get("schema_version") or 1),
        "semantic_type": semantic_type,
        "managed_kind": str(info.get("managed_kind") or "raw").casefold(),
        "subject_type": subject_type,
        "subject_id": str(info.get("subject_id") or data.get("user_id") or default_user_id or ""),
        "asserted_by": info.get("asserted_by"),
        "client_id": info.get("client_id"),
        "conversation_id": info.get("conversation_id") or data.get("session_id"),
        "attributes": attributes,
        "occurred_at": info.get("occurred_at"),
        "ended_at": info.get("ended_at"),
        "location": info.get("location"),
        "participants": list(info.get("participants") or []),
        "confidence": data.get("confidence", info.get("confidence")),
        "visibility": visibility,
        "status": status,
        "valid_until": info.get("valid_until"),
        "evidence_memory_ids": list(info.get("evidence_memory_ids") or []),
        "origin_kind": str(info.get("origin_kind") or "unknown").casefold(),
        "root_evidence_ids": list(info.get("root_evidence_ids") or []),
        "evidence_group_ids": list(info.get("evidence_group_ids") or []),
        "evidence_verified": info.get("evidence_verified") is True,
        "locked_fields": list(info.get("locked_fields") or []),
    }


def normalize_search_filters(
    *,
    semantic_types: list[str] | None = None,
    managed_kinds: list[str] | None = None,
    subject_types: list[str] | None = None,
    subject_ids: list[str] | None = None,
    statuses: list[str] | None = None,
    occurred_from: str | None = None,
    occurred_to: str | None = None,
    include_expired: bool = False,
) -> dict[str, Any]:
    def enum_list(values: list[str] | None, field_name: str, allowed: set[str]) -> list[str]:
        normalized = normalize_string_list(values, field_name, max_items=50, max_length=80)
        return [_normalize_enum(value, field_name, allowed) for value in normalized]

    normalized_from = normalize_timestamp(occurred_from, "occurred_from")
    normalized_to = normalize_timestamp(occurred_to, "occurred_to")
    if normalized_from and normalized_to:
        if datetime.fromisoformat(normalized_to) < datetime.fromisoformat(normalized_from):
            raise MemorySchemaError("occurred_to must not be earlier than occurred_from")
    return {
        "semantic_types": enum_list(semantic_types, "semantic_types", SEMANTIC_TYPES),
        "managed_kinds": enum_list(managed_kinds, "managed_kinds", MANAGED_KINDS),
        "subject_types": enum_list(subject_types, "subject_types", SUBJECT_TYPES),
        "subject_ids": normalize_string_list(
            subject_ids, "subject_ids", max_items=50, max_length=300
        ),
        "statuses": enum_list(statuses, "statuses", MEMORY_STATUSES)
        or ["activated", "resolving"],
        "occurred_from": normalized_from,
        "occurred_to": normalized_to,
        "include_expired": bool(include_expired),
        "current_time": datetime.now(timezone.utc).isoformat(),
    }


def matches_search_filters(descriptor: Mapping[str, Any], filters: Mapping[str, Any]) -> bool:
    for key, descriptor_key in (
        ("semantic_types", "semantic_type"),
        ("managed_kinds", "managed_kind"),
        ("subject_types", "subject_type"),
        ("subject_ids", "subject_id"),
        ("statuses", "status"),
    ):
        accepted = filters.get(key) or []
        if accepted and descriptor.get(descriptor_key) not in accepted:
            return False
    occurred_at = descriptor.get("occurred_at")
    if filters.get("occurred_from") and (
        not occurred_at or str(occurred_at) < str(filters["occurred_from"])
    ):
        return False
    if filters.get("occurred_to") and (
        not occurred_at or str(occurred_at) > str(filters["occurred_to"])
    ):
        return False
    valid_until = descriptor.get("valid_until")
    if not filters.get("include_expired") and valid_until:
        try:
            if normalize_timestamp(str(valid_until), "valid_until") <= filters["current_time"]:
                return False
        except MemorySchemaError:
            return False
    return True


def infer_type_boosts(query: str) -> tuple[str, dict[str, float]]:
    if _EVENT_QUERY_RE.search(query):
        return "event", {"event": 0.006, "decision": 0.002}
    if _PROFILE_QUERY_RE.search(query):
        return "profile", {"profile": 0.006, "preference": 0.004, "fact": 0.001}
    if _PROCEDURE_QUERY_RE.search(query):
        return "procedure", {"procedure": 0.006, "knowledge": 0.004, "decision": 0.002}
    return "general", {}
