from __future__ import annotations

import argparse
import json
import os

from pathlib import Path

from .settings import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline MemOS Local administration")
    parser.add_argument(
        "command",
        choices=[
            "cleanup-tests",
            "rebuild-brain",
            "rebuild-hot",
            "rebuild-fts",
            "reconcile-curated",
            "validate-derived",
        ],
    )
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()
    if args.command == "cleanup-tests" and args.confirm != "DELETE-ACCEPTANCE-DATA":
        raise SystemExit(
            "Refusing cleanup. Pass --confirm DELETE-ACCEPTANCE-DATA explicitly."
        )

    settings = Settings.from_env()
    settings.prepare_directories()
    pid_path = settings.runtime_path / "run" / "memos-managed.pid"
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text().strip())
            os.kill(pid, 0)
        except (ValueError, ProcessLookupError):
            pass
        else:
            raise SystemExit("Stop MemOS before cleaning embedded Qdrant test cubes.")

    from .service import ManagedMemoryService

    service = ManagedMemoryService(
        settings,
        probe_apis=False,
        start_brain_scheduler=False,
        initialize_derived=args.command != "validate-derived",
    )
    try:
        if args.command == "cleanup-tests":
            print(
                json.dumps(
                    {"cleanup": service.cleanup_test_artifacts()},
                    ensure_ascii=False,
                )
            )
        elif args.command == "rebuild-brain":
            result = service.rebuild_brain_pages(trigger="manual_cli")
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "rebuild-hot":
            result = service.rebuild_hot_memory(trigger="manual_cli", use_remote=True)
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "rebuild-fts":
            result = service._reconcile_search_index(rebuild=True)
            print(json.dumps(result, ensure_ascii=False))
        elif args.command == "reconcile-curated":
            result = service.reconcile_curated_knowledge(trigger="manual_cli")
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(json.dumps(service.validate_derived(), ensure_ascii=False))
    finally:
        service.close()


if __name__ == "__main__":
    main()
