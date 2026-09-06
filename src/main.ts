import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { contentText } from "@earendil-works/pi-ai";
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
import {
  createProject,
  deleteProject,
  listProjects,
  projectDetail,
  purgeCards,
  renameCard,
  renameProject,
  restoreCards,
  trashCards,
} from "./projects.ts";
import {
  abandonTombstone,
  adoptRun,
  confirmVerdict,
  createTombstoneDraft,
  getVerdictStatus,
  initializeVerdicts,
  listVerdicts,
  onVerdictConfirmed,
  retryPendingVerdicts,
  supersedeVerdict,
} from "./verdicts.ts";
import { PromotionService } from "./promotion.ts";
import {
  loadProviderSettings,
  saveProviderSettings,
  createPapertableProvider,
} from "./provider-settings.ts";
import { createSessionRepo } from "./sessions.ts";
import { createPwBet, ensurePwBetTables, getPwBet, listPwBets } from "./pw-bets.ts";
import {
  computeDueSignals,
  createBetSignal,
  ensurePwNotifyTables,
  listPendingOutbox,
  markOutboxFailed,
  markOutboxSent,
  verifyDispositionToken,
} from "./pw-notify.ts";
import {
  attachPwArtifact,
  detachPwArtifact,
  ensurePwArtifactTables,
  listPwArtifacts,
} from "./pw-artifacts.ts";
import { createPwDataDoc, ensurePwDataDocTables, listPwDataDocs } from "./pw-data-docs.ts";
import {
  ensurePwVerdictTables,
  listDuePwBets,
  listPwVerdicts,
  searchPwVerdicts,
  settlePwBet,
  tombstoneCauseStats,
} from "./pw-verdicts.ts";
import {
  ensurePwGoldMirrorTables,
  listMirroredGolds,
  mirrorConfirmedGolds,
} from "./pw-gold-sync.ts";
import {
  addPwVoiceItem,
  classifyPwVoiceItems,
  dropPwVoiceItem,
  ensurePwVoiceTables,
  listPwVoiceItems,
  setPwVoiceAutoClassifier,
} from "./pw-voice.ts";
import {
  collectPwCorpusComment,
  listPwVoiceCorpusComments,
  promotePwVoiceToCard,
} from "./pw-voice-promote.ts";
import {
  confirmPwBetDraft,
  createPwBetDraft,
  ensurePwDraftTables,
  listPwBetDrafts,
  rejectPwBetDraft,
} from "./pw-drafts.ts";
import {
  activatePwBet,
  preflightPwBetActivation,
} from "./pw-bet-gate.ts";
import {
  getPwBetLedger,
  getPwHealthAccounts,
} from "./pw-bet-health.ts";
import {
  ensurePwRunTables,
  getPwActivityDaily,
  getPwBetTimeline,
  recordPwEvent,
  type PwEventType,
} from "./pw-runs.ts";
import {
  ensurePwConnectionTables,
  listAllPwDataDocs,
  listPwConnections,
  registerPwConnection,
  setPwConnectionStatus,
  syncPwBilibili,
} from "./pw-connections.ts";
import {
  approvePwCorpusProposal,
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
  failPwCorpus,
  getPwCorpusDoc,
  listPwCorpus,
  listPwCorpusPending,
  markPwCorpusFetching,
  rejectPwCorpusProposal,
  searchPwCorpus,
} from "./pw-corpus.ts";
import { assembleJudgmentContext, buildCollabContext } from "./pw-context.ts";
import {
  approvePwSettleDraft,
  collabPendingQueue,
  ensurePwCollabTables,
  listPwCollabMessages,
  rejectPwSettleDraft,
  runCollabTurn,
} from "./pw-collab.ts";
import {
  createSieveNotifier,
  ensurePwSieveTables,
  getPwSieveDirectionStats,
  listPwSieveCardsByStatus,
  resieveAllPwSieve,
  setSieveDirection,
  sieveStatus,
  type SieveNotifier,
} from "./pw-sieve.ts";
import { ensurePwVerdictRefTables } from "./pw-verdict-refs.ts";
// 简报 23 · 第二期学习闭环编译层（判决晋级 / 先例处置 / 曝光流水）
import {
  disposePwPrecedents,
  getPwVerdictPromotion,
  listPwBetPrecedents,
  listPwVerdictExposures,
  promotePwVerdict,
} from "./pw-closed-loop.ts";
import { ensurePwContentDraftTables } from "./pw-content-drafts.ts";
import {
  ensurePwDraftBlacklistTables,
  maybeAutoFirePwDraft,
} from "./pw-draft-autofire.ts";
import {
  listContentBets,
  pickPwSieveCard,
  rejectAllPendingPwSieveCards,
  rejectPwSieveCard,
  type ContentBetOverrides,
} from "./pw-content-bets.ts";
import {
  countPwContentDraftsByBet,
  finalizePwContentDraft,
  listPwContentDraftsByBet,
  rejectPwContentDraft,
} from "./pw-content-drafts.ts";
import { listPwAmmoShelf, listPwVerdictRefLog } from "./pw-verdict-refs.ts";
import { getPwOutputRanking, getPwSourceComparison } from "./pw-source-stats.ts";
import { getPwDaySummary, renderPwDaySummaryText } from "./pw-day-summary.ts";
import {
  getPwNotesDailyStats,
  getPwNotesStatus,
  getPwNotesTagCounts,
  readPwNotesList,
  searchPwNotes,
} from "./pw-notes.ts";
import { recallPwNotesForBet } from "./pw-note-recall.ts";
import {
  ensurePwRecallEventTables,
  getPwRecallEventsSummary,
  listPwRecallEvents,
} from "./pw-recall-events.ts";
import { getPwModeBar } from "./pw-mode-bar.ts";
import {
  applyPwProposal,
  createPwProposal,
  getPwProposal,
  listPwProposals,
  reviewPwProposal,
} from "./pw-proposals.ts";
import {
  ensurePwNoteInsightTables,
  listPwNoteInsights,
  publicPwNoteInsight,
  runPwNoteInsight,
  type PwNoteInsightRow,
} from "./pw-note-insight.ts";
import { runPwDraftPipeline } from "./pw-draft-pipeline.ts";
import {
  ensurePwNoteRollupTables,
  listPwNoteRollups,
  publicPwNoteRollup,
  runPwNoteRollupTick,
} from "./pw-note-rollup.ts";
import {
  buildPwNoteTree,
  confirmPwNoteAttach,
  ensurePwNoteTreeTables,
  runPwNoteTreeTick,
  setPwNoteKeyword,
} from "./pw-note-tree.ts";
import {
  confirmPwMinerCandidate,
  confirmPwMinerCard,
  ensurePwMinerTables,
  listPwMinerCards,
  listPwMinerCandidates,
  rejectPwMinerCard,
  rejectPwMinerCandidate,
  runPwMiner,
  seedPwMinerCard,
  type PwMinerCardStatus,
  type PwMinerStatus,
} from "./pw-miner.ts";
import {
  ensurePwNoteBoardTables,
  getPwNoteBoard,
  getPwNoteJourney,
  snapshotPwNoteValues,
} from "./pw-note-board.ts";
import { exportChainToMemos, generateChainSummary } from "./pt-chain-export.ts";
import {
  aggregatePwVoiceThemeCards,
  collectPwVoiceThemeCard,
  ensurePwVoiceCardTables,
  listPwVoiceThemeCards,
  rejectPwVoiceThemeCard,
  type PwVoiceCardStatus,
} from "./pw-voice-cards.ts";
import {
  addPwVoiceTrackVideo,
  aggregatePwVoiceTrack,
  createPwVoiceTrack,
  ensurePwVoiceSieveTables,
  ensurePwVoiceTrackTables,
  getPwVoiceSieveMatrix,
  getPwVoiceSieveRun,
  importPwVoiceSieveRun,
  listPwVoiceSieveRuns,
  listPwVoiceTracks,
  removePwVoiceTrackVideo,
} from "./pw-voice-sieve.ts";

const HOST = "127.0.0.1";
const PORT = 4317;
const STATIC_ROOT = fileURLToPath(new URL("../public/", import.meta.url));

export type PapertableApp = Awaited<ReturnType<typeof createApp>>;

/** TASK-PW-26：镜像挂钩只挂一次（createApp 可被测试多次调用，模块级订阅会累积）。 */
let verdictMirrorHookRegistered = false;

