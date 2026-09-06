from __future__ import annotations

import json
import os
import tempfile
import threading

from copy import deepcopy
from pathlib import Path
from typing import Any


class ManifestError(RuntimeError):
    """Raised when persistent cube metadata is invalid."""


class ManifestStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    def exists(self) -> bool:
        return self.path.exists()

    def load(self) -> dict[str, Any]:
        with self._lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except FileNotFoundError as exc:
                raise ManifestError(f"Manifest not found: {self.path}") from exc
            except json.JSONDecodeError as exc:
                raise ManifestError(f"Manifest is not valid JSON: {exc}") from exc
            self._validate(data)
            return deepcopy(data)

    def save(self, data: dict[str, Any]) -> None:
        self._validate(data)
        payload = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.", dir=str(self.path.parent)
            )
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, self.path)
                self.path.chmod(0o600)
            except Exception:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass
                raise

    @staticmethod
    def _validate(data: dict[str, Any]) -> None:
        if not isinstance(data, dict) or data.get("schema_version") != 1:
            raise ManifestError("Unsupported or missing manifest schema_version")
        if not isinstance(data.get("embedding"), dict):
            raise ManifestError("Manifest is missing embedding identity")
        if not isinstance(data.get("cubes"), dict):
            raise ManifestError("Manifest cubes must be an object")
        if "index" not in data["cubes"]:
            raise ManifestError("Manifest must contain the reserved index cube")
