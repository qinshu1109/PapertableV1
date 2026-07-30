import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDataStore, httpError, requireCard, requireRun, type DataStore } from "./data.ts";
import { PapertableEngine, type BranchRequest, type StoredRunEvent } from "./engine.ts";
import { MemoryBridge } from "./memos.ts";
import {
  addProjectMaterial,
  bindLibrary,
  deleteProjectMaterial,
  MAX_MATERIAL_BYTES,
  reindexLibrary,
} from "./notes.ts";
import { createProject, listProjects, projectDetail } from "./projects.ts";
import {
  adoptRun,
  confirmVerdict,
  createTombstoneDraft,
  ensureVerdictTables,
  listVerdicts,
  supersedeVerdict,
} from "./verdicts.ts";
import { PromotionService } from "./promotion.ts";
import { createSessionRepo } from "./sessions.ts";

const HOST = "127.0.0.1";
const PORT = 4317;
const STATIC_ROOT = fileURLToPath(new URL("../public/", import.meta.url));

export type PapertableApp = Awaited<ReturnType<typeof createApp>>;

export async function createApp(dataDir?: string) {
  const store = openDataStore(dataDir);
  ensureVerdictTables(store.db);
  const sessions = createSessionRepo(store);
  const engine = new PapertableEngine(store, sessions);
  const recovered = await engine.recoverInterruptedRuns();
  const memory = new MemoryBridge(store, sessions, engine);
  const promotions = new PromotionService(store, memory);
  const memoryStatus = await memory.initialize();
  await promotions.retryPendingReconciles().catch(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, { store, sessions, engine, memory, promotions, memoryStatus });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = typeof error === "object" && error && "status" in error
        ? Number((error as { status: unknown }).status)
        : 500;
      json(response, Number.isInteger(status) ? status : 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const idleTimer = setInterval(() => {
    void memory.stageIdleCards()
      .then(() => memory.retryPending())
      .then(() => promotions.retryPendingReconciles())
      .catch(() => undefined);
  }, 60_000);
  idleTimer.unref();

  return {
    store,
    engine,
    memory,
    promotions,
    memoryStatus,
    recovered,
    server,
    async close() {
      clearInterval(idleTimer);
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.shutdown();
      const cards = store.db.prepare("SELECT id FROM pt_cards").all() as Array<{ id: string }>;
      await Promise.allSettled(cards.map((card) => memory.stageCard(card.id, "server_shutdown")));
      await serverClosed;
      store.db.close();
    },
  };
}

type Services = {
  store: DataStore;
  sessions: ReturnType<typeof createSessionRepo>;
  engine: PapertableEngine;
  memory: MemoryBridge;
  promotions: PromotionService;
  memoryStatus: { available: boolean; error?: string };
};

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  services: Services,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (method === "GET" && path === "/api/status") {
    json(response, 200, {
      ready: true,
      node: process.version,
      modelConfigured: Boolean(
        process.env.PAPERTABLE_BASE_URL
        && process.env.PAPERTABLE_API_KEY
        && process.env.PAPERTABLE_MODEL
      ),
      protocol: "anthropic-messages",
      memory: services.memoryStatus,
    });
    return;
  }
  if (path === "/api/projects" && method === "GET") {
    json(response, 200, { projects: listProjects(services.store.db) });
    return;
  }
  if (path === "/api/projects" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, createProject(services.store, String(body.name || "")));
    return;
  }

  let match = path.match(/^\/api\/projects\/([^/]+)$/u);
  if (match && method === "GET") {
    json(response, 200, projectDetail(services.store, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/library$/u);
  if (match && method === "PUT") {
    const body = await readJson(request);
    await bindLibrary(services.store, decodeURIComponent(match[1]), String(body.path || ""));
    json(response, 200, { ok: true });
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/library\/reindex$/u);
  if (match && method === "POST") {
    json(response, 200, await reindexLibrary(services.store, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/materials$/u);
  if (match && method === "POST") {
    const encoded = request.headers["x-filename"];
    if (typeof encoded !== "string") throw httpError(400, "缺少临时材料文件名");
    const bytes = await readBytes(request, MAX_MATERIAL_BYTES);
    const item = await addProjectMaterial(
      services.store,
      decodeURIComponent(match[1]),
      decodeURIComponent(encoded),
      bytes,
    );
    json(response, 201, item);
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/materials\/([^/]+)$/u);
  if (match && method === "DELETE") {
    await deleteProjectMaterial(
      services.store,
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    );
    json(response, 200, { ok: true });
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/cards$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 202, await services.engine.createRootCard(
      decodeURIComponent(match[1]),
      String(body.question || ""),
      typeof body.title === "string" ? body.title : undefined,
    ));
    return;
  }

  match = path.match(/^\/api\/cards\/([^/]+)$/u);
  if (match && method === "GET") {
    json(response, 200, await services.engine.cardDetail(decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/cards\/([^/]+)\/messages$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 202, await services.engine.continueCard(
      decodeURIComponent(match[1]),
      String(body.question || ""),
    ));
    return;
  }
  match = path.match(/^\/api\/cards\/([^/]+)\/branches$/u);
  if (match && method === "POST") {
    const cardId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const result = await services.engine.createBranch(cardId, body as unknown as BranchRequest);
    await services.memory.stageCard(cardId, "branch_created");
    // 判决簿：改道即触发墓碑起草（proposed，等待用户确认；不阻塞失败）
    let verdict: Record<string, unknown> | null = null;
    if ((body as { kind?: string }).kind === "reroute") {
      verdict = await createTombstoneDraft(services.store, services.sessions, result.cardId)
        .catch(() => null);
    }
    json(response, 202, verdict ? { ...result, verdict } : result);
    return;
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/verdicts$/u);
  if (match && method === "GET") {
    json(response, 200, { verdicts: listVerdicts(services.store.db, decodeURIComponent(match[1])) });
    return;
  }
  match = path.match(/^\/api\/verdicts\/([^/]+)\/confirm$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, confirmVerdict(
      services.store,
      decodeURIComponent(match[1]),
      typeof body.text === "string" ? body.text : undefined,
    ));
    return;
  }
  match = path.match(/^\/api\/verdicts\/([^/]+)\/supersede$/u);
  if (match && method === "POST") {
    json(response, 200, supersedeVerdict(services.store, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/runs\/([^/]+)\/adopt$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 201, adoptRun(
      services.store,
      decodeURIComponent(match[1]),
      String(body.handle || ""),
      typeof body.text === "string" ? body.text : undefined,
    ));
    return;
  }
  match = path.match(/^\/api\/cards\/([^/]+)\/stage$/u);
  if (match && method === "POST") {
    const body = await readJson(request).catch(() => ({}));
    json(response, 200, await services.memory.stageCard(
      decodeURIComponent(match[1]),
      String(body.reason || "card_left"),
    ));
    return;
  }

  match = path.match(/^\/api\/runs\/([^/]+)\/events$/u);
  if (match && method === "GET") {
    openSse(response, request, services.engine, decodeURIComponent(match[1]));
    return;
  }
  match = path.match(/^\/api\/runs\/([^/]+)\/abort$/u);
  if (match && method === "POST") {
    await services.engine.abort(decodeURIComponent(match[1]));
    json(response, 202, { ok: true });
    return;
  }
  match = path.match(/^\/api\/runs\/([^/]+)\/retry$/u);
  if (match && method === "POST") {
    json(response, 202, await services.engine.retry(decodeURIComponent(match[1])));
    return;
  }

  if (path === "/api/knowledge-universe" && method === "GET") {
    json(response, 200, await services.memory.knowledgeUniverse());
    return;
  }
  if (path === "/api/promotions/preview" && method === "POST") {
    json(response, 201, await services.promotions.preview(
      await readJson(request) as Parameters<PromotionService["preview"]>[0],
    ));
    return;
  }
  match = path.match(/^\/api\/promotions\/([^/]+)\/publish$/u);
  if (match && method === "POST") {
    json(response, 200, await services.promotions.publish(decodeURIComponent(match[1])));
    return;
  }

  if (method === "GET" && !path.startsWith("/api/")) {
    await serveStatic(path, response);
    return;
  }
  throw httpError(404, "接口不存在");
}

function openSse(
  response: ServerResponse,
  request: IncomingMessage,
  engine: PapertableEngine,
  runId: string,
): void {
  const run = requireRun(engine.store.db, runId);
  const after = Math.max(0, Number(request.headers["last-event-id"] || 0) || 0);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  for (const event of engine.events(runId, after)) writeSse(response, event);
  if (run.status === "ended") {
    response.end();
    return;
  }
  const unsubscribe = engine.subscribe(runId, (event) => {
    writeSse(response, event);
    if (event.event === "run_end") {
      cleanup();
      response.end();
    }
  });
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once("close", cleanup);
}

function writeSse(response: ServerResponse, event: StoredRunEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.event}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

async function serveStatic(path: string, response: ServerResponse): Promise<void> {
  const requested = path === "/" ? "index.html" : path.replace(/^\/+/u, "");
  // 路径穿越防护：解析后必须仍在 STATIC_ROOT 内
  const resolved = resolve(STATIC_ROOT, requested);
  if (!resolved.startsWith(resolve(STATIC_ROOT))) throw httpError(404, "页面不存在");
  let target = resolved;
  let type = STATIC_TYPES[extname(resolved)];
  let bytes: Buffer;
  try {
    if (!type) throw new Error("fallback");
    bytes = await readFile(target);
  } catch {
    // SPA 回退：未知路径一律返回 index.html
    target = resolve(STATIC_ROOT, "index.html");
    type = STATIC_TYPES[".html"];
    bytes = await readFile(target).catch(() => {
      throw httpError(404, "页面不存在");
    });
  }
  response.writeHead(200, {
    "content-type": type,
    "cache-control": requested.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, 1_048_576);
  if (bytes.byteLength === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw httpError(400, "请求体必须是 JSON 对象");
  }
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers["content-length"] || 0);
  if (length > limit) throw httpError(413, "请求体过大");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw httpError(413, "请求体过大");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function main(): Promise<void> {
  const app = await createApp();
  app.server.listen(PORT, HOST, () => {
    process.stdout.write(`${JSON.stringify({
      event: "server_ready",
      url: `http://${HOST}:${PORT}`,
      database: app.store.databasePath,
      recoveredRuns: app.recovered,
      memory: app.memoryStatus,
    })}\n`);
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