export async function createApp(dataDir?: string) {
  const store = openDataStore(dataDir);
  loadProviderSettings(store.dataDir);
  const verdictStatus = await initializeVerdicts(store);
  // Paperweight（镇纸）P0 表：幂等建表，集成挂载点
  ensurePwBetTables(store.db);
  ensurePwArtifactTables(store.db);
  ensurePwDataDocTables(store.db);
  ensurePwVerdictTables(store.db);
  ensurePwGoldMirrorTables(store.db);
  ensurePwVoiceTables(store.db);
  ensurePwVoiceCardTables(store.db);
  ensurePwVoiceSieveTables(store.db);
  ensurePwVoiceTrackTables(store.db);
  ensurePwDraftTables(store.db);
  ensurePwRunTables(store.db);
  ensurePwConnectionTables(store.db);
  ensurePwCorpusTables(store.db);
  ensurePwCollabTables(store.db);
  ensurePwSieveTables(store.db);
  ensurePwVerdictRefTables(store.db);
  ensurePwContentDraftTables(store.db);
  ensurePwDraftBlacklistTables(store.db);
  ensurePwNoteInsightTables(store.db);
  ensurePwNoteRollupTables(store.db);
  ensurePwNoteTreeTables(store.db);
  ensurePwMinerTables(store.db);
  ensurePwNoteBoardTables(store.db);
  ensurePwRecallEventTables(store.db);
  ensurePwNotifyTables(store.db);
  const sessions = createSessionRepo(store);
  // TASK-PW-18：筛子到达通知器（内存去抖队列 + 单飞；watermark 兜底挂 idleTimer）
  const sieve = createSieveNotifier({ db: store.db });
  // TASK-PW-26：AI 自主档接线——①金子确认后自动镜像（actor=system；监听去重，多次 createApp 不重复挂）；
  // ②观众声音录入后自动分拣（fire-and-forget，失败只留未分拣；手工路由 :655 保留为后路）。
  if (!verdictMirrorHookRegistered) {
    verdictMirrorHookRegistered = true;
    onVerdictConfirmed((db) => {
      try {
        mirrorConfirmedGolds(db, { actor: "system" });
      } catch {
        // 镜像失败不拖垮确认；人工镜像路由（:619）保留为后路
      }
    });
  }
  setPwVoiceAutoClassifier((db, ids) => {
    void classifyPwVoiceItems(db, ids, pwVoiceLlm).catch(() => undefined);
  });
  const engine = new PapertableEngine(store, sessions);
  const recovered = await engine.recoverInterruptedRuns();
  const memory = new MemoryBridge(store, sessions, engine);
  const promotions = new PromotionService(store, memory);
  const memoryStatus = await memory.initialize();
  await promotions.retryPendingReconciles().catch(() => undefined);

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, {
        store,
        sessions,
        engine,
        memory,
        promotions,
        memoryStatus,
        sieve,
      });
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = typeof error === "object" && error && "status" in error
        ? Number((error as { status: unknown }).status)
        : 500;
      const errorBody: Record<string, unknown> = {
        error: error instanceof Error ? error.message : String(error),
      };
      // TASK-PW-65：httpError 第三参 details（对账失败详情等）随错误响应返回
      if (typeof error === "object" && error && "details" in error) {
        errorBody.details = (error as { details: unknown }).details;
      }
      json(response, Number.isInteger(status) ? status : 500, errorBody);
    }
  });

  const idleTimer = setInterval(() => {
    void memory.stageIdleCards()
      .then(() => memory.retryPending())
      .then(() => retryPendingVerdicts(store))
      .then(() => promotions.retryPendingReconciles())
      .then(() => sieve.tickWatermark())
      .catch(() => undefined);
  }, 60_000);
  idleTimer.unref();
  // TASK-PW-58：笔记自动卷积巡检——启动 1 分钟后首跑，之后每 30 分钟一轮；
  // 调用处 try/catch 包住，异常只记日志不炸服务（模块本体不带定时器）
  const runRollupTick = () => {
    runPwNoteRollupTick(store.db).catch((error) => {
      console.warn(`笔记卷积巡检失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const rollupTimer = setInterval(runRollupTick, 30 * 60_000);
  rollupTimer.unref();
  const rollupFirstTimer = setTimeout(runRollupTick, 60_000);
  rollupFirstTimer.unref();
  // TASK-PW-74：停掉 miner scheduled 自动捞料（原 1 分钟首跑 + 每 5 分钟检查本地 06:30）。
  // runPwMinerScheduledTick 与 POST /api/pw/miner/run 手动触发仍保留。
  // TASK-PW-72 批次 B：通知发件箱巡检——启动 5 秒后首跑，之后每 30 秒扫 listPendingOutbox 发飞书。
  // 飞书凭证只在 createPwNotifySender 闭包里读；computeDueSignals 在 P1 不接定时器（手动 POST 触发）。
  const pwNotifySender = createPwNotifySender(store.db);
  const runNotifyTick = () => {
    pwNotifySender.tick().catch((error) => {
      console.warn(`押注通知巡检失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const notifyTimer = setInterval(runNotifyTick, 30_000);
  notifyTimer.unref();
  const notifyFirstTimer = setTimeout(runNotifyTick, 5_000);
  notifyFirstTimer.unref();

  return {
    store,
    engine,
    memory,
    promotions,
    memoryStatus,
    verdictStatus,
    recovered,
    sieve,
    server,
    async close() {
      clearInterval(idleTimer);
      clearInterval(rollupTimer);
      clearTimeout(rollupFirstTimer);
      clearInterval(notifyTimer);
      clearTimeout(notifyFirstTimer);
      sieve.close();
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
  sieve: SieveNotifier;
};

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  services: Services,
): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (path === "/api/settings/provider" && method === "GET") {
    json(response, 200, loadProviderSettings(services.store.dataDir));
    return;
  }
  if (path === "/api/settings/provider" && method === "PUT") {
    const body = await readJson(request);
    services.engine.resetProvider();
    json(response, 200, saveProviderSettings(services.store.dataDir, body));
    return;
  }
  if (method === "GET" && path === "/api/status") {
    const provider = loadProviderSettings(services.store.dataDir);
    json(response, 200, {
      ready: true,
      node: process.version,
      modelConfigured: Boolean(
        provider.baseUrl
        && provider.hasApiKey
        && provider.model
      ),
      protocol: provider.protocol,
      memory: services.memoryStatus,
      verdicts: await getVerdictStatus(services.store),
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

  let ptMatch = path.match(/^\/api\/pt\/projects\/([^/]+)\/chain-summary$/u);
  if (ptMatch && method === "GET") {
    json(response, 200, await generateChainSummary(services.store, decodeURIComponent(ptMatch[1])));
    return;
  }
  ptMatch = path.match(/^\/api\/pt\/projects\/([^/]+)\/chain-export$/u);
  if (ptMatch && method === "POST") {
    const body = await readJson(request);
    json(response, 200, await exportChainToMemos(services.store.db, decodeURIComponent(ptMatch[1]), body.markdown));
    return;
  }

  let match = path.match(/^\/api\/projects\/([^/]+)$/u);
  if (match && method === "PUT") {
    const body = await readJson(request);
    json(response, 200, renameProject(
      services.store,
      decodeURIComponent(match[1]),
      String(body.name || ""),
    ));
    return;
  }
  if (match && method === "GET") {
    json(response, 200, projectDetail(services.store, decodeURIComponent(match[1])));
    return;
  }
  // TASK-PW-70：项目整删（无保护）。running 的 run 先置 ended/interrupted，数据与磁盘全清。
  if (match && method === "DELETE") {
    json(response, 200, await deleteProject(services.store, decodeURIComponent(match[1])));
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
  // TASK-PW-67：筛子精选评论静态落卡（不跑 AI run；同 rpid 跳过）
  // TASK-PW-69：corpusRunIds 可选——把筛子 run 信号评论写成项目临时材料
  match = path.match(/^\/api\/projects\/([^/]+)\/cards\/import$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 201, await services.engine.importCommentCards(
      decodeURIComponent(match[1]),
      body.cards as Parameters<typeof services.engine.importCommentCards>[1],
      { corpusRunIds: body.corpusRunIds },
    ));
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/cards\/purge$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { cardIds?: unknown };
    const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map(String) : [];
    json(response, 200, purgeCards(services.store, decodeURIComponent(match[1]), cardIds));
    return;
  }
  // TASK-PW-70：回收站软删除/恢复（无保护，跨项目 id 静默跳过）
  match = path.match(/^\/api\/projects\/([^/]+)\/cards\/trash$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { cardIds?: unknown };
    const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map(String) : [];
    json(response, 201, trashCards(services.store, decodeURIComponent(match[1]), cardIds));
    return;
  }
  match = path.match(/^\/api\/projects\/([^/]+)\/cards\/restore$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { cardIds?: unknown };
    const cardIds = Array.isArray(body.cardIds) ? body.cardIds.map(String) : [];
    json(response, 201, restoreCards(services.store, decodeURIComponent(match[1]), cardIds));
    return;
  }

  match = path.match(/^\/api\/cards\/([^/]+)$/u);
  if (match && method === "PUT") {
    const body = await readJson(request);
    json(response, 200, renameCard(
      services.store,
      decodeURIComponent(match[1]),
      String(body.title || ""),
    ));
    return;
  }
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
  match = path.match(/^\/api\/cards\/([^/]+)\/concept-previews$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 202, await services.engine.startConceptPreview(
      decodeURIComponent(match[1]),
      body as { sourceRunId?: string; conceptId?: string },
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
      if (!verdict && !result.runId) {
        result.runId = await services.engine.startRun(
          result.cardId,
          String((body as { question?: unknown }).question || ""),
        );
      }
    }
    json(response, 202, verdict ? { ...result, verdict } : result);
    return;
  }

  match = path.match(/^\/api\/projects\/([^/]+)\/verdicts$/u);
  if (match && method === "GET") {
    json(response, 200, await listVerdicts(services.store, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/verdicts\/([^/]+)\/confirm$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, await confirmVerdict(
      services.store,
      services.engine,
      decodeURIComponent(match[1]),
      typeof body.text === "string" ? body.text : undefined,
    ));
    return;
  }
  match = path.match(/^\/api\/verdicts\/([^/]+)\/abandon$/u);
  if (match && method === "POST") {
    json(response, 200, await abandonTombstone(
      services.store,
      services.engine,
      decodeURIComponent(match[1]),
    ));
    return;
  }
  match = path.match(/^\/api\/verdicts\/([^/]+)\/supersede$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, await supersedeVerdict(
      services.store,
      decodeURIComponent(match[1]),
      String(body.text || ""),
      typeof body.handle === "string" ? body.handle : undefined,
    ));
    return;
  }
  match = path.match(/^\/api\/runs\/([^/]+)\/adopt$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 201, await adoptRun(
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

  // ---- Paperweight（镇纸）P0 API：route 层负责事件上报，pw 模块零改动 ----
  if (path === "/api/pw/bets" && method === "POST") {
    const body = await readJson(request);
    const bet = createPwBet(services.store.db, body as Parameters<typeof createPwBet>[1]);
    emitPwEvent(services.store.db, "create", bet.id, { title: bet.title, status: bet.status });
    json(response, 201, bet);
    return;
  }
  if (path === "/api/pw/bets" && method === "GET") {
    const status = url.searchParams.get("status");
    json(response, 200, {
      bets: listPwBets(services.store.db, status ? { status: status as "pending" } : {}),
    });
    return;
  }
  if (path === "/api/pw/bets/due" && method === "GET") {
    const asOf = url.searchParams.get("asOf") || new Date().toISOString().slice(0, 10);
    json(response, 200, { bets: listDuePwBets(services.store.db, asOf) });
    return;
  }
  // 简报 21 · 任务二/三：精确路径必须先于 :id 正则判定
  if (path === "/api/pw/bets/ledger" && method === "GET") {
    json(response, 200, getPwBetLedger(services.store.db));
    return;
  }
  if (path === "/api/pw/health-accounts" && method === "GET") {
    json(response, 200, getPwHealthAccounts(services.store.db));
    return;
  }
  // 简报 23 · 先例处置落账（overridden 无 reason → 400；promotionId 若给必须已存在）
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/precedents\/dispose$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    const dispositions = asBadRequest(() => disposePwPrecedents(
      services.store.db,
      decodeURIComponent(match[1]),
      body.dispositions as Parameters<typeof disposePwPrecedents>[2],
    ));
    json(response, 200, { dispositions });
    return;
  }
  // 简报 23 · 相关先例召回（按适用匹配，不按新近度；无相关返回空数组）
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/precedents$/u);
  if (match && method === "GET") {
    json(response, 200, { items: listPwBetPrecedents(services.store.db, decodeURIComponent(match[1])) });
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)$/u);
  if (match && method === "GET") {
    const bet = getPwBet(services.store.db, decodeURIComponent(match[1]));
    if (!bet) throw httpError(404, "押注不存在");
    json(response, 200, bet);
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/context$/u);
  if (match && method === "GET") {
    json(response, 200, assembleJudgmentContext(services.store.db, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/timeline$/u);
  if (match && method === "GET") {
    json(response, 200, {
      events: getPwBetTimeline(services.store.db, decodeURIComponent(match[1])),
    });
    return;
  }
  // 简报 21 · 任务一：激活前数据就绪闸门（preflight 只读幂等；activate 强制闸门）
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/activate\/preflight$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    const options = typeof body.edits === "object" && body.edits !== null
      ? { edits: body.edits as Parameters<typeof activatePwBet>[2] }
      : {};
    json(response, 200, asBadRequest(() => preflightPwBetActivation(
      services.store.db,
      decodeURIComponent(match[1]),
      options,
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/activate$/u);
  if (match && method === "POST") {
    const betId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const edits = typeof body.edits === "object" && body.edits !== null
      ? body.edits as Parameters<typeof activatePwBet>[2]
      : {};
    const result = asBadRequest(() => activatePwBet(services.store.db, betId, edits));
    emitPwEvent(services.store.db, "confirm", betId, { draftHash: result.bet.draft_hash });
    json(response, 200, result);
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/artifacts$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    const artifact = attachPwArtifact(services.store.db, {
      ...(body as Record<string, unknown>),
      betId: decodeURIComponent(match[1]),
    } as Parameters<typeof attachPwArtifact>[1]);
    emitPwEvent(services.store.db, "attach", artifact.bet_id, {
      artifactId: artifact.id,
      type: artifact.type,
      platform: artifact.platform,
    }, [artifact.id]);
    json(response, 201, artifact);
    return;
  }
  if (match && method === "GET") {
    const includeDetached = url.searchParams.get("includeDetached") === "1";
    json(response, 200, {
      artifacts: listPwArtifacts(services.store.db, decodeURIComponent(match[1]), {
        includeDetached,
      }),
    });
    return;
  }
  match = path.match(/^\/api\/pw\/artifacts\/([^/]+)\/detach$/u);
  if (match && method === "POST") {
    const artifact = detachPwArtifact(services.store.db, decodeURIComponent(match[1]));
    emitPwEvent(services.store.db, "attach", artifact.bet_id, {
      artifactId: artifact.id,
      detached: true,
    }, [artifact.id]);
    json(response, 200, artifact);
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/data-docs$/u);
  if (match && method === "POST") {
    const betId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const doc = asBadRequest(() => createPwDataDoc(services.store.db, {
      ...(body as Record<string, unknown>),
      betId,
    } as Parameters<typeof createPwDataDoc>[1]));
    emitPwEvent(services.store.db, "data_doc", betId, {
      docId: doc.id,
      platform: doc.platform,
      method: doc.method,
    }, [doc.id]);
    // TASK-PW-18：人工录入到达收口（按行 UUID 通知筛子）
    services.sieve.notifyArrival("manual_entry", [doc.id]);
    json(response, 201, doc);
    return;
  }
  if (match && method === "GET") {
    json(response, 200, {
      docs: listPwDataDocs(services.store.db, decodeURIComponent(match[1])),
    });
    return;
  }
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/settle$/u);
  if (match && method === "POST") {
    const betId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const verdict = asBadRequest(() => settlePwBet(
      services.store.db,
      betId,
      body as Parameters<typeof settlePwBet>[2],
    ));
    emitPwEvent(services.store.db, "settle", betId, {
      outcome: verdict.outcome,
      verdictId: verdict.id,
    }, [verdict.id]);
    json(response, 201, verdict);
    return;
  }
  if (path === "/api/pw/verdicts" && method === "GET") {
    const outcome = url.searchParams.get("outcome");
    json(response, 200, {
      verdicts: asBadRequest(() => listPwVerdicts(
        services.store.db,
        outcome ? { outcome: outcome as "gold" } : {},
      )),
    });
    return;
  }
  if (path === "/api/pw/verdicts/search" && method === "GET") {
    json(response, 200, {
      verdicts: searchPwVerdicts(services.store.db, url.searchParams.get("q") || ""),
    });
    return;
  }
  if (path === "/api/pw/verdicts/tombstone-stats" && method === "GET") {
    json(response, 200, { causes: tombstoneCauseStats(services.store.db) });
    return;
  }
  // 简报 23 · 判决晋级（decided_by=human 写死；同 verdict 已有 active → 旧的置 superseded 接链）
  match = path.match(/^\/api\/pw\/verdicts\/([^/]+)\/promote$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    const promotion = asBadRequest(() => promotePwVerdict(
      services.store.db,
      decodeURIComponent(match[1]),
      body as Parameters<typeof promotePwVerdict>[2],
    ));
    json(response, 201, promotion);
    return;
  }
  // 简报 23 · 当前 active 晋级（或 null）
  match = path.match(/^\/api\/pw\/verdicts\/([^/]+)\/promotion$/u);
  if (match && method === "GET") {
    json(response, 200, asBadRequest(() => getPwVerdictPromotion(
      services.store.db,
      decodeURIComponent(match[1]),
    )));
    return;
  }
  // 简报 23 · 曝光流水（审计：该判决被注入过哪些上下文；verdictId 必填）
  if (path === "/api/pw/verdicts/exposures" && method === "GET") {
    const verdictId = url.searchParams.get("verdictId");
    if (!verdictId) throw httpError(400, "verdictId 必填");
    json(response, 200, { exposures: listPwVerdictExposures(services.store.db, verdictId) });
    return;
  }
  if (path === "/api/pw/gold-sync/mirror" && method === "POST") {
    json(response, 200, mirrorConfirmedGolds(services.store.db));
    return;
  }
  if (path === "/api/pw/golds" && method === "GET") {
    const keyword = url.searchParams.get("keyword") || undefined;
    json(response, 200, {
      golds: listMirroredGolds(services.store.db, keyword ? { keyword } : {}),
    });
    return;
  }
  if (path === "/api/pw/voice" && method === "POST") {
    const body = await readJson(request);
    const item = asBadRequest(() => addPwVoiceItem(
      services.store.db,
      body as Parameters<typeof addPwVoiceItem>[1],
    ));
    // TASK-PW-18：观众声音到达收口（按行 UUID 通知筛子）
    services.sieve.notifyArrival("voice", [item.id]);
    json(response, 201, item);
    return;
  }
  if (path === "/api/pw/voice" && method === "GET") {
    const signalType = url.searchParams.get("signalType");
    const unprocessed = url.searchParams.get("unprocessed") === "1";
    json(response, 200, {
      items: asBadRequest(() => listPwVoiceItems(services.store.db, {
        ...(signalType ? { signalType: signalType as "noise" } : {}),
        ...(unprocessed ? { unprocessed: true } : {}),
      })),
    });
    return;
  }
  if (path === "/api/pw/voice/corpus-cards" && method === "GET") {
    const status = url.searchParams.get("status") ?? "suggested";
    json(response, 200, listPwVoiceThemeCards(services.store.db, url.searchParams.get("bvid") ?? "", status as PwVoiceCardStatus));
    return;
  }
  if (path === "/api/pw/voice/corpus-cards/aggregate" && method === "POST") {
    const body = await readJson(request);
    try {
      json(response, 200, await aggregatePwVoiceThemeCards(services.store.db, typeof body.bvid === "string" ? body.bvid : "", { dataDir: services.store.dataDir }));
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw httpError(503, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (path === "/api/pw/voice/corpus-cards/collect" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => collectPwVoiceThemeCard(services.store.db, typeof body.cardId === "string" ? body.cardId : "")));
    return;
  }
  if (path === "/api/pw/voice/corpus-cards/reject" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => rejectPwVoiceThemeCard(services.store.db, typeof body.cardId === "string" ? body.cardId : "")));
    return;
  }
  if (path === "/api/pw/voice/classify" && method === "POST") {
    const body = await readJson(request) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    json(response, 200, {
      items: await classifyPwVoiceItems(services.store.db, ids, pwVoiceLlm),
    });
    return;
  }
  match = path.match(/^\/api\/pw\/voice\/([^/]+)\/drop$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => dropPwVoiceItem(
      services.store.db,
      decodeURIComponent(match[1]),
      String(body.reason || ""),
    )));
    return;
  }
  // ---- TASK-PW-45：声音提请候选卡（提升链，human 账经 promotePwVoiceToCard）----
  match = path.match(/^\/api\/pw\/voice\/([^/]+)\/promote$/u);
  if (match && method === "POST") {
    json(response, 200, asBadRequest(() => promotePwVoiceToCard(
      services.store.db,
      decodeURIComponent(match[1]),
    )));
    return;
  }
  // ---- TASK-PW-46：语料评论只读展出 + 一键收录（双通路）----
  if (path === "/api/pw/voice/corpus-comments" && method === "GET") {
    const bvid = url.searchParams.get("bvid") ?? "";
    const offsetRaw = url.searchParams.get("offset");
    const limitRaw = url.searchParams.get("limit");
    json(response, 200, asBadRequest(() => {
      const doc = getPwCorpusDoc(services.store.db, bvid);
      return {
        meta: { bvid: doc.bvid, title: doc.title, up_name: doc.up_name },
        comments: listPwVoiceCorpusComments(services.store.db, bvid, {
          ...(offsetRaw !== null ? { offset: Number(offsetRaw) } : {}),
          ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
        }),
      };
    }));
    return;
  }
  if (path === "/api/pw/voice/collect" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, asBadRequest(() => collectPwCorpusComment(
      services.store.db,
      { bvid: String(body.bvid ?? ""), rpid: Number(body.rpid) },
    )));
    return;
  }
  // ---- TASK-PW-65：评论筛子判决落库 + 查询（导入对账不过 400 + missing/extra/dup 详情，不落库）----
  if (path === "/api/pw/voice/sieve-runs" && method === "GET") {
    json(response, 200, {
      runs: listPwVoiceSieveRuns(services.store.db, url.searchParams.get("bvid") ?? ""),
    });
    return;
  }
  if (path === "/api/pw/voice/sieve-runs/import" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, asBadRequest(() => importPwVoiceSieveRun(
      services.store.db,
      body as Parameters<typeof importPwVoiceSieveRun>[1],
      { dataDir: services.store.dataDir },
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/voice\/sieve-runs\/([^/]+)$/u);
  if (match && method === "GET") {
    json(response, 200, getPwVoiceSieveRun(services.store.db, decodeURIComponent(match[1])));
    return;
  }
  // TASK-PW-71：筛子多版本交叉检出矩阵（纯只读聚合，query 取 bvid）
  if (path === "/api/pw/voice/sieve-matrix" && method === "GET") {
    json(response, 200, getPwVoiceSieveMatrix(services.store.db, url.searchParams.get("bvid") ?? ""));
    return;
  }
  // ---- TASK-PW-66：评论筛子·跨视频桶聚合（赛道轴）----
  if (path === "/api/pw/voice/sieve-tracks" && method === "GET") {
    json(response, 200, { tracks: listPwVoiceTracks(services.store.db) });
    return;
  }
  if (path === "/api/pw/voice/sieve-tracks" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, asBadRequest(() => createPwVoiceTrack(
      services.store.db,
      body.name as Parameters<typeof createPwVoiceTrack>[1],
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/voice\/sieve-tracks\/([^/]+)\/videos$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => addPwVoiceTrackVideo(
      services.store.db,
      decodeURIComponent(match[1]),
      body.bvid as Parameters<typeof addPwVoiceTrackVideo>[2],
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/voice\/sieve-tracks\/([^/]+)\/videos\/([^/]+)$/u);
  if (match && method === "DELETE") {
    json(response, 200, asBadRequest(() => removePwVoiceTrackVideo(
      services.store.db,
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/voice\/sieve-tracks\/([^/]+)\/aggregate$/u);
  if (match && method === "GET") {
    json(response, 200, aggregatePwVoiceTrack(services.store.db, decodeURIComponent(match[1])));
    return;
  }
  // ---- TASK-PW-18：筛子 run（打开兜底/手动触发 + 状态查询）----
  if (path === "/api/pw/sieve/status" && method === "GET") {
    json(response, 200, sieveStatus(services.store.db, services.sieve));
    return;
  }
  // TASK-PW-51：方向成绩单（只读聚合；direction NULL 归「默认」，runs 降序）
  if (path === "/api/pw/sieve/direction-stats" && method === "GET") {
    json(response, 200, { rows: getPwSieveDirectionStats(services.store.db) });
    return;
  }
  if (path === "/api/pw/sieve/run" && method === "POST") {
    // 立即触发一筛（绕过安静窗；在途时 flushNow 抛 409）
    json(response, 200, await services.sieve.flushNow());
    return;
  }
  // ---- TASK-PW-20：选题候选卡（列表/挑/否）与内容押注卡 ----
  if (path === "/api/pw/sieve/cards" && method === "GET") {
    const status = url.searchParams.get("status");
    json(response, 200, {
      cards: listPwSieveCardsByStatus(
        services.store.db,
        status === null ? undefined : (status as "pending" | "picked" | "edited" | "rejected"),
      ),
    });
    return;
  }
  match = path.match(/^\/api\/pw\/sieve\/cards\/([^/]+)\/pick$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { overrides?: ContentBetOverrides };
    const bet = asBadRequest(() => pickPwSieveCard(
      services.store.db,
      decodeURIComponent(match[1]),
      body.overrides ?? {},
    ));
    // TASK-PW-33：押注成立自动起草（fire-and-forget，不阻塞响应；失败兜底留痕）
    void maybeAutoFirePwDraft(services.store.db, bet.id, { trigger: "pick_sieve_card" });
    json(response, 201, bet);
    return;
  }
  match = path.match(/^\/api\/pw\/sieve\/cards\/([^/]+)\/reject$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { reason?: string };
    json(response, 200, asBadRequest(() => {
      rejectPwSieveCard(services.store.db, decodeURIComponent(match[1]), body.reason);
      return { ok: true };
    }));
    return;
  }
  // ---- TASK-PW-42：方向输入（人定捞取取向；UI 通路落 human 事件，与工具共用内部函数）----
  if (path === "/api/pw/sieve/direction" && method === "PUT") {
    const body = await readJson(request) as { direction?: unknown };
    const direction = normalizePwDirection(body.direction);
    setSieveDirection(services.store.db, direction);
    emitPwEvent(services.store.db, "edit", null, { direction });
    json(response, 200, { direction });
    return;
  }
  if (path === "/api/pw/sieve/reject-all" && method === "POST") {
    const body = await readJson(request) as { reason?: unknown; direction?: unknown; resieveAll?: unknown };
    // 留空 = 原方向重筛：仅非空 direction 才换向；rejectAll 内部自落一条 human reject 账
    const direction = typeof body.direction === "string" && body.direction.trim()
      ? body.direction.trim()
      : undefined;
    if (direction !== undefined) {
      setSieveDirection(services.store.db, direction);
      emitPwEvent(services.store.db, "edit", null, { direction });
    }
    const cardIds = rejectAllPendingPwSieveCards(
      services.store.db,
      typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined,
    );
    // TASK-PW-48：resieveAll=true 时全否后把现有语料也按新方向重过一遍（直通主管线，绕过 notifier 去重）；
    // 缺省仍走 flushNow（行为与现状逐字一致）
    const resieveAll = body.resieveAll === true;
    const result = resieveAll
      ? await resieveAllPwSieve(services.store.db)
      : await services.sieve.flushNow();
    json(response, 200, {
      rejected: cardIds.length,
      runId: result.runId,
      direction: direction ?? null,
      ...(resieveAll ? { note: "老料重筛可能把挑过的评论再筛出来，候选卡是草稿，人否掉即可。" } : {}),
    });
    return;
  }
  if (path === "/api/pw/content-bets" && method === "GET") {
    // TASK-PW-36：附草案计数（rail 📝×N 角标语义 = draft 态份数）
    const bets = listContentBets(services.store.db).map((bet) => ({
      ...bet,
      draft_count: countPwContentDraftsByBet(services.store.db, bet.id).draft,
    }));
    json(response, 200, { bets });
    return;
  }
  // TASK-PW-36：弹药架（只摆实际引用过的金子/墓碑；latest_marker 供 §N 角标显示）
  if (path === "/api/pw/ammo-shelf" && method === "GET") {
    const shelf = listPwAmmoShelf(services.store.db).map((row) => {
      const log = listPwVerdictRefLog(services.store.db, row.verdict_id);
      return { ...row, latest_marker: log.length > 0 ? log[log.length - 1].marker : null };
    });
    json(response, 200, { shelf });
    return;
  }
  // TASK-PW-36：弹药引用记录（点开：何时/哪条消息/哪份草案）
  match = path.match(/^\/api\/pw\/ammo-shelf\/([^/]+)\/refs$/u);
  if (match && method === "GET") {
    const refs = listPwVerdictRefLog(services.store.db, decodeURIComponent(match[1])).map((ref) => ({
      ...ref,
      source_label: ammoRefLabel(services.store.db, ref.source_kind, ref.source_id),
    }));
    json(response, 200, { refs });
    return;
  }
  // TASK-PW-36：多源可视化（来源对比 + 产出榜；range=7|30，PW-34 口径）
  if (path === "/api/pw/source-stats" && method === "GET") {
    const rangeDays = url.searchParams.get("range") === "30" ? 30 : 7;
    json(response, 200, {
      comparison: getPwSourceComparison(services.store.db, { rangeDays }),
      ranking: getPwOutputRanking(services.store.db, { rangeDays }),
    });
    return;
  }
  // TASK-PW-36：收工小结（结构化 + 导出文本，PW-35 口径）
  if (path === "/api/pw/day-summary" && method === "GET") {
    const date = url.searchParams.get("date");
    const summary = asBadRequest(() => getPwDaySummary(services.store.db, date ? { date } : {}));
    json(response, 200, { summary, text: renderPwDaySummaryText(summary) });
    return;
  }
  // TASK-PW-41：笔记屏（Memos 库只读六 GET 路由；PW-39/40 读函数；"连不上"一律 503 如实报，不加写路由）
  if (path === "/api/pw/notes/status" && method === "GET") {
    json(response, 200, getPwNotesStatus());
    return;
  }
  if (path === "/api/pw/notes/search" && method === "GET") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    json(response, 200, { notes: q ? asNotesUnavailable(() => searchPwNotes(q)) : [] });
    return;
  }
  if (path === "/api/pw/notes/stats" && method === "GET") {
    const daysRaw = url.searchParams.get("days");
    const days = daysRaw === null ? undefined : Number(daysRaw);
    if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
      throw httpError(400, "days 必须是正整数");
    }
    json(response, 200, { days: asNotesUnavailable(() => getPwNotesDailyStats(days === undefined ? {} : { days })) });
    return;
  }
  if (path === "/api/pw/notes/tags" && method === "GET") {
    json(response, 200, { tags: asNotesUnavailable(() => getPwNotesTagCounts()) });
    return;
  }
  if (path === "/api/pw/notes/recall" && method === "GET") {
    const betId = url.searchParams.get("betId");
    if (!betId) throw httpError(400, "betId 必填");
    const bet = getPwBet(services.store.db, betId);
    if (!bet) throw httpError(404, "押注不存在");
    // 只读捞取不校验 kind/status：词照抽，非内容押注也照捞（规格如此）
    json(response, 200, { recall: asNotesUnavailable(() => recallPwNotesForBet(bet)) });
    return;
  }
  // ---- TASK-PW-12：笔记召回事件账本（纯只读统计；写只发生在四个出口打点）----
  if (path === "/api/pw/recall-events/summary" && method === "GET") {
    json(response, 200, getPwRecallEventsSummary(services.store.db, url.searchParams.get("days")));
    return;
  }
  if (path === "/api/pw/recall-events" && method === "GET") {
    json(response, 200, listPwRecallEvents(
      services.store.db,
      url.searchParams.get("limit") ?? "100",
      url.searchParams.get("offset") ?? "0",
    ));
    return;
  }
  // ---- TASK-PW-14：协作台模式与对账条（纯只读聚合）----
  if (path === "/api/pw/mode-bar" && method === "GET") {
    json(response, 200, getPwModeBar(services.store.db));
    return;
  }
  // ---- TASK-PW-16：提案契约 + 状态机（review/apply 只供人触发；agent 调用即违反 GUARDRAILS.md）----
  if (path === "/api/pw/proposals" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, createPwProposal(services.store.db, body as Parameters<typeof createPwProposal>[1]));
    return;
  }
  if (path === "/api/pw/proposals" && method === "GET") {
    json(response, 200, listPwProposals(services.store.db, {
      lane: url.searchParams.get("lane") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? "50",
      offset: url.searchParams.get("offset") ?? "0",
    }));
    return;
  }
  match = path.match(/^\/api\/pw\/proposals\/([^/]+)\/review$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, reviewPwProposal(
      services.store.db,
      decodeURIComponent(match[1]),
      body as Parameters<typeof reviewPwProposal>[1],
    ));
    return;
  }
  match = path.match(/^\/api\/pw\/proposals\/([^/]+)\/apply$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, applyPwProposal(
      services.store.db,
      decodeURIComponent(match[1]),
      body as Parameters<typeof applyPwProposal>[1],
    ));
    return;
  }
  match = path.match(/^\/api\/pw\/proposals\/([^/]+)$/u);
  if (match && method === "GET") {
    json(response, 200, getPwProposal(services.store.db, decodeURIComponent(match[1])));
    return;
  }
  if (path === "/api/pw/notes" && method === "GET") {
    const limitRaw = url.searchParams.get("limit");
    const offsetRaw = url.searchParams.get("offset");
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const offset = offsetRaw === null ? undefined : Number(offsetRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw httpError(400, "limit 必须是正整数");
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      throw httpError(400, "offset 必须是 ≥0 的整数");
    }
    json(response, 200, { notes: asNotesUnavailable(() => readPwNotesList({ limit, offset })) });
    return;
  }
  // TASK-PW-61：捞料候选、确认/弃、大盘与单条身价流水。
  if (path === "/api/pw/miner/run" && method === "POST") {
    try {
      const run = await runPwMiner(services.store.db, {
        triggerKind: "manual",
        dataDir: services.store.dataDir,
      });
      snapshotPwNoteValues(services.store.db);
      json(response, 200, run);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw httpError(503, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (path === "/api/pw/miner/candidates" && method === "GET") {
    const raw = url.searchParams.get("status") ?? "suggested";
    if (raw !== "suggested" && raw !== "confirmed" && raw !== "rejected") {
      throw httpError(400, "status 非法");
    }
    json(response, 200, listPwMinerCandidates(services.store.db, raw as PwMinerStatus));
    return;
  }
  if (path === "/api/pw/miner/cards" && method === "GET") {
    const raw = url.searchParams.get("status") ?? "suggested";
    if (!["suggested", "confirmed", "rejected", "direction_seed"].includes(raw)) throw httpError(400, "status 非法");
    json(response, 200, listPwMinerCards(services.store.db, raw as PwMinerCardStatus));
    return;
  }
  if (path === "/api/pw/miner/cards/confirm" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => confirmPwMinerCard(services.store.db, {
      cardId: typeof body.cardId === "string" ? body.cardId : "",
      betId: typeof body.betId === "string" ? body.betId : "",
      role: body.role as Parameters<typeof confirmPwMinerCard>[1]["role"],
    })));
    return;
  }
  if (path === "/api/pw/miner/cards/reject" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => rejectPwMinerCard(services.store.db, typeof body.cardId === "string" ? body.cardId : "")));
    return;
  }
  if (path === "/api/pw/miner/cards/seed" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => seedPwMinerCard(services.store.db, typeof body.cardId === "string" ? body.cardId : "")));
    return;
  }
  if (path === "/api/pw/miner/candidates/confirm" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => confirmPwMinerCandidate(services.store.db, {
      id: typeof body.id === "string" ? body.id : "",
      betId: typeof body.betId === "string" ? body.betId : "",
      role: body.role as Parameters<typeof confirmPwMinerCandidate>[1]["role"],
    })));
    return;
  }
  if (path === "/api/pw/miner/candidates/reject" && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => rejectPwMinerCandidate(
      services.store.db,
      typeof body.id === "string" ? body.id : "",
    )));
    return;
  }
  if (path === "/api/pw/notes/board" && method === "GET") {
    json(response, 200, asNotesUnavailable(() => getPwNoteBoard(services.store.db)));
    return;
  }
  if (path === "/api/pw/notes/journey" && method === "GET") {
    json(response, 200, asBadRequest(() => getPwNoteJourney(
      services.store.db,
      url.searchParams.get("uid") ?? "",
    )));
    return;
  }
  // TASK-PW-60：笔记树（AI 只 suggested；attach 才能 confirmed）。
  if (path === "/api/pw/notes/tree" && method === "GET") {
    json(response, 200, asNotesUnavailable(() => buildPwNoteTree(services.store.db)));
    return;
  }
  if (path === "/api/pw/notes/tree/attach" && method === "POST") {
    const body = await readJson(request);
    const noteUid = typeof body.noteUid === "string" ? body.noteUid : "";
    if (body.betId !== null && body.betId !== undefined && typeof body.betId !== "string") {
      throw httpError(400, "betId 必须是字符串或 null");
    }
    const betId = typeof body.betId === "string" ? body.betId : null;
    asBadRequest(() => confirmPwNoteAttach(services.store.db, noteUid, betId));
    json(response, 200, { ok: true });
    return;
  }
  if (path === "/api/pw/notes/tree/keyword" && method === "POST") {
    const body = await readJson(request);
    asBadRequest(() => setPwNoteKeyword(
      services.store.db,
      typeof body.noteUid === "string" ? body.noteUid : "",
      typeof body.keyword === "string" ? body.keyword : "",
    ));
    json(response, 200, { ok: true });
    return;
  }
  if (path === "/api/pw/notes/tree/tick" && method === "POST") {
    try {
      json(response, 200, await runPwNoteTreeTick(services.store.db));
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw httpError(503, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  // TASK-PW-53：笔记洞察（正式表 pw_note_insights；POST 跑洞察写报告，GET 翻历史；错误口径见规格表）
  if (path === "/api/pw/notes/insight" && method === "POST") {
    const body = await readJson(request);
    const betId = typeof body.betId === "string" ? body.betId.trim() : "";
    if (!betId) throw httpError(400, "betId 必填");
    // runPwNoteInsight 自带的 404/400/502 带 status 原样透传；其余普通 Error
    // （笔记库连不上 / 模型未配置）→ 503（照 asNotesUnavailable 口径）
    let insight: PwNoteInsightRow;
    try {
      insight = await runPwNoteInsight(services.store.db, betId);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw httpError(503, error instanceof Error ? error.message : String(error));
    }
    json(response, 200, { insight: publicPwNoteInsight(insight) });
    return;
  }
  if (path === "/api/pw/notes/insight" && method === "GET") {
    const betId = url.searchParams.get("betId")?.trim() ?? "";
    if (!betId) throw httpError(400, "betId 必填");
    json(response, 200, {
      insights: listPwNoteInsights(services.store.db, betId).map(publicPwNoteInsight),
    });
    return;
  }
  // TASK-PW-58：笔记自动卷积（常驻巡检自动出草稿，人只审；GET 翻列表，POST tick 手动触发一轮）
  if (path === "/api/pw/notes/rollups" && method === "GET") {
    const kindRaw = url.searchParams.get("kind");
    const kind = kindRaw === null
      ? undefined
      : kindRaw === "day" || kindRaw === "week" || kindRaw === "month"
        ? kindRaw
        : null;
    if (kind === null) throw httpError(400, "kind 只能是 day|week|month");
    json(response, 200, {
      rollups: listPwNoteRollups(services.store.db, kind ? { kind } : {}).map(publicPwNoteRollup),
    });
    return;
  }
  if (path === "/api/pw/notes/rollups/tick" && method === "POST") {
    // 笔记库连不上等无 status 错误 → 503 如实报（照 asNotesUnavailable 口径）
    let generated: number;
    try {
      generated = await runPwNoteRollupTick(services.store.db);
    } catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw httpError(503, error instanceof Error ? error.message : String(error));
    }
    json(response, 200, { generated });
    return;
  }
  // ---- TASK-PW-55：回流自动记账 + 大盘读端点（activity-daily 读账本，见 pw-runs.ts）----
  if (path === "/api/pw/activity-daily" && method === "GET") {
    const daysRaw = url.searchParams.get("days");
    const days = daysRaw === null ? undefined : Number(daysRaw);
    json(response, 200, asBadRequest(() => getPwActivityDaily(services.store.db, { days })));
    return;
  }
  // TASK-PW-36：押注下素材草案（草案区；status 可选过滤）
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/drafts$/u);
  if (match && method === "GET") {
    const status = url.searchParams.get("status");
    json(response, 200, {
      drafts: listPwContentDraftsByBet(
        services.store.db,
        decodeURIComponent(match[1]),
        status === null ? {} : { status: status as "draft" | "finalized" | "rejected" },
      ),
    });
    return;
  }
  // TASK-PW-36：定稿（产出物挂载走 PW-33 事务内通路，押注继续在途）
  match = path.match(/^\/api\/pw\/content-drafts\/([^/]+)\/finalize$/u);
  if (match && method === "POST") {
    const draft = asBadRequest(() => finalizePwContentDraft(services.store.db, decodeURIComponent(match[1])));
    json(response, 200, { draft, artifacts: listPwArtifacts(services.store.db, draft.bet_id) });
    return;
  }
  // TASK-PW-36：否掉草案（进 bad case 集，回流跑分用）
  match = path.match(/^\/api\/pw\/content-drafts\/([^/]+)\/reject$/u);
  if (match && method === "POST") {
    const body = await readJson(request) as { reason?: string };
    json(response, 200, {
      draft: asBadRequest(() => rejectPwContentDraft(services.store.db, decodeURIComponent(match[1]), body.reason)),
    });
    return;
  }
  // TASK-PW-36：换一批（手动再起草；fire-and-forget 不阻塞；留痕由管线自记 trigger=manual_regen）
  match = path.match(/^\/api\/pw\/bets\/([^/]+)\/draft-run$/u);
  if (match && method === "POST") {
    const betId = decodeURIComponent(match[1]);
    void runPwDraftPipeline(services.store.db, betId, { trigger: "manual_regen" }).catch((error: unknown) => {
      console.warn(`manual_regen 起草失败：${error instanceof Error ? error.message : String(error)}`);
    });
    json(response, 202, { ok: true });
    return;
  }
  if (path === "/api/pw/drafts" && method === "POST") {
    const body = await readJson(request) as { source?: unknown };
    const draft = createPwBetDraft(
      services.store.db,
      body as Parameters<typeof createPwBetDraft>[1],
      String(body.source || "manual"),
    );
    emitPwEvent(services.store.db, "draft", draft.id, {
      title: draft.title,
      source: draft.created_from,
    });
    json(response, 201, draft);
    return;
  }
  if (path === "/api/pw/drafts" && method === "GET") {
    json(response, 200, { drafts: listPwBetDrafts(services.store.db) });
    return;
  }
  match = path.match(/^\/api\/pw\/drafts\/([^/]+)\/confirm$/u);
  if (match && method === "POST") {
    const draftId = decodeURIComponent(match[1]);
    const body = await readJson(request) as { edits?: Record<string, unknown> };
    const bet = asBadRequest(() => confirmPwBetDraft(
      services.store.db,
      draftId,
      (body.edits ?? body) as Parameters<typeof confirmPwBetDraft>[2],
    ));
    // TASK-PW-33：押注成立自动起草（fire-and-forget，不阻塞响应；仅 content 押注会真发动）
    void maybeAutoFirePwDraft(services.store.db, bet.id, { trigger: "confirm_bet_draft" });
    emitPwEvent(services.store.db, "confirm", draftId, {
      draftHash: bet.draft_hash,
    });
    json(response, 200, bet);
    return;
  }
  match = path.match(/^\/api\/pw\/drafts\/([^/]+)\/reject$/u);
  if (match && method === "POST") {
    const draftId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const rejected = asBadRequest(() => rejectPwBetDraft(
      services.store.db,
      draftId,
      String(body.reason || ""),
    ));
    emitPwEvent(services.store.db, "reject", draftId, {
      draftHash: rejected.draft_hash,
      reason: rejected.reason,
    });
    json(response, 200, rejected);
    return;
  }

  // ---- TASK-PW-13：平台连接与 B站低频同步 ----
  if (path === "/api/pw/connections" && method === "GET") {
    json(response, 200, { connections: listPwConnections(services.store.db) });
    return;
  }
  if (path === "/api/pw/connections" && method === "POST") {
    const body = await readJson(request);
    json(response, 201, asBadRequest(() => registerPwConnection(services.store.db, body)));
    return;
  }
  match = path.match(/^\/api\/pw\/connections\/([^/]+)\/status$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => setPwConnectionStatus(
      services.store.db,
      decodeURIComponent(match[1]),
      body.status,
      body.reason,
    )));
    return;
  }
  if (path === "/api/pw/sync/bilibili" && method === "POST") {
    const body = await readJson(request) as { items?: unknown };
    const result = asBadRequest(() => syncPwBilibili(services.store.db, body.items ?? []));
    // TASK-PW-18：同步到达收口——created=0 是心跳不算到达，不通知
    if (result.created > 0) services.sieve.notifyArrival("sync", result.createdIds);
    json(response, 200, result);
    return;
  }
  if (path === "/api/pw/data-docs" && method === "GET") {
    json(response, 200, { docs: listAllPwDataDocs(services.store.db) });
    return;
  }

  // ---- TASK-PW-14：定向语料通路（授权队列 + 评论 FTS）----
  // 精确路径（/pending、/search）必须先于 :id 动作路由判定
  if (path === "/api/pw/corpus" && method === "POST") {
    const body = await readJson(request);
    const result = asBadRequest(() => authorizePwCorpus(services.store.db, body));
    json(response, result.existed ? 200 : 201, { ...result.doc, existed: result.existed });
    return;
  }
  if (path === "/api/pw/corpus" && method === "GET") {
    json(response, 200, { items: listPwCorpus(services.store.db) });
    return;
  }
  if (path === "/api/pw/corpus/pending" && method === "GET") {
    json(response, 200, { items: listPwCorpusPending(services.store.db) });
    return;
  }
  if (path === "/api/pw/corpus/search" && method === "GET") {
    json(response, 200, { hits: searchPwCorpus(services.store.db, url.searchParams.get("q")) });
    return;
  }
  match = path.match(/^\/api\/pw\/corpus\/([^/]+)\/fetching$/u);
  if (match && method === "POST") {
    json(response, 200, asBadRequest(() => markPwCorpusFetching(
      services.store.db,
      decodeURIComponent(match[1]),
    )));
    return;
  }
  match = path.match(/^\/api\/pw\/corpus\/([^/]+)\/done$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    const doc = asBadRequest(() => donePwCorpus(
      services.store.db,
      decodeURIComponent(match[1]),
      body,
    ));
    // TASK-PW-18：语料 done 到达收口（一次 ≤3 个 done 连发靠去抖合并）
    services.sieve.notifyArrival("corpus_done", [doc.id]);
    json(response, 200, doc);
    return;
  }
  match = path.match(/^\/api\/pw\/corpus\/([^/]+)\/fail$/u);
  if (match && method === "POST") {
    const body = await readJson(request);
    json(response, 200, asBadRequest(() => failPwCorpus(
      services.store.db,
      decodeURIComponent(match[1]),
      body,
    )));
    return;
  }

  // ---- TASK-PW-15：协作台（会话流 + 待确认队列 + 人工批准）----
  // 精确路径（pending-queue / settle-drafts / corpus）必须先于 :betId/messages 判定
  if (path === "/api/pw/collab/pending-queue" && method === "GET") {
    json(response, 200, collabPendingQueue(services.store.db));
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/settle-drafts\/([^/]+)\/approve$/u);
  if (match && method === "POST") {
    const draftId = decodeURIComponent(match[1]);
    const draft = asBadRequest(() => approvePwSettleDraft(services.store.db, draftId));
    emitPwEvent(services.store.db, "confirm", draft.bet_id, {
      settleDraftId: draft.id,
      recommendation: JSON.parse(draft.advice_json).recommendation,
    }, [draft.id]);
    json(response, 200, draft);
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/settle-drafts\/([^/]+)\/reject$/u);
  if (match && method === "POST") {
    const draftId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const draft = asBadRequest(() => rejectPwSettleDraft(
      services.store.db,
      draftId,
      body.reason,
    ));
    emitPwEvent(services.store.db, "reject", draft.bet_id, {
      settleDraftId: draft.id,
      reason: draft.reject_reason,
    }, [draft.id]);
    json(response, 200, draft);
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/corpus\/([^/]+)\/approve$/u);
  if (match && method === "POST") {
    const corpusId = decodeURIComponent(match[1]);
    const doc = asBadRequest(() => approvePwCorpusProposal(services.store.db, corpusId));
    emitPwEvent(services.store.db, "confirm", null, {
      corpusId: doc.id,
      bvid: doc.bvid,
    }, [doc.id]);
    json(response, 200, doc);
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/corpus\/([^/]+)\/reject$/u);
  if (match && method === "POST") {
    const corpusId = decodeURIComponent(match[1]);
    const doc = asBadRequest(() => rejectPwCorpusProposal(services.store.db, corpusId));
    emitPwEvent(services.store.db, "reject", null, {
      corpusId: doc.id,
      bvid: doc.bvid,
    }, [doc.id]);
    json(response, 200, doc);
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/([^/]+)\/context$/u);
  if (match && method === "GET") {
    json(response, 200, buildCollabContext(services.store.db, decodeURIComponent(match[1])));
    return;
  }
  match = path.match(/^\/api\/pw\/collab\/([^/]+)\/messages$/u);
  if (match && method === "GET") {
    json(response, 200, {
      messages: listPwCollabMessages(services.store.db, decodeURIComponent(match[1])),
    });
    return;
  }
  if (match && method === "POST") {
    const betId = decodeURIComponent(match[1]);
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw httpError(400, "text 必填");
    await openCollabSse(response, request, services, betId, text);
    return;
  }

  // TASK-PW-72 批次 B：押注信号与飞书通知链路（P1）。/n/* 必须在 SPA 静态回退之前拦截。
  if (path === "/api/pw/notify/test-signal" && method === "POST") {
    const body = await readJson(request);
    const requested = typeof body.betId === "string" ? body.betId.trim() : "";
    let betId = requested;
    if (requested) {
      const bet = getPwBet(services.store.db, requested);
      if (!bet) throw httpError(404, `押注不存在：${requested}`);
    } else {
      // 押注台为空时也允许纯链路测试：合成 betId，每次一注，绕过 (bet_id,kind,bet_version) 幂等键
      betId = `manual-test:${randomUUID()}`;
    }
    const result = createBetSignal(
      services.store.db,
      { betId, kind: "MANUAL_TEST", severity: "low" },
      { now: new Date().toISOString(), baseUrl: PW_NOTIFY_BASE_URL },
    );
    json(response, result.alreadyExists ? 200 : 201, {
      alreadyExists: result.alreadyExists,
      signal: result.signal,
      testUrl: result.tokenPlaintext ? `${PW_NOTIFY_BASE_URL}/n/${result.tokenPlaintext}` : null,
    });
    return;
  }
  if (path === "/api/pw/notify/compute-due" && method === "POST") {
    const results = computeDueSignals(services.store.db, { now: new Date().toISOString() });
    json(response, 200, {
      total: results.length,
      created: results.filter((r) => !r.alreadyExists).length,
      alreadyExists: results.filter((r) => r.alreadyExists).length,
      betIds: results.map((r) => r.signal.bet_id),
    });
    return;
  }
  const notifyPageMatch = path.match(/^\/n\/([0-9a-fA-F]{32})\/?$/u);
  if (notifyPageMatch && method === "GET") {
    renderPwDispositionPage(services.store.db, notifyPageMatch[1].toLowerCase(), response);
    return;
  }
  if (method === "GET" && path.startsWith("/n/")) {
    pwNotifyHtmlPage(response, 404, "链接无效", "<p>这张证据卡不存在或已被清理。通知可能来自旧版本链路。</p>");
    return;
  }

  if (method === "GET" && !path.startsWith("/api/")) {
    await serveStatic(path, response);
    return;
  }
  throw httpError(404, "接口不存在");
}

