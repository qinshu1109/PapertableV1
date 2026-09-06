from __future__ import annotations

import asyncio
import json

from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response

from .service import ManagedMemoryError, ManagedMemoryService


DEFAULT_TOOL_NAMES = (
    "chat",
    "create_user",
    "create_cube",
    "register_cube",
    "unregister_cube",
    "search_memories",
    "add_memory",
    "get_memory",
    "update_memory",
    "delete_memory",
    "delete_all_memories",
    "clear_chat_history",
    "dump_cube",
    "share_cube",
    "get_user_info",
    "control_memory_scheduler",
)


class ManagedMCPServer:
    def __init__(self, service: ManagedMemoryService):
        self.service = service
        self.official_server = service.official_mcp_server
        self.mcp = self.official_server.mcp
        self._operation_lock = asyncio.Lock()
        self._replace_default_tools()
        self._add_health_route()
        self._add_hook_route()
        self._add_dashboard_routes()

    async def _run(self, function, *args, timeout_seconds: float | None = None):
        # Qdrant embedded mode is single-process but not safe for overlapping
        # reads and writes. Multiple MCP clients share this short operation queue.
        async with self._operation_lock:
            def call():
                with self.service.operation_lock:
                    return function(*args)

            operation = asyncio.to_thread(call)
            if timeout_seconds is None:
                return await operation
            return await asyncio.wait_for(operation, timeout=timeout_seconds)

    def _replace_default_tools(self) -> None:
        # FastMCP 2.13 exposes get_tools as async despite its public signature;
        # the official MemOS 2.0.24 tool set is fixed, so remove that exact set.
        for name in DEFAULT_TOOL_NAMES:
            self.mcp.remove_tool(name)

        @self.mcp.resource("memos://hot/context")
        async def hot_context_resource() -> str:
            """Latest successful local hot-memory snapshot as Markdown."""
            result = await self._run(self.service.get_hot_context, None)
            return str(result.get("context") or "")

        @self.mcp.tool()
        async def list_cubes() -> dict[str, Any]:
            """List the local index and business cubes with capacity information."""
            return await self._run(self.service.list_cubes)

        @self.mcp.tool()
        async def create_cube(
            cube_id: str,
            name: str,
            description: str,
            max_memories: int = 2000,
        ) -> dict[str, Any]:
            """Create an isolated business cube and its single Index Cube entry."""
            return await self._run(
                self.service.create_cube,
                cube_id,
                name,
                description,
                max_memories,
            )

        @self.mcp.tool()
        async def update_cube(
            cube_id: str,
            name: str | None = None,
            description: str | None = None,
            max_memories: int | None = None,
        ) -> dict[str, Any]:
            """Update business cube metadata and synchronize its Index Cube entry."""
            return await self._run(
                self.service.update_cube,
                cube_id,
                name,
                description,
                max_memories,
            )

        @self.mcp.tool()
        async def search_memories(
            query: str,
            cube_ids: list[str],
            top_k: int = 5,
            rerank: str = "auto",
            parent_trace_id: str | None = None,
            search_mode: str = "hybrid",
            routing_decision_id: str | None = None,
            semantic_types: list[str] | None = None,
            managed_kinds: list[str] | None = None,
            subject_types: list[str] | None = None,
            subject_ids: list[str] | None = None,
            statuses: list[str] | None = None,
            occurred_from: str | None = None,
            occurred_to: str | None = None,
            include_expired: bool = False,
        ) -> dict[str, Any]:
            """Search the Index Cube alone or at most two explicitly selected business cubes."""
            try:
                return await self._run(
                    self.service.search_memories,
                    query,
                    cube_ids,
                    min(top_k, self.service.settings.foreground_recall_top_k),
                    rerank,
                    parent_trace_id,
                    "mcp",
                    search_mode,
                    routing_decision_id,
                    semantic_types,
                    managed_kinds,
                    subject_types,
                    subject_ids,
                    statuses,
                    occurred_from,
                    occurred_to,
                    include_expired,
                    timeout_seconds=self.service.settings.foreground_recall_timeout_seconds,
                )
            except asyncio.TimeoutError:
                return {
                    "results": [],
                    "warning": "foreground recall exceeded the bounded deadline; continuing without memory",
                    "timed_out": True,
                    "timeout_seconds": self.service.settings.foreground_recall_timeout_seconds,
                }

        @self.mcp.tool()
        async def search_all_memories(
            query: str,
            top_k: int = 8,
            rerank: str = "auto",
            parent_trace_id: str | None = None,
            search_mode: str = "hybrid",
            routing_decision_id: str | None = None,
            semantic_types: list[str] | None = None,
            managed_kinds: list[str] | None = None,
            subject_types: list[str] | None = None,
            subject_ids: list[str] | None = None,
            statuses: list[str] | None = None,
            occurred_from: str | None = None,
            occurred_to: str | None = None,
            include_expired: bool = False,
        ) -> dict[str, Any]:
            """Explicitly search every business cube; automatic reranking is enabled by default."""
            return await self._run(
                self.service.search_all_memories,
                query,
                top_k,
                rerank,
                parent_trace_id,
                "mcp",
                search_mode,
                routing_decision_id,
                semantic_types,
                managed_kinds,
                subject_types,
                subject_ids,
                statuses,
                occurred_from,
                occurred_to,
                include_expired,
            )

        @self.mcp.tool()
        async def add_memory(
            cube_id: str,
            content: str,
            tags: list[str] | None = None,
            source: str | None = None,
            hot_policy: str = "auto",
            importance: str = "normal",
            valid_until: str | None = None,
            supersedes_memory_id: str | None = None,
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
            evidence_memory_ids: list[str] | None = None,
            locked_fields: list[str] | None = None,
        ) -> dict[str, Any]:
            """Add one durable memory to an explicitly selected business cube."""
            return await self._run(
                self.service.add_memory,
                cube_id,
                content,
                tags,
                source,
                hot_policy,
                importance,
                valid_until,
                supersedes_memory_id,
                semantic_type,
                subject_type,
                subject_id,
                asserted_by,
                client_id,
                conversation_id,
                attributes,
                occurred_at,
                ended_at,
                location,
                participants,
                confidence,
                visibility,
                evidence_memory_ids,
                locked_fields,
            )

        @self.mcp.tool()
        async def get_hot_context(since_version: int | None = None) -> dict[str, Any]:
            """Return the versioned hot facts and hot Cube map; unchanged versions are compact."""
            return await self._run(self.service.get_hot_context, since_version)

        @self.mcp.tool()
        async def route_memory(
            query: str,
            context_sufficient: bool = False,
            hot_version: int | None = None,
        ) -> dict[str, Any]:
            """Use only the local hot map and strong cues to suggest at most two Cubes."""
            return await self._run(
                self.service.route_memory, query, context_sufficient, hot_version, "mcp"
            )

        @self.mcp.tool()
        async def set_memory_policy(
            cube_id: str,
            memory_id: str,
            hot_policy: str,
            valid_until: str | None = None,
            supersedes_memory_id: str | None = None,
        ) -> dict[str, Any]:
            """Pin, exclude, expire or explicitly supersede one sourced memory."""
            return await self._run(
                self.service.set_memory_policy,
                cube_id,
                memory_id,
                hot_policy,
                valid_until,
                supersedes_memory_id,
            )

        @self.mcp.tool()
        async def get_memory(cube_id: str, memory_id: str) -> dict[str, Any]:
            """Get one memory from an explicitly selected cube."""
            return await self._run(self.service.get_memory, cube_id, memory_id)

        @self.mcp.tool()
        async def read_curated_note(knowledge_id: str) -> dict[str, Any]:
            """Read the exact formal Markdown behind a curated retrieval card."""
            return await self._run(self.service.read_curated_note, knowledge_id)

        @self.mcp.tool()
        async def reconcile_curated_knowledge() -> dict[str, Any]:
            """Rebuild the curated-knowledge cache one-way from formal human notes."""
            return await self._run(
                self.service.reconcile_curated_knowledge,
                "mcp",
            )

        @self.mcp.tool()
        async def update_memory(
            cube_id: str,
            memory_id: str,
            content: str | None = None,
            semantic_type: str | None = None,
            subject_type: str | None = None,
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
            visibility: str | None = None,
            status: str | None = None,
            evidence_memory_ids: list[str] | None = None,
            locked_fields: list[str] | None = None,
        ) -> dict[str, Any]:
            """Replace one business-cube memory while preserving its metadata."""
            return await self._run(
                self.service.update_memory,
                cube_id,
                memory_id,
                content,
                semantic_type,
                subject_type,
                subject_id,
                asserted_by,
                client_id,
                conversation_id,
                attributes,
                occurred_at,
                ended_at,
                location,
                participants,
                confidence,
                visibility,
                status,
                evidence_memory_ids,
                locked_fields,
            )

        @self.mcp.tool()
        async def delete_memory(cube_id: str, memory_id: str) -> dict[str, Any]:
            """Delete one explicitly identified business-cube memory."""
            return await self._run(self.service.delete_memory, cube_id, memory_id)

        @self.mcp.tool()
        async def get_cube_stats(cube_id: str | None = None) -> dict[str, Any]:
            """Get count, capacity threshold and local disk use for one or all cubes."""
            return await self._run(self.service.get_cube_stats, cube_id)

        @self.mcp.tool()
        async def compact_cube(cube_id: str) -> dict[str, Any]:
            """Run the transaction-journaled remote-LLM compaction for a business cube."""
            return await self._run(self.service.compact_cube, cube_id)

        @self.mcp.tool()
        async def health() -> dict[str, Any]:
            """Return local service health and the most recent upstream probe status."""
            return self.service.health()

    def _add_health_route(self) -> None:
        @self.mcp.custom_route(
            "/healthz",
            methods=["GET"],
            name="healthz",
            include_in_schema=False,
        )
        async def healthz(_request: Request) -> JSONResponse:
            return JSONResponse(self.service.health())

    def _add_hook_route(self) -> None:
        @self.mcp.custom_route(
            "/hooks/v1/events", methods=["POST"], name="hook-events", include_in_schema=False
        )
        async def hook_events(request: Request) -> JSONResponse:
            client_host = request.client.host if request.client else ""
            if client_host not in {"127.0.0.1", "::1", "localhost"}:
                return self._error_response(ManagedMemoryError("Hook endpoint is loopback-only"), 403)
            try:
                content_length = int(request.headers.get("content-length", "0") or 0)
            except ValueError:
                return self._error_response(ManagedMemoryError("Invalid Content-Length"))
            if content_length > 131072:
                return self._error_response(ManagedMemoryError("Hook payload exceeds 128 KiB"), 413)
            try:
                payload = await request.json()
                if not isinstance(payload, dict):
                    raise ManagedMemoryError("Hook payload must be a JSON object")
                result = await self._run(self.service.record_hook_event, payload)
                return JSONResponse(result)
            except (ManagedMemoryError, ValueError, TypeError, json.JSONDecodeError) as exc:
                return self._error_response(exc)

    @staticmethod
    def _error_response(exc: Exception, status_code: int = 400) -> JSONResponse:
        return JSONResponse(
            {"error": type(exc).__name__, "message": str(exc)},
            status_code=status_code,
        )

    async def _api_call(self, function, *args) -> JSONResponse:
        try:
            result = await self._run(function, *args)
            return JSONResponse(result)
        except (ManagedMemoryError, ValueError, TypeError, json.JSONDecodeError) as exc:
            return self._error_response(exc)
        except Exception as exc:
            return self._error_response(exc, status_code=500)

    def _add_dashboard_routes(self) -> None:
        @self.mcp.custom_route("/ui", methods=["GET"], include_in_schema=False)
        async def dashboard_redirect(_request: Request) -> RedirectResponse:
            return RedirectResponse(url="/ui/", status_code=307)

        @self.mcp.custom_route(
            "/ui/api/overview", methods=["GET"], include_in_schema=False
        )
        async def dashboard_overview(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.dashboard_overview)

        @self.mcp.custom_route(
            "/ui/api/cubes", methods=["GET"], include_in_schema=False
        )
        async def dashboard_cubes(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.list_cubes)

        @self.mcp.custom_route(
            "/ui/api/memories", methods=["GET"], include_in_schema=False
        )
        async def dashboard_memories(request: Request) -> JSONResponse:
            params = request.query_params
            try:
                limit = int(params.get("limit", "50"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(
                self.service.list_memories,
                params.get("cube_id"),
                params.get("cursor"),
                limit,
                params.get("kind"),
                params.get("tag"),
                params.get("query"),
                params.get("date_from"),
                params.get("date_to"),
                params.get("semantic_type"),
                params.get("subject_type"),
                params.get("subject_id"),
                params.get("status"),
                params.get("occurred_from"),
                params.get("occurred_to"),
            )

        @self.mcp.custom_route(
            "/ui/api/memories/{cube_id}/{memory_id}",
            methods=["GET"],
            include_in_schema=False,
        )
        async def dashboard_memory_detail(request: Request) -> JSONResponse:
            return await self._api_call(
                self.service.get_memory,
                request.path_params["cube_id"],
                request.path_params["memory_id"],
            )

        @self.mcp.custom_route(
            "/ui/api/graph", methods=["GET"], include_in_schema=False
        )
        async def dashboard_graph(request: Request) -> JSONResponse:
            params = request.query_params
            try:
                limit = int(params.get("limit", "200"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(
                self.service.memory_graph,
                params.get("cube_id"),
                limit,
            )

        @self.mcp.custom_route(
            "/ui/api/brain/status", methods=["GET"], include_in_schema=False
        )
        async def dashboard_brain_status(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.brain_status)

        @self.mcp.custom_route(
            "/ui/api/brain/pages", methods=["GET"], include_in_schema=False
        )
        async def dashboard_brain_pages(request: Request) -> JSONResponse:
            params = request.query_params
            try:
                limit = int(params.get("limit", "200"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(
                self.service.list_brain_pages,
                params.get("page_type"),
                params.get("cube_id"),
                params.get("query"),
                limit,
            )

        @self.mcp.custom_route(
            "/ui/api/brain/pages/{page_id}",
            methods=["GET"],
            include_in_schema=False,
        )
        async def dashboard_brain_page_detail(request: Request) -> JSONResponse:
            return await self._api_call(
                self.service.get_brain_page,
                request.path_params["page_id"],
            )

        @self.mcp.custom_route(
            "/ui/api/brain/runs", methods=["GET"], include_in_schema=False
        )
        async def dashboard_brain_runs(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "30"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_brain_runs, limit)

        @self.mcp.custom_route(
            "/ui/api/search", methods=["POST"], include_in_schema=False
        )
        async def dashboard_search(request: Request) -> JSONResponse:
            try:
                payload = await request.json()
                query = str(payload.get("query", ""))
                scope = str(payload.get("scope", "selected"))
                top_k = int(payload.get("top_k", 8))
                rerank = str(payload.get("rerank", "auto"))
                search_mode = str(payload.get("search_mode", "hybrid"))
                parent_trace_id = payload.get("parent_trace_id")
                routing_decision_id = payload.get("routing_decision_id")
                semantic_types = payload.get("semantic_types")
                managed_kinds = payload.get("managed_kinds")
                subject_types = payload.get("subject_types")
                subject_ids = payload.get("subject_ids")
                statuses = payload.get("statuses")
                occurred_from = payload.get("occurred_from")
                occurred_to = payload.get("occurred_to")
                include_expired = bool(payload.get("include_expired", False))
                if scope == "all":
                    return await self._api_call(
                        self.service.search_all_memories,
                        query,
                        top_k,
                        rerank,
                        parent_trace_id,
                        "dashboard",
                        search_mode,
                        routing_decision_id,
                        semantic_types,
                        managed_kinds,
                        subject_types,
                        subject_ids,
                        statuses,
                        occurred_from,
                        occurred_to,
                        include_expired,
                    )
                cube_ids = payload.get("cube_ids")
                if not isinstance(cube_ids, list) or not all(
                    isinstance(value, str) for value in cube_ids
                ):
                    raise ManagedMemoryError("cube_ids must be a list of strings")
                return await self._api_call(
                    self.service.search_memories,
                    query,
                    cube_ids,
                    top_k,
                    rerank,
                    parent_trace_id,
                    "dashboard",
                    search_mode,
                    routing_decision_id,
                    semantic_types,
                    managed_kinds,
                    subject_types,
                    subject_ids,
                    statuses,
                    occurred_from,
                    occurred_to,
                    include_expired,
                )
            except (ManagedMemoryError, ValueError, TypeError, json.JSONDecodeError) as exc:
                return self._error_response(exc)

        @self.mcp.custom_route(
            "/ui/api/traces", methods=["GET"], include_in_schema=False
        )
        async def dashboard_traces(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "50"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_traces, limit)

        @self.mcp.custom_route(
            "/ui/api/traces/{trace_id}", methods=["GET"], include_in_schema=False
        )
        async def dashboard_trace_detail(request: Request) -> JSONResponse:
            return await self._api_call(
                self.service.get_trace, request.path_params["trace_id"]
            )

        @self.mcp.custom_route(
            "/ui/api/activity", methods=["GET"], include_in_schema=False
        )
        async def dashboard_activity(request: Request) -> JSONResponse:
            params = request.query_params
            try:
                limit = int(params.get("limit", "50"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(
                self.service.list_activity,
                limit,
                params.get("event"),
                params.get("cube_id"),
                params.get("caller"),
            )

        @self.mcp.custom_route(
            "/ui/api/compactions", methods=["GET"], include_in_schema=False
        )
        async def dashboard_compactions(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "50"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_compactions, limit)

        @self.mcp.custom_route(
            "/ui/api/compactions/{job_id}", methods=["GET"], include_in_schema=False
        )
        async def dashboard_compaction_detail(request: Request) -> JSONResponse:
            return await self._api_call(
                self.service.get_compaction, request.path_params["job_id"]
            )

        @self.mcp.custom_route(
            "/ui/api/models", methods=["GET"], include_in_schema=False
        )
        async def dashboard_models(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.model_status)

        @self.mcp.custom_route(
            "/ui/api/hot/status", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_status(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.hot_status)

        @self.mcp.custom_route(
            "/ui/api/hot/context", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_context(request: Request) -> JSONResponse:
            raw_version = request.query_params.get("since_version")
            try:
                version = int(raw_version) if raw_version is not None else None
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.get_hot_context, version)

        @self.mcp.custom_route(
            "/ui/api/hot/items", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_items(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "200"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_hot_items, limit)

        @self.mcp.custom_route(
            "/ui/api/hot/cubes", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_cubes(_request: Request) -> JSONResponse:
            return await self._api_call(self.service.list_hot_cubes)

        @self.mcp.custom_route(
            "/ui/api/hot/candidates", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_candidates(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "200"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_hot_candidates, limit)

        @self.mcp.custom_route(
            "/ui/api/hot/routes", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_routes(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "100"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_hot_routes, limit)

        @self.mcp.custom_route(
            "/ui/api/hot/runs", methods=["GET"], include_in_schema=False
        )
        async def dashboard_hot_runs(request: Request) -> JSONResponse:
            try:
                limit = int(request.query_params.get("limit", "100"))
            except ValueError as exc:
                return self._error_response(exc)
            return await self._api_call(self.service.list_hot_runs, limit)

        @self.mcp.custom_route(
            "/ui/api/hot/route", methods=["POST"], include_in_schema=False
        )
        async def dashboard_hot_route(request: Request) -> JSONResponse:
            try:
                payload = await request.json()
                return await self._api_call(
                    self.service.route_memory,
                    str(payload.get("query", "")),
                    bool(payload.get("context_sufficient", False)),
                    payload.get("hot_version"),
                    "dashboard",
                )
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self._error_response(exc)

        @self.mcp.custom_route(
            "/ui/assets/{asset_path:path}", methods=["GET"], include_in_schema=False
        )
        async def dashboard_asset(request: Request) -> Response:
            ui_root = Path(__file__).with_name("ui_dist").resolve()
            asset_root = (ui_root / "assets").resolve()
            candidate = (asset_root / request.path_params["asset_path"]).resolve()
            if asset_root not in candidate.parents or not candidate.is_file():
                return Response(status_code=404)
            return FileResponse(
                candidate,
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )

        @self.mcp.custom_route(
            "/ui/{page_path:path}", methods=["GET"], include_in_schema=False
        )
        async def dashboard_spa(_request: Request) -> Response:
            index_path = Path(__file__).with_name("ui_dist") / "index.html"
            if not index_path.is_file():
                return JSONResponse(
                    {
                        "error": "DashboardNotBuilt",
                        "message": "Run the dashboard build before opening /ui/.",
                    },
                    status_code=503,
                )
            return FileResponse(index_path, headers={"Cache-Control": "no-store"})

    async def run(self) -> None:
        await self.mcp.run_http_async(
            host=self.service.settings.host,
            port=self.service.settings.port,
            path="/mcp",
            transport="http",
            show_banner=False,
            log_level="warning",
            json_response=True,
        )
