from __future__ import annotations

import asyncio
import json
import time

from pathlib import Path

from fastmcp import Client


URL = "http://127.0.0.1:8002/mcp"
RESULT_PATH = Path(
    "/Users/qinshu/Library/Application Support/MemOSLocal/acceptance-before-restart.json"
)


async def call(client: Client, name: str, arguments: dict):
    result = await client.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(f"{name} failed: {result.content}")
    return result.data


async def expect_error(client: Client, name: str, arguments: dict) -> str:
    try:
        result = await client.call_tool(name, arguments)
        if result.is_error:
            return str(result.content)
    except Exception as exc:
        return type(exc).__name__
    raise AssertionError(f"{name} unexpectedly succeeded")


async def main() -> None:
    started = time.monotonic()
    async with Client(URL) as client:
        await call(
            client,
            "create_cube",
            {
                "cube_id": "test-alpha",
                "name": "验收 Alpha",
                "description": "保存 Alpha 项目的测试偏好与唯一验收标记。",
                "max_memories": 2000,
            },
        )
        await call(
            client,
            "create_cube",
            {
                "cube_id": "test-beta",
                "name": "验收 Beta",
                "description": "保存 Beta 项目的测试决策与唯一验收标记。",
                "max_memories": 2000,
            },
        )

        stats = await call(client, "get_cube_stats", {})
        counts = {item["cube_id"]: item["count"] for item in stats["stats"]}
        if counts.get("test-alpha") or counts.get("test-beta"):
            raise RuntimeError("Acceptance cubes are not empty; refusing to duplicate seed data")

        for index in range(1, 51):
            await call(
                client,
                "add_memory",
                {
                    "cube_id": "test-alpha",
                    "content": (
                        f"ALPHA-MEM-{index:03d}：Alpha 项目验收偏好编号 {index}，"
                        "回答时采用蓝色主题并保留明确来源。"
                    ),
                    "tags": ["acceptance", "alpha"],
                    "source": "acceptance-seed",
                },
            )
            await call(
                client,
                "add_memory",
                {
                    "cube_id": "test-beta",
                    "content": (
                        f"BETA-MEM-{index:03d}：Beta 项目验收决策编号 {index}，"
                        "回答时采用绿色主题并先列风险。"
                    ),
                    "tags": ["acceptance", "beta"],
                    "source": "acceptance-seed",
                },
            )
            if index % 10 == 0:
                print(f"seeded={index * 2}", flush=True)

        final_stats = await call(client, "get_cube_stats", {})
        final_counts = {item["cube_id"]: item["count"] for item in final_stats["stats"]}
        assert final_counts["test-alpha"] == 50
        assert final_counts["test-beta"] == 50

        alpha = await call(
            client,
            "search_memories",
            {"query": "ALPHA-MEM-050 蓝色主题", "cube_ids": ["test-alpha"], "top_k": 10},
        )
        beta = await call(
            client,
            "search_memories",
            {"query": "BETA-MEM-050 绿色主题", "cube_ids": ["test-beta"], "top_k": 10},
        )
        assert alpha["searched_cube_ids"] == ["test-alpha"]
        assert beta["searched_cube_ids"] == ["test-beta"]
        assert all(item["cube_id"] == "test-alpha" for item in alpha["results"])
        assert all("BETA-MEM" not in item["memory"] for item in alpha["results"])
        assert all(item["cube_id"] == "test-beta" for item in beta["results"])
        assert all("ALPHA-MEM" not in item["memory"] for item in beta["results"])

        index_result = await call(
            client,
            "search_memories",
            {"query": "Alpha Beta 项目知识库", "cube_ids": ["index"], "top_k": 10},
        )
        index_text = "\n".join(item["memory"] for item in index_result["results"])
        assert "test-alpha" in index_text and "test-beta" in index_text

        empty_error = await expect_error(
            client,
            "search_memories",
            {"query": "must fail", "cube_ids": [], "top_k": 5},
        )
        three_error = await expect_error(
            client,
            "search_memories",
            {
                "query": "must fail",
                "cube_ids": ["test-alpha", "test-beta", "test-gamma"],
                "top_k": 5,
            },
        )

    result = {
        "seeded": 100,
        "counts": {"test-alpha": 50, "test-beta": 50},
        "isolation": "passed",
        "index_routing": "passed",
        "empty_scope_rejected": bool(empty_error),
        "three_cube_scope_rejected": bool(three_error),
        "elapsed_seconds": round(time.monotonic() - started, 2),
    }
    RESULT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    RESULT_PATH.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