/**
 * 协作台 SSE：直接流式输出（不建 run 回放）。headers 与心跳照 openSse，
 * 事件名见 runCollabTurn（user_saved / tool_start / tool_end / answer_delta /
 * draft_created / fetch_proposed / run_end）。
 */
async function openCollabSse(
  response: ServerResponse,
  request: IncomingMessage,
  services: Services,
  betId: string,
  text: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.socket?.setNoDelay(true);
  response.flushHeaders();
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  const cleanup = () => clearInterval(heartbeat);
  request.once("close", cleanup);
  try {
    await runCollabTurn(
      { db: services.store.db, sessions: services.sessions, sieve: services.sieve },
      betId,
      text,
      (name, payload) => {
        response.write(`event: ${name}\n`);
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    );
  } finally {
    cleanup();
    response.end();
  }
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
  response.socket?.setNoDelay(true);
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

/** Paperweight：route 层统一事件上报（pw 模块保持零改动）。 */
function emitPwEvent(
  db: DatabaseSync,
  eventType: PwEventType,
  betId: string | null,
  payload: unknown,
  relatedIds: string[] = [],
): void {
  recordPwEvent(db, {
    eventType,
    actor: "human",
    betId,
    payloadJson: JSON.stringify(payload ?? {}),
    relatedIds,
  });
}

/** TASK-PW-42：direction 请求体归一——非字符串/空白一律 null（= 清除方向）。 */
function normalizePwDirection(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

/** TASK-PW-36：弹药引用记录的来源标签（哪条消息/哪份草案）。 */
function ammoRefLabel(db: DatabaseSync, sourceKind: string, sourceId: string): string {
  if (sourceKind === "content_draft") {
    const row = db.prepare(
      "SELECT route, title_candidate FROM pw_content_drafts WHERE id = ?",
    ).get(sourceId) as { route: string; title_candidate: string } | undefined;
    return row ? `草案「${row.title_candidate}」（${row.route}）` : `草案 ${sourceId.slice(0, 8)}`;
  }
  const row = db.prepare("SELECT role, text FROM pw_collab_messages WHERE id = ?").get(sourceId) as
    | { role: string; text: string }
    | undefined;
  if (!row) return `消息 ${sourceId.slice(0, 8)}`;
  const text = row.text.length > 40 ? `${row.text.slice(0, 40)}…` : row.text;
  return `${row.role === "user" ? "你的消息" : "AI 回答"}「${text}」`;
}

/** pw 模块里的普通 Error 统一映射为 400，带 status 的错误原样透传。 */
function asBadRequest<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw httpError(400, error instanceof Error ? error.message : String(error));
  }
}

/** TASK-PW-41：笔记读函数的「连不上」（无 status 字段）一律包成 503 如实报；带 status 的原样抛。 */
function asNotesUnavailable<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw httpError(503, error instanceof Error ? error.message : String(error));
  }
}

