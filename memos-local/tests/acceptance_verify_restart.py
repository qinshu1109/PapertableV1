from __future__ import annotations

import asyncio
import json

from fastmcp import Client


async def call(client: Client, name: str, arguments: dict):
    result = await client.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(f"{name} failed: {result.content}")
    return result.data


async def main() -> None:
    async with Client("http://127.0.0.1:8002/mcp") as client:
        stats = await call(client, "get_cube_stats", {})
        counts = {item["cube_id"]: item["count"] for item in stats["stats"]}
        # The acceptance cubes may contain later cross-client markers. The
        # persistence contract is that the original 50 entries are not lost.
        assert counts["test-alpha"] >= 50
        assert counts["test-beta"] >= 50
        alpha = await call(
            client,
            "search_memories",
            {"query": "ALPHA-MEM-050", "cube_ids": ["test-alpha"], "top_k": 5},
        )
        beta = await call(
            client,
            "search_memories",
            {"query": "BETA-MEM-050", "cube_ids": ["test-beta"], "top_k": 5},
        )
        assert any("ALPHA-MEM-050" in item["memory"] for item in alpha["results"])
        assert any("BETA-MEM-050" in item["memory"] for item in beta["results"])
    print(
        json.dumps(
            {
                "restart_persistence": "passed",
                "counts": {
                    "test-alpha": counts["test-alpha"],
                    "test-beta": counts["test-beta"],
                },
                "markers": ["ALPHA-MEM-050", "BETA-MEM-050"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
