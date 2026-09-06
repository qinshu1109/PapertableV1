from __future__ import annotations

import os
import stat

from dataclasses import dataclass
from pathlib import Path


class SettingsError(RuntimeError):
    """Raised when the managed service configuration is unsafe or incomplete."""


@dataclass(frozen=True)
class Settings:
    base_path: Path
    runtime_path: Path
    user_id: str
    embed_base_url: str
    embed_api_key: str
    embed_model: str
    chat_base_url: str
    chat_api_key: str
    chat_model: str
    rerank_base_url: str
    rerank_api_key: str
    rerank_model: str
    secrets_file: Path
    knowledge_vault_path: Path
    host: str = "127.0.0.1"
    port: int = 8002
    request_timeout: float = 90.0
    brain_enabled: bool = True
    brain_interval_hours: float = 24.0
    brain_initial_delay_seconds: float = 30.0
    hot_enabled: bool = True
    fts_enabled: bool = True
    client_ingest_enabled: bool = True
    hot_target_tokens: int = 2000
    hot_hard_limit_tokens: int = 2500
    hot_debounce_seconds: float = 300.0
    hot_interval_hours: float = 24.0
    hot_cleanup_interval_hours: float = 168.0
    foreground_recall_timeout_seconds: float = 3.0
    foreground_recall_top_k: int = 5

    @property
    def memos_dir(self) -> Path:
        return self.base_path / ".memos"

    @property
    def cubes_dir(self) -> Path:
        return self.memos_dir / "cubes"

    @property
    def manifest_path(self) -> Path:
        return self.memos_dir / "cubes.json"

    @property
    def compaction_journal_path(self) -> Path:
        return self.memos_dir / "compaction_jobs.jsonl"

    @property
    def audit_path(self) -> Path:
        return self.memos_dir / "audit.jsonl"

    @property
    def retrieval_trace_path(self) -> Path:
        return self.memos_dir / "retrieval_traces.jsonl"

    @property
    def compaction_archive_path(self) -> Path:
        return self.memos_dir / "compaction_archive.jsonl"

    @property
    def brain_db_path(self) -> Path:
        return self.memos_dir / "brain.sqlite3"

    @property
    def search_db_path(self) -> Path:
        return self.memos_dir / "search.sqlite3"

    @property
    def hot_db_path(self) -> Path:
        return self.memos_dir / "hot_memory.sqlite3"

    @property
    def hot_context_path(self) -> Path:
        return self.memos_dir / "hot_context.md"

    @property
    def log_path(self) -> Path:
        return self.runtime_path / "logs" / "managed-mcp.log"

    @classmethod
    def from_env(cls, host: str = "127.0.0.1", port: int = 8002) -> "Settings":
        default_runtime = Path.home() / "Library" / "Application Support" / "MemOSLocal"
        runtime_path = Path(os.getenv("MEMOS_RUNTIME_PATH", str(default_runtime))).expanduser()
        base_path = Path(
            os.getenv("MEMOS_BASE_PATH", str(runtime_path / "data"))
        ).expanduser()
        secrets_file = Path(
            os.getenv("MEMOS_SECRETS_FILE", str(runtime_path / "secrets.env"))
        ).expanduser()

        values = {
            "embed_base_url": os.getenv("MEMOS_EMBED_BASE_URL", ""),
            "embed_api_key": os.getenv("MEMOS_EMBED_API_KEY", ""),
            "embed_model": os.getenv("MEMOS_EMBED_MODEL", ""),
            "chat_base_url": os.getenv("MEMOS_CHAT_BASE_URL", ""),
            "chat_api_key": os.getenv("MEMOS_CHAT_API_KEY", ""),
            "chat_model": os.getenv("MEMOS_CHAT_MODEL", ""),
        }
        missing = [name for name, value in values.items() if not value.strip()]
        if missing:
            raise SettingsError("Missing required settings: " + ", ".join(missing))

        values.update(
            {
                "rerank_base_url": os.getenv(
                    "MEMOS_RERANK_BASE_URL", values["embed_base_url"]
                ),
                "rerank_api_key": os.getenv(
                    "MEMOS_RERANK_API_KEY", values["embed_api_key"]
                ),
                "rerank_model": os.getenv(
                    "MEMOS_RERANK_MODEL", "Qwen/Qwen3-Reranker-8B"
                ),
            }
        )

        for name in ("embed_base_url", "chat_base_url", "rerank_base_url"):
            url = values[name].rstrip("/")
            if not url.startswith("https://"):
                raise SettingsError(f"{name} must use HTTPS")
            values[name] = url

        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise SettingsError("The managed service may only listen on loopback")
        if not (1024 <= port <= 65535):
            raise SettingsError("Port must be between 1024 and 65535")

        settings = cls(
            base_path=base_path.resolve(),
            runtime_path=runtime_path.resolve(),
            user_id=os.getenv("MEMOS_USER_ID", "qinshu").strip(),
            secrets_file=secrets_file.resolve(),
            knowledge_vault_path=Path(
                os.getenv("MEMOS_KNOWLEDGE_VAULT", str(Path.home() / "主知识库_AI"))
            ).expanduser().resolve(),
            host=host,
            port=port,
            request_timeout=float(os.getenv("MEMOS_REQUEST_TIMEOUT", "90")),
            brain_enabled=os.getenv("MEMOS_BRAIN_ENABLED", "true").strip().casefold()
            not in {"0", "false", "no", "off"},
            brain_interval_hours=float(os.getenv("MEMOS_BRAIN_INTERVAL_HOURS", "24")),
            brain_initial_delay_seconds=float(
                os.getenv("MEMOS_BRAIN_INITIAL_DELAY_SECONDS", "30")
            ),
            hot_enabled=os.getenv("MEMOS_HOT_ENABLED", "true").strip().casefold()
            not in {"0", "false", "no", "off"},
            fts_enabled=os.getenv("MEMOS_FTS_ENABLED", "true").strip().casefold()
            not in {"0", "false", "no", "off"},
            client_ingest_enabled=os.getenv(
                "MEMOS_CLIENT_INGEST_ENABLED", "true"
            ).strip().casefold()
            not in {"0", "false", "no", "off"},
            hot_target_tokens=int(os.getenv("MEMOS_HOT_TARGET_TOKENS", "2000")),
            hot_hard_limit_tokens=int(
                os.getenv("MEMOS_HOT_HARD_LIMIT_TOKENS", "2500")
            ),
            hot_debounce_seconds=float(
                os.getenv("MEMOS_HOT_DEBOUNCE_SECONDS", "300")
            ),
            hot_interval_hours=float(os.getenv("MEMOS_HOT_INTERVAL_HOURS", "24")),
            hot_cleanup_interval_hours=float(
                os.getenv("MEMOS_HOT_CLEANUP_INTERVAL_HOURS", "168")
            ),
            foreground_recall_timeout_seconds=float(
                os.getenv("MEMOS_FOREGROUND_RECALL_TIMEOUT_SECONDS", "3")
            ),
            foreground_recall_top_k=int(
                os.getenv("MEMOS_FOREGROUND_RECALL_TOP_K", "5")
            ),
            **values,
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if not self.user_id or len(self.user_id) > 64:
            raise SettingsError("MEMOS_USER_ID must contain 1-64 characters")
        if not (1 <= self.brain_interval_hours <= 168):
            raise SettingsError("MEMOS_BRAIN_INTERVAL_HOURS must be between 1 and 168")
        if not (0 <= self.brain_initial_delay_seconds <= 3600):
            raise SettingsError(
                "MEMOS_BRAIN_INITIAL_DELAY_SECONDS must be between 0 and 3600"
            )
        if not (500 <= self.hot_target_tokens <= self.hot_hard_limit_tokens <= 2500):
            raise SettingsError(
                "Hot-memory token budgets must satisfy 500 <= target <= hard <= 2500"
            )
        if not (0 <= self.hot_debounce_seconds <= 3600):
            raise SettingsError("MEMOS_HOT_DEBOUNCE_SECONDS must be between 0 and 3600")
        if not (1 <= self.hot_interval_hours <= 168):
            raise SettingsError("MEMOS_HOT_INTERVAL_HOURS must be between 1 and 168")
        if not (24 <= self.hot_cleanup_interval_hours <= 720):
            raise SettingsError(
                "MEMOS_HOT_CLEANUP_INTERVAL_HOURS must be between 24 and 720"
            )
        if not (0.5 <= self.foreground_recall_timeout_seconds <= 30):
            raise SettingsError(
                "MEMOS_FOREGROUND_RECALL_TIMEOUT_SECONDS must be between 0.5 and 30"
            )
        if not (1 <= self.foreground_recall_top_k <= 20):
            raise SettingsError("MEMOS_FOREGROUND_RECALL_TOP_K must be between 1 and 20")
        if self.secrets_file.exists():
            mode = stat.S_IMODE(self.secrets_file.stat().st_mode)
            if mode & 0o077:
                raise SettingsError(
                    f"Secrets file permissions are {mode:o}; expected 600 or stricter"
                )

    def prepare_directories(self) -> None:
        for path in (
            self.runtime_path,
            self.runtime_path / "logs",
            self.runtime_path / "run",
            self.base_path,
            self.memos_dir,
            self.cubes_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o700)

        # MemOS reads this environment variable at import time.
        os.environ["MEMOS_BASE_PATH"] = str(self.base_path)