/** 观众声音分拣的云端模型调用（与判决草稿同一 provider 模式）。 */
async function pwVoiceLlm(prompt: string): Promise<string> {
  let bundle: ReturnType<typeof createPapertableProvider>;
  try {
    bundle = createPapertableProvider();
  } catch (error) {
    throw httpError(503, `模型未配置：${error instanceof Error ? error.message : String(error)}`);
  }
  const response = await bundle.models.completeSimple(bundle.model, {
    systemPrompt: "你是评论分拣器，只输出 JSON。",
    messages: [{ role: "user", content: prompt.slice(0, 120_000), timestamp: Date.now() }],
  }, {
    maxTokens: 2000,
    timeoutMs: 30_000,
    maxRetries: 2,
    maxRetryDelayMs: 12_000,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw httpError(502, response.errorMessage || `分拣调用失败：${response.stopReason}`);
  }
  return contentText(response.content, "");
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

/* ---------- TASK-PW-72 批次 B：押注通知链路集成 ---------- */

const PW_NOTIFY_BASE_URL = (process.env.PW_NOTIFY_BASE_URL || "https://dsh.cozai.net").replace(/\/+$/u, "");
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_MSG_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";
const PW_NOTIFY_CRED_PATH = join(homedir(), ".paperweight", "feishu-notify.json");
const PW_NOTIFY_BOT_CONFIG_PATH = join(homedir(), ".zcode", "v2", "bot-config.json");

const PW_NOTIFY_KIND_LABEL: Record<string, string> = {
  SETTLEMENT_NEAR: "结账日临近",
  USER_TIMER_DUE: "用户计时到期",
  EVIDENCE_CHANGED: "证据变化",
  STALE_LOCAL: "本地过期",
  MANUAL_TEST: "测试信号",
};

type PwNotifyCredentials = { appId: string; appSecret: string; openId: string };

/**
 * 飞书 sender：凭证只在这个闭包里读（~/.paperweight/feishu-notify.json + ZCode bot-config 的 open_id）。
 * 凭证缺失时停摆并只 warn 一次（outbox 积压等退避），不拖垮服务其余部分；tick 单飞不重入。
 */
function createPwNotifySender(db: DatabaseSync) {
  let credentials: PwNotifyCredentials | null | undefined;
  let cachedToken: { value: string; expiresAtMs: number } | null = null;
  let warned = false;
  let running = false;

  const loadCredentials = async (): Promise<PwNotifyCredentials | null> => {
    if (credentials !== undefined) return credentials;
    try {
      const cred = JSON.parse(await readFile(PW_NOTIFY_CRED_PATH, "utf8")) as {
        app_id?: string;
        app_secret?: string;
      };
      const botConfig = JSON.parse(await readFile(PW_NOTIFY_BOT_CONFIG_PATH, "utf8")) as {
        bots?: Array<{ provider?: string; providerUserId?: string }>;
      };
      const bot = (botConfig.bots ?? []).find((b) => b && b.provider === "feishu" && b.providerUserId);
      if (!cred.app_id || !cred.app_secret || !bot?.providerUserId) {
        throw new Error("缺 app_id / app_secret / 飞书 providerUserId");
      }
      credentials = { appId: cred.app_id, appSecret: cred.app_secret, openId: bot.providerUserId };
    } catch (error) {
      credentials = null;
      if (!warned) {
        warned = true;
        console.warn(`押注通知 sender 停摆：读不到飞书凭证（${error instanceof Error ? error.message : String(error)}），outbox 将积压`);
      }
    }
    return credentials;
  };

  const tenantToken = async (cred: PwNotifyCredentials): Promise<string> => {
    if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) return cachedToken.value;
    const res = await fetch(FEISHU_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }),
    });
    const body = await res.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (!res.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant_access_token 失败 http=${res.status} code=${body.code} msg=${body.msg}`);
    }
    cachedToken = { value: body.tenant_access_token, expiresAtMs: Date.now() + (body.expire ?? 7200) * 1000 };
    return cachedToken.value;
  };

  const sendCard = async (cred: PwNotifyCredentials, payloadJson: string): Promise<void> => {
    const token = await tenantToken(cred);
    const res = await fetch(FEISHU_MSG_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: cred.openId, msg_type: "interactive", content: payloadJson }),
    });
    const body = await res.json().catch(() => ({})) as { code?: number; msg?: string };
    if (!res.ok || body.code !== 0) {
      throw new Error(`飞书发送失败 http=${res.status} code=${body.code} msg=${body.msg}`);
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const cred = await loadCredentials();
      if (!cred) return;
      for (const row of listPendingOutbox(db, new Date().toISOString())) {
        try {
          await sendCard(cred, row.payload_json);
          markOutboxSent(db, row.id, new Date().toISOString());
        } catch (error) {
          markOutboxFailed(db, row.id, error instanceof Error ? error.message : String(error), {
            now: new Date().toISOString(),
          });
        }
      }
    } finally {
      running = false;
    }
  };

  return { tick };
}

/** GET /n/:token 只读证据页。verifyDispositionToken 与 getPwBet 均为纯读，本函数对正式表零写入。 */
function renderPwDispositionPage(db: DatabaseSync, token: string, response: ServerResponse): void {
  const result = verifyDispositionToken(db, token, new Date().toISOString());
  if (result.status === "not_found") {
    pwNotifyHtmlPage(response, 404, "链接无效", "<p>这张证据卡不存在或已被清理。通知可能来自旧版本链路。</p>");
    return;
  }
  if (result.status === "expired") {
    pwNotifyHtmlPage(response, 410, "链接已过期", "<p>这张证据卡已过 48 小时有效期。回镇纸押注台可重新产生信号。</p>");
    return;
  }
  const bet = getPwBet(db, result.signal.betId);
  const betTitle = bet ? bet.title : "（测试信号：无对应押注）";
  const kindLabel = PW_NOTIFY_KIND_LABEL[result.signal.kind] ?? result.signal.kind;
  const checkout = bet?.checkout_date ? escapeHtml(bet.checkout_date) : "—";
  pwNotifyHtmlPage(response, 200, "押注证据卡", `
    <dl class="kv">
      <div><dt>押注</dt><dd>${escapeHtml(betTitle)}</dd></div>
      <div><dt>触发规则</dt><dd>${escapeHtml(kindLabel)}（${escapeHtml(result.signal.kind)}）</dd></div>
      <div><dt>观察到时间</dt><dd>${escapeHtml(result.signal.observedAt)}</dd></div>
      <div><dt>结账日</dt><dd>${checkout}</dd></div>
    </dl>
    <section class="ev">
      <h2>证据</h2>
      <p class="ph">证据快照在 P2 才落表；当前先给出触发规则与时间，完整上下文回镇纸押注台看。</p>
    </section>
    <p class="back">回电脑端镇纸押注台处置</p>`);
}

function pwNotifyHtmlPage(response: ServerResponse, status: number, title: string, inner: string): void {
  const body = Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · 镇纸</title>
<style>
  body { margin: 0; padding: 32px 20px; background: #f1ebdf; color: #2e2a24;
         font-family: "Noto Sans SC", -apple-system, sans-serif; }
  main { max-width: 560px; margin: 0 auto; background: #fbf7ec; border-radius: 10px;
         padding: 24px; box-shadow: 0 1px 4px rgba(46,42,36,.12); }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 15px; margin: 0 0 8px; }
  .kv div { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px dashed rgba(46,42,36,.15); }
  .kv dt { flex: 0 0 84px; color: #6b6257; }
  .kv dd { margin: 0; }
  .ev { margin-top: 20px; }
  .ph { color: #6b6257; font-size: 14px; }
  .back { display: inline-block; margin-top: 24px; color: #3f6e5a; font-weight: 600; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body>
</html>`);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
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
