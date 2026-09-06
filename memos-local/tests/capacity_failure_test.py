from __future__ import annotations

import asyncio
import json

from fastmcp import Client


async def call(client: Client, name: str, arguments: dict):
    result = await client.call_tool(name, arguments)
    if result.is_error:
        raise RuntimeError(str(result.content))
    return result.data


async def main() -> None:
    async with Client("http://127.0.0.1:8002/mcp") as client:
        await call(
            client,
            "create_cube",
            {
                "cube_id": "capacity-test",
                "name": "容量失败验收",
                "description": "验证远程压缩不可用时不删除原文并执行硬容量限制。",
                "max_memories": 20,
            },
        )
        stats = await call(client, "get_cube_stats", {"cube_id": "capacity-test"})
        if stats["stats"][0]["count"]:
            raise RuntimeError("capacity-test is not empty")

        warnings = []
        for index in range(1, 21):
            result = await call(
                client,
                "add_memory",
                {
                    "cube_id": "capacity-test",
                    "content": f"CAPACITY-MEM-{index:02d}：容量失败保护测试原文 {index}。",
                    "tags": ["acceptance", "capacity"],
                    "source": "capacity-test",
                },
            )
            if result.get("warning"):
                warnings.append(result["warning"])

        rejected = False
        try:
            result = await client.call_tool(
                "add_memory",
                {
                    "cube_id": "capacity-test",
                    "content": "CAPACITY-MEM-21：此条必须被硬容量限制拒绝。",
                },
            )
            rejected = bool(result.is_error)
        except Exception:
            rejected = True

        final_stats = await call(client, "get_cube_stats", {"cube_id": "capacity-test"})
        count = final_stats["stats"][0]["count"]
        search = await call(
            client,
            "search_memories",
            {"query": "CAPACITY-MEM-01", "cube_ids": ["capacity-test"], "top_k": 20},
        )
        assert count == 20
        assert rejected
        assert warnings
        assert all("CAPACITY-MEM-21" not in item["memory"] for item in search["results"])
        print(
            json.dumps(
                {
                    "count_after_failed_compaction": count,
                    "hard_limit_rejected_21st": rejected,
                    "compaction_warnings": len(warnings),
                    "source_deletion": "none",
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
