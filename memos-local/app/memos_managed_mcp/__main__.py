from __future__ import annotations

import argparse
import asyncio
import json

from .settings import Settings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Managed local MemOS MCP service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8002, type=int)
    parser.add_argument(
        "--skip-probe",
        action="store_true",
        help="Skip upstream probes only after a manifest already exists",
    )
    parser.add_argument(
        "--probe-only",
        action="store_true",
        help="Probe the configured embedding and chat APIs without starting the server",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    settings = Settings.from_env(host=args.host, port=args.port)
    settings.prepare_directories()

    # Import only after MEMOS_BASE_PATH is fixed; MemOS reads it at import time.
    from .service import (
        ManagedMemoryService,
        probe_chat,
        probe_embedding,
        probe_reranker,
    )

    if args.probe_only:
        result = {"embedding_dimension": probe_embedding(settings)}
        try:
            result.update({"chat": "ok", "chat_response_model": probe_chat(settings)})
        except Exception as exc:
            result.update({"chat": "degraded", "chat_error_type": type(exc).__name__})
        try:
            result.update(
                {"reranker": "ok", "rerank_response_model": probe_reranker(settings)}
            )
        except Exception as exc:
            result.update(
                {"reranker": "degraded", "rerank_error_type": type(exc).__name__}
            )
        print(json.dumps(result, ensure_ascii=False))
        return

    from .server import ManagedMCPServer

    service = ManagedMemoryService(settings, probe_apis=not args.skip_probe)
    server = ManagedMCPServer(service)
    try:
        asyncio.run(server.run())
    finally:
        service.close()


if __name__ == "__main__":
    main()
