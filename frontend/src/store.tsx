/**
 * 服务端数据层：替换原型的 mock store，对接 PapertableV1 引擎。
 *
 * - 项目 / 卡片 / 四种关系边 / 逐句流式回答全部来自 127.0.0.1:4317；
 * - 收藏、置顶、折叠为本地 UI 覆盖层（localStorage），不进服务端；
 *   回收站 PW-70 起服务端化（trashed_at），localStorage 遗留仅作一次性迁移；
 * - 判决簿（墓碑确认 / 金子采纳 / supersede）直连后端判决端点。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  api,
  subscribeRun,
  type CardDetail,
  type ProjectDetail,
  type RunEvent,
  type ServerCard,
  type ServerEdge,
  type ServerLibrary,
} from './lib/api';
import type {
  Card,
  CardEdge,
  Citation,
  EdgeType,
  Project,
  ReferenceChip,
  SourceAnchor,
  Turn,
  Verdict,
  VerdictSyncStatus,
} from './types';
import {
  reduceThinkingActivity,
  reduceToolActivity,
  type ThinkingActivity,
  type ToolActivity,
} from './lib/run-activity';
import { bindRunsToTurns } from './lib/bind-runs';

let seq = 100;
const uid = (p: string) => `${p}-${++seq}`;

const KIND_TO_EDGE: Record<ServerEdge['kind'], EdgeType> = {
  deep_dive: 'child',
  diverge: 'divergent',
  reroute: 'branch',
  concept: 'concept',
};

export interface CreateCardInput {
  type: EdgeType;
  sourceCardId: string;
  sourceTurnId?: string;
  sourceText?: string;
  sourceBlockText?: string;
  sourceRunId?: string;
  conceptId?: string;
  /** 按需概念会话 run（新链路提升入口） */
  previewRunId?: string;
  title: string;
  /** 初始轮次，例如概念预览升级为卡片时带入的问答 */
  seedTurns?: Turn[];
}

interface Toast {
  id: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface LiveRun {
  runId: string;
  cardId: string;
  turnId: string;
  content: string;
  citations: Citation[];
  activity: ToolActivity[];
  thinking: ThinkingActivity[];
  phase: 'planning' | 'tools' | 'answering';
  turnCount: number;
}

interface Overlay {
  favoriteCards: string[];
  trashedCards: string[];
  pinnedProjects: string[];
  projectNames: Record<string, string>;
}

const OVERLAY_KEY = 'papertable-ui-overlay';

function loadOverlay(): Overlay {
  try {
    const parsed = JSON.parse(localStorage.getItem(OVERLAY_KEY) || '{}');
    return {
      favoriteCards: Array.isArray(parsed.favoriteCards) ? parsed.favoriteCards : [],
      trashedCards: Array.isArray(parsed.trashedCards) ? parsed.trashedCards : [],
      pinnedProjects: Array.isArray(parsed.pinnedProjects) ? parsed.pinnedProjects : [],
      projectNames: parsed.projectNames && typeof parsed.projectNames === 'object' ? parsed.projectNames : {},
    };
  } catch {
    return { favoriteCards: [], trashedCards: [], pinnedProjects: [], projectNames: {} };
  }
}

interface Ctx {
  projects: Project[];
  activeProjectId: string;
  cards: Card[];
  edges: CardEdge[];
  currentCardId: string;
  references: ReferenceChip[];
  collapsed: Set<string>;
  toast: Toast | null;
  lastCreated: { cardId: string; type: EdgeType } | null;

  cardById: (id: string) => Card | undefined;
  setActiveProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  togglePinProject: (id: string) => void;
  createProject: () => void;
  deleteProject: (id: string) => void;

  setCurrentCard: (id: string) => void;
  renameCard: (id: string, title: string) => void;
  createCard: (input: CreateCardInput) => void;
  deleteCard: (id: string) => void;
  restoreCards: (ids: string[]) => void;
  purgeCards: (ids: string[]) => Promise<void>;
  toggleFavoriteCard: (id: string) => void;
  toggleCollapse: (id: string) => void;
  markRead: (id: string) => void;

  addReference: (anchor: SourceAnchor, sourceTitle: string) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;

  send: (text: string) => void;
  stopStream: () => void;

  showToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: () => void;

  /* ---------- 判决簿 ---------- */
  verdicts: Verdict[];
  verdictStatus: VerdictSyncStatus;
  pendingTombstone: Verdict | null;
  confirmTombstone: (id: string, text?: string) => void;
  dismissTombstone: () => void;
  supersedeVerdict: (id: string, text: string, handle?: string) => void;
  adoptRun: (runId: string, handle: string, text?: string) => Promise<boolean>;
  ledgerOpen: boolean;
  setLedgerOpen: (open: boolean) => void;

  /* ---------- 资料库 ---------- */
  library: ServerLibrary | null;
  bindLibrary: (path: string) => Promise<void>;
  reindexLibrary: () => Promise<void>;

  /* ---------- 运行控制 ---------- */
  retryRun: (runId: string) => void;
}

const StoreCtx = createContext<Ctx | null>(null);
const LiveRunCtx = createContext<LiveRun | null>(null);
const StreamingTurnCtx = createContext<string | null>(null);

export const useStore = () => {
  const v = useContext(StoreCtx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
};

export const useLiveRun = () => useContext(LiveRunCtx);
export const useStreamingTurnId = () => useContext(StreamingTurnCtx);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [serverCards, setServerCards] = useState<ServerCard[]>([]);
  const [serverEdges, setServerEdges] = useState<ServerEdge[]>([]);
  const [library, setLibrary] = useState<ServerLibrary | null>(null);
  const [cardTurns, setCardTurns] = useState<Record<string, Turn[]>>({});
  const [pendingTurns, setPendingTurns] = useState<Record<string, Turn[]>>({});
  const [currentCardId, setCurrentCardId] = useState('');
  const [references, setReferences] = useState<ReferenceChip[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [lastCreated, setLastCreated] = useState<{ cardId: string; type: EdgeType } | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(loadOverlay);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  const [verdictStatus, setVerdictStatus] = useState<VerdictSyncStatus>({
    available: false,
    pending: 0,
    failed: 0,
    usingLocalCache: true,
  });
  const [pendingTombstone, setPendingTombstone] = useState<Verdict | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  const toastTimer = useRef<number | null>(null);
  const closeStream = useRef<(() => void) | null>(null);
  const liveRef = useRef<LiveRun | null>(null);
  liveRef.current = live;

  useEffect(() => {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  }, [overlay]);

  const showToast = useCallback((t: Omit<Toast, 'id'>) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    const entry = { ...t, id: uid('toast') };
    setToast(entry);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const fail = useCallback(
    (error: unknown, prefix: string) => {
      showToast({ text: `${prefix}：${error instanceof Error ? error.message : String(error)}` });
    },
    [showToast],
  );

  /* ================= 数据装载 ================= */

  const refreshVerdicts = useCallback(async (projectId: string) => {
    try {
      const { verdicts: rows, status } = await api.listVerdicts(projectId);
      setVerdicts(rows);
      setVerdictStatus(status);
      setPendingTombstone((current) =>
        current ?? rows.find((verdict) => verdict.status === 'proposed') ?? null,
      );
    } catch {
      setVerdictStatus((current) => ({ ...current, available: false, usingLocalCache: true }));
    }
  }, []);

  const applyDetail = useCallback((detail: ProjectDetail) => {
    setServerCards(detail.cards);
    setServerEdges(detail.edges);
    setLibrary(detail.library);
  }, []);

  const refreshProject = useCallback(
    async (projectId: string) => {
      const detail = await api.projectDetail(projectId);
      applyDetail(detail);
      return detail;
    },
    [applyDetail],
  );

  const loadCard = useCallback(async (cardId: string) => {
    try {
      const detail = await api.cardDetail(cardId);
      setCardTurns((m) => ({ ...m, [cardId]: detailToTurns(detail) }));
      setPendingTurns((m) => (m[cardId] ? { ...m, [cardId]: [] } : m));
      return detail;
    } catch {
      return null;
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    const { projects: rows } = await api.listProjects();
    setProjects(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        pinned: false,
        updatedAt: Date.parse(row.updatedAt) || Date.now(),
        loaded: true,
      })),
    );
    return rows;
  }, []);

  /* ================= 流式订阅 ================= */

  const stopSubscription = useCallback(() => {
    closeStream.current?.();
    closeStream.current = null;
  }, []);

  const subscribe = useCallback(
    (runId: string, cardId: string) => {
      stopSubscription();
      const turnId = `live-${runId}`;
      setLive({
        runId,
        cardId,
        turnId,
        content: '',
        citations: [],
        activity: [],
        thinking: [],
        phase: 'planning',
        turnCount: 0,
      });
      const close = subscribeRun(runId, (event: RunEvent) => {
        if (event.event === 'turn_start') {
          setLive((prev) =>
            prev && prev.runId === runId
              ? { ...prev, phase: 'planning', turnCount: prev.turnCount + 1 }
              : prev,
          );
          return;
        }
        if (
          event.event === 'tool_start'
          || event.event === 'tool_update'
          || event.event === 'tool_end'
        ) {
          setLive((prev) =>
            prev && prev.runId === runId
              ? { ...prev, phase: 'tools', activity: reduceToolActivity(prev.activity, event) }
              : prev,
          );
          return;
        }
        if (event.event === 'thinking_start' || event.event === 'thinking_end') {
          setLive((prev) =>
            prev && prev.runId === runId
              ? { ...prev, phase: 'planning', thinking: reduceThinkingActivity(prev.thinking, event) }
              : prev,
          );
          return;
        }
        if (event.event === 'answer_sentence') {
          const answer = String(event.answer || '');
          setLive((prev) =>
            prev && prev.runId === runId ? { ...prev, phase: 'answering', content: answer } : prev,
          );
          return;
        }
        if (event.event === 'citation_resolved') {
          const citation: Citation = {
            chunkId: event.chunkId,
            documentId: event.documentId,
            sourceKind: event.sourceKind,
            path: event.path,
            start: event.start,
            end: event.end,
            excerpt: event.excerpt,
          };
          setLive((prev) =>
            prev && prev.runId === runId
              ? { ...prev, citations: [...prev.citations, citation] }
              : prev,
          );
          return;
        }
        if (event.event === 'run_end') {
          stopSubscription();
          setLive(null);
          void loadCard(cardId);
          void refreshProjects();
          const result = String(event.result || '');
          const reason = String(event.reason || '');
          if (result === 'refused' && reason === 'insufficient_evidence') {
            showToast({ text: '资料不足：本轮按 sources-only 规则拒答，可补充资料后重试' });
          } else if (result === 'failed') {
            showToast({ text: `本轮回答失败（${reason}），可在该轮上重试` });
          } else if (result === 'aborted') {
            showToast({ text: '已停止本轮生成' });
          }
        }
      });
      closeStream.current = close;
    },
    [loadCard, refreshProjects, showToast, stopSubscription],
  );

  /* ================= 初始化 ================= */

  const openProject = useCallback(
    async (projectId: string, preferCardId?: string) => {
      setActiveProjectId(projectId);
      setReferences([]);
      setPendingTombstone(null);
      try {
        const detail = await refreshProject(projectId);
        void refreshVerdicts(projectId);
        const alive = detail.cards.filter((c) => !c.trashedAt);
        const target =
          (preferCardId && alive.find((c) => c.id === preferCardId)?.id) ||
          (alive.length ? alive[alive.length - 1].id : '');
        setCurrentCardId(target);
        if (target) void loadCard(target);
        // 若有仍在运行的 run，恢复订阅
        if (target) {
          const cardDetail = await api.cardDetail(target).catch(() => null);
          const running = cardDetail?.runs.find((run) => run.status === 'running');
          if (running) subscribe(running.id, target);
        }
      } catch (error) {
        fail(error, '加载项目失败');
      }
    },
    [refreshProject, refreshVerdicts, loadCard, subscribe, fail],
  );

  useEffect(() => {
    void (async () => {
      try {
        const rows = await refreshProjects();
        if (rows.length > 0) await openProject(rows[0].id);
      } catch (error) {
        fail(error, '无法连接本地引擎（127.0.0.1:4317）');
      }
    })();
    return () => stopSubscription();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* TASK-PW-70：一次性迁移——旧回收站是 localStorage 本地隐藏，逐项目推到服务端后从覆盖层清掉 */
  const migratedTrashRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!activeProjectId || migratedTrashRef.current.has(activeProjectId)) return;
    migratedTrashRef.current.add(activeProjectId);
    const legacy = overlay.trashedCards;
    if (!legacy.length) return;
    void (async () => {
      try {
        const r = await api.trashCards(activeProjectId, legacy);
        if (r.trashed.length) {
          setOverlay((o) => ({ ...o, trashedCards: o.trashedCards.filter((x) => !r.trashed.includes(x)) }));
          await refreshProject(activeProjectId);
        }
      } catch {
        /* 迁移失败不打扰，下次启动再试 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    const timer = window.setInterval(() => void refreshVerdicts(activeProjectId), 15_000);
    return () => window.clearInterval(timer);
  }, [activeProjectId, refreshVerdicts]);

  /* ================= 派生视图（原型数据模型） ================= */

  const cards = useMemo<Card[]>(() => {
    return serverCards.map((row) => {
      let turns = cardTurns[row.id] ?? [];
      const pending = pendingTurns[row.id] ?? [];
      if (pending.length) turns = [...turns, ...pending];
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        turns,
        favorite: overlay.favoriteCards.includes(row.id),
        unread: false,
        concepts: [],
        trashed: !!row.trashedAt,
        createdAt: Date.parse(row.createdAt) || Date.now(),
      };
    });
  }, [serverCards, cardTurns, pendingTurns, overlay]);

  const edges = useMemo<CardEdge[]>(
    () =>
      serverEdges.map((edge) => ({
        id: edge.id,
        type: KIND_TO_EDGE[edge.kind],
        sourceCardId: edge.sourceCardId,
        targetCardId: edge.targetCardId,
        sourceTurnId: String(edge.snapshot.sourceEntryId || '') || undefined,
        sourceText: String(edge.snapshot.selectedText || '') || undefined,
        sourceBlockText: undefined,
        contextPolicy:
          edge.kind === 'deep_dive'
            ? 'topic-and-selection'
            : edge.kind === 'diverge'
              ? 'topic-only'
              : edge.kind === 'reroute'
                ? 'history-through-turn'
                : 'concept-expansion',
      })),
    [serverEdges],
  );

  const projectsView = useMemo<Project[]>(
    () =>
      projects.map((p) => ({
        ...p,
        name: overlay.projectNames[p.id] || p.name,
        pinned: overlay.pinnedProjects.includes(p.id),
      })),
    [projects, overlay],
  );

  const cardById = useCallback((id: string) => cards.find((c) => c.id === id), [cards]);

  /* ================= 项目操作 ================= */

  const setActiveProject = useCallback(
    (id: string) => {
      if (id === activeProjectId) return;
      stopSubscription();
      setLive(null);
      void openProject(id);
    },
    [activeProjectId, openProject, stopSubscription],
  );

  const createProject = useCallback(() => {
    const stamp = new Date();
    const suggested = `未命名项目 ${stamp.getMonth() + 1}-${stamp.getDate()} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
    const name = window.prompt('项目名称', suggested)?.trim();
    if (!name) return;
    void (async () => {
      try {
        const created = await api.createProject(name);
        await refreshProjects();
        await openProject(created.id);
        showToast({ text: '项目已创建：在下方输入第一个问题，即以它建立根卡片' });
      } catch (error) {
        fail(error, '创建项目失败');
      }
    })();
  }, [refreshProjects, openProject, showToast, fail]);

  const renameProject = useCallback((id: string, name: string) => {
    void (async () => {
      try {
        const updated = await api.renameProject(id, name);
        setProjects((rows) => rows.map((row) => row.id === id
          ? { ...row, name: updated.name, updatedAt: Date.parse(updated.updatedAt) || Date.now() }
          : row));
        setOverlay((current) => {
          const projectNames = { ...current.projectNames };
          delete projectNames[id];
          return { ...current, projectNames };
        });
        showToast({ text: `项目已改名为「${updated.name}」` });
      } catch (error) {
        fail(error, '项目改名失败');
      }
    })();
  }, [showToast, fail]);

  const togglePinProject = useCallback((id: string) => {
    setOverlay((o) => ({
      ...o,
      pinnedProjects: o.pinnedProjects.includes(id)
        ? o.pinnedProjects.filter((x) => x !== id)
        : [...o.pinnedProjects, id],
    }));
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      // TASK-PW-70：项目物理级联删除、不设保护；确认 toast 只是防误触点
      const target = projects.find((p) => p.id === id);
      showToast({
        text: `确定删除项目「${target?.name ?? id}」？卡片、语料、资料绑定全部物理删除，不可恢复`,
        actionLabel: '确认删除',
        onAction: () => {
          void (async () => {
            try {
              await api.deleteProject(id);
              dismissToast();
              const rows = await refreshProjects();
              if (activeProjectId === id) {
                if (rows.length) await openProject(rows[0].id);
                else {
                  setActiveProjectId('');
                  setCurrentCardId('');
                }
              }
              showToast({ text: '项目已删除' });
            } catch (error) {
              fail(error, '项目删除失败');
            }
          })();
        },
      });
    },
    [projects, activeProjectId, refreshProjects, openProject, showToast, dismissToast, fail],
  );

  /* ================= 卡片操作 ================= */

  const setCurrentCard = useCallback(
    (id: string) => {
      const previous = currentCardId;
      setCurrentCardId(id);
      if (!cardTurns[id]) void loadCard(id);
      if (previous && previous !== id) void api.stageCard(previous, 'card_left');
    },
    [currentCardId, cardTurns, loadCard],
  );

  const markRead = useCallback((_id: string) => undefined, []);

  const renameCard = useCallback((id: string, title: string) => {
    void (async () => {
      try {
        const updated = await api.renameCard(id, title);
        setServerCards((rows) => rows.map((row) => row.id === id ? updated : row));
        showToast({ text: `卡片已改名为「${updated.title}」` });
      } catch (error) {
        fail(error, '卡片改名失败');
      }
    })();
  }, [showToast, fail]);

  const findEntryForBranch = useCallback(
    (sourceCardId: string, sourceTurnId?: string): { userEntryId?: string; aiTurn?: Turn } => {
      const turns = cardTurns[sourceCardId] ?? [];
      let index = sourceTurnId ? turns.findIndex((t) => t.id === sourceTurnId) : turns.length - 1;
      if (index < 0) index = turns.length - 1;
      const aiTurn = turns
        .slice(0, index + 1)
        .reverse()
        .find((t) => t.role === 'ai' && t.entryId);
      for (let i = index; i >= 0; i -= 1) {
        if (turns[i].role === 'user' && turns[i].entryId) {
          return { userEntryId: turns[i].entryId, aiTurn };
        }
      }
      return { aiTurn };
    },
    [cardTurns],
  );

  const createCard = useCallback(
    (input: CreateCardInput) => {
      void (async () => {
        const question =
          input.seedTurns?.find((t) => t.role === 'user')?.content.trim() ||
          `围绕「${input.title}」继续探索`;
        try {
          let payload;
          if (input.type === 'concept') {
            if (!input.previewRunId && (!input.sourceRunId || !input.conceptId)) {
              throw new Error('概念临时卡缺少 AI 来源，无法展开');
            }
            payload = {
              kind: 'concept' as const,
              question,
              ...(input.previewRunId
                ? { previewRunId: input.previewRunId }
                : { sourceRunId: input.sourceRunId, conceptId: input.conceptId }),
            };
          } else if (input.type === 'child') {
            const turns = cardTurns[input.sourceCardId] ?? [];
            const target =
              (input.sourceTurnId && turns.find((t) => t.id === input.sourceTurnId && t.role === 'ai')) ||
              [...turns].reverse().find((t) => t.role === 'ai' && t.entryId) ||
              // 导入的素材卡（评论/桶卡）没有 AI 回答：回退到卡内 user 轮，把素材原文冻结为深挖选区
              [...turns].reverse().find((t) => t.role === 'user' && t.entryId);
            if (!target?.entryId) throw new Error('当前卡片还没有可深挖的内容');
            const selection = resolveSelection(target, input.sourceText);
            payload = { kind: 'deep_dive' as const, question, selection };
          } else if (input.type === 'divergent') {
            payload = { kind: 'diverge' as const, question, topic: input.title };
          } else {
            const { userEntryId } = findEntryForBranch(input.sourceCardId, input.sourceTurnId);
            if (!userEntryId) throw new Error('改道需要至少一轮已有的提问');
            payload = { kind: 'reroute' as const, question, sourceEntryId: userEntryId };
          }
          const result = await api.createBranch(input.sourceCardId, payload);
          if (result.verdict) setPendingTombstone(result.verdict);
          await refreshProject(activeProjectId);
          setLastCreated({ cardId: result.cardId, type: input.type });
          setCurrentCardId(result.cardId);
          if (input.type === 'concept') {
            await loadCard(result.cardId);
          } else {
            void loadCard(result.cardId);
            if (result.runId) subscribe(result.runId, result.cardId);
          }
        } catch (error) {
          fail(error, '创建卡片失败');
        }
      })();
    },
    [cardTurns, findEntryForBranch, refreshProject, activeProjectId, loadCard, subscribe, fail],
  );

  const deleteCard = useCallback(
    (id: string) => {
      // TASK-PW-70：回收站服务端化（trashed_at 可逆标记），撤销=restore
      if (!activeProjectId) return;
      const ids = collectSubtree(serverEdges, id);
      const fallback = serverEdges.find((e) => e.targetCardId === id)?.sourceCardId
        || serverCards.find((c) => !ids.includes(c.id) && !c.trashedAt)?.id;
      if (ids.includes(currentCardId) && fallback) setCurrentCardId(fallback);
      void api.trashCards(activeProjectId, ids)
        .then(() => refreshProject(activeProjectId))
        .catch((error) => fail(error, '移入回收站失败'));
      showToast({
        text: `已移入回收站 · ${ids.length} 张卡片`,
        actionLabel: '撤销',
        onAction: () => {
          void api.restoreCards(activeProjectId, ids)
            .then(() => refreshProject(activeProjectId))
            .catch((error) => fail(error, '撤销失败'));
          setCurrentCardId(id);
          dismissToast();
        },
      });
    },
    [activeProjectId, serverEdges, serverCards, currentCardId, refreshProject, showToast, dismissToast, fail],
  );

  const restoreCards = useCallback(
    (ids: string[]) => {
      if (!ids.length || !activeProjectId) return;
      // TASK-PW-70：还原清服务端 trashed_at
      void (async () => {
        try {
          await api.restoreCards(activeProjectId, ids);
          await refreshProject(activeProjectId);
          showToast({ text: `已还原 ${ids.length} 张卡片` });
        } catch (error) {
          fail(error, '还原失败');
        }
      })();
    },
    [activeProjectId, refreshProject, showToast, fail],
  );

  const purgeCards = useCallback(
    async (ids: string[]) => {
      if (!ids.length || !activeProjectId) return;
      const result = await api.purgeCards(activeProjectId, ids);
      if (result.purged.includes(currentCardId)) {
        const fallback = serverCards.find(
          (c) => !result.purged.includes(c.id) && !c.trashedAt,
        )?.id;
        if (fallback) setCurrentCardId(fallback);
      }
      await refreshProject(activeProjectId);
      const skippedText = result.skipped.length
        ? `；跳过 ${result.skipped.length} 张（${result.skipped[0].reason}${result.skipped.length > 1 ? ' 等' : ''}）`
        : '';
      showToast({ text: `已彻底删除 ${result.purged.length} 张卡片${skippedText}` });
    },
    [activeProjectId, currentCardId, serverCards, refreshProject, showToast],
  );

  const toggleFavoriteCard = useCallback((id: string) => {
    setOverlay((o) => ({
      ...o,
      favoriteCards: o.favoriteCards.includes(id)
        ? o.favoriteCards.filter((x) => x !== id)
        : [...o.favoriteCards, id],
    }));
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  /* ================= 引用 ================= */

  const addReference = useCallback(
    (anchor: SourceAnchor, sourceTitle: string) => {
      const text = (anchor.text ?? '').trim();
      if (!text) return;
      setReferences((rs) => {
        if (rs.some((r) => r.excerpt === text && r.anchor.cardId === anchor.cardId)) return rs;
        return [...rs, { id: uid('ref'), anchor, sourceTitle, excerpt: text }];
      });
      showToast({ text: '已添加引用，将作为结构化上下文带入下一次提问' });
    },
    [showToast],
  );

  const removeReference = useCallback((id: string) => {
    setReferences((rs) => rs.filter((r) => r.id !== id));
  }, []);

  const clearReferences = useCallback(() => setReferences([]), []);

  /* ================= 发送与流控 ================= */

  const send = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || liveRef.current) return;
      const refBlock = references.length
        ? references.map((r) => `【引用｜${r.sourceTitle}】${r.excerpt}`).join('\n') + '\n\n'
        : '';
      const question = refBlock + clean;
      setReferences([]);
      void (async () => {
        try {
          if (!currentCardId) {
            if (!activeProjectId) throw new Error('请先创建一个项目');
            const created = await api.createRootCard(activeProjectId, question);
            await refreshProject(activeProjectId);
            setCurrentCardId(created.cardId);
            void loadCard(created.cardId);
            subscribe(created.runId, created.cardId);
            return;
          }
          const cardId = currentCardId;
          setPendingTurns((m) => ({
            ...m,
            [cardId]: [
              ...(m[cardId] ?? []),
              { id: uid('pending'), role: 'user', content: question },
            ],
          }));
          const { runId } = await api.continueCard(cardId, question);
          subscribe(runId, cardId);
        } catch (error) {
          fail(error, '发送失败');
        }
      })();
    },
    [references, currentCardId, activeProjectId, refreshProject, loadCard, subscribe, fail],
  );

  const stopStream = useCallback(() => {
    const current = liveRef.current;
    if (!current) return;
    void api.abortRun(current.runId).catch(() => undefined);
  }, []);

  const retryRun = useCallback(
    (runId: string) => {
      void (async () => {
        try {
          const { runId: next } = await api.retryRun(runId);
          if (currentCardId) subscribe(next, currentCardId);
        } catch (error) {
          fail(error, '重试失败');
        }
      })();
    },
    [currentCardId, subscribe, fail],
  );

  /* ================= 判决簿 ================= */

  const confirmTombstone = useCallback(
    (id: string, text?: string) => {
      void (async () => {
        try {
          const result = await api.confirmVerdict(id, text);
          setPendingTombstone(null);
          void refreshVerdicts(activeProjectId);
          subscribe(result.runId, result.verdict.cardId!);
          showToast({
            text: result.verdict.memosStatus === 'submitted'
              ? '墓碑已写入 MemOS，并用于这张改道卡的首轮回答'
              : '墓碑已安全留在本机，MemOS 恢复后自动补写；本轮按本地副本降级使用',
          });
        } catch (error) {
          fail(error, '确认失败');
        }
      })();
    },
    [activeProjectId, refreshVerdicts, showToast, fail, subscribe],
  );

  const dismissTombstone = useCallback(() => {
    const pending = pendingTombstone;
    if (!pending) return;
    void (async () => {
      try {
        const result = await api.abandonVerdict(pending.id);
        setPendingTombstone(null);
        void refreshVerdicts(activeProjectId);
        subscribe(result.runId, result.verdict.cardId!);
        showToast({ text: '已明确放弃墓碑草稿；没有写入 MemOS，改道卡继续回答' });
      } catch (error) {
        fail(error, '放弃墓碑失败');
      }
    })();
  }, [pendingTombstone, refreshVerdicts, activeProjectId, subscribe, showToast, fail]);

  const supersedeVerdictAction = useCallback(
    (id: string, text: string, handle?: string) => {
      void (async () => {
        try {
          const replacement = await api.supersedeVerdict(id, text, handle);
          void refreshVerdicts(activeProjectId);
          showToast({
            text: replacement.memosStatus === 'submitted'
              ? '新判决已替代旧版本；旧记录仍保留可审计'
              : '替代版本已留在本机待重试；旧记录没有删除',
          });
        } catch (error) {
          fail(error, '操作失败');
        }
      })();
    },
    [activeProjectId, refreshVerdicts, showToast, fail],
  );

  const adoptRunAction = useCallback(
    async (runId: string, handle: string, text?: string) => {
      try {
        const verdict = await api.adoptRun(runId, handle, text);
        void refreshVerdicts(activeProjectId);
        showToast({
          text: verdict.memosStatus === 'submitted'
            ? `金子已写入 MemOS · 把手「${handle}」`
            : `金子已安全留在本机待重试 · 把手「${handle}」`,
        });
        return true;
      } catch (error) {
        fail(error, '采纳失败');
        return false;
      }
    },
    [activeProjectId, refreshVerdicts, showToast, fail],
  );

  /* ================= 资料库 ================= */

  const bindLibraryAction = useCallback(
    async (path: string) => {
      try {
        await api.bindLibrary(activeProjectId, path);
        await refreshProject(activeProjectId);
        showToast({ text: '资料库已绑定，可执行重建索引' });
      } catch (error) {
        fail(error, '绑定失败');
      }
    },
    [activeProjectId, refreshProject, showToast, fail],
  );

  const reindexLibraryAction = useCallback(async () => {
    try {
      showToast({ text: '正在重建索引…' });
      await api.reindexLibrary(activeProjectId);
      await refreshProject(activeProjectId);
      showToast({ text: '索引已重建' });
    } catch (error) {
      fail(error, '重建索引失败');
    }
  }, [activeProjectId, refreshProject, showToast, fail]);

  /* ================= 汇总 ================= */

  const value = useMemo<Ctx>(
    () => ({
      projects: projectsView,
      activeProjectId,
      cards,
      edges,
      currentCardId,
      references,
      collapsed,
      toast,
      lastCreated,
      cardById,
      setActiveProject,
      renameProject,
      togglePinProject,
      createProject,
      deleteProject,
      setCurrentCard,
      renameCard,
      createCard,
      deleteCard,
      restoreCards,
      purgeCards,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      addReference,
      removeReference,
      clearReferences,
      send,
      stopStream,
      showToast,
      dismissToast,
      verdicts,
      verdictStatus,
      pendingTombstone,
      confirmTombstone,
      dismissTombstone,
      supersedeVerdict: supersedeVerdictAction,
      adoptRun: adoptRunAction,
      ledgerOpen,
      setLedgerOpen,
      library,
      bindLibrary: bindLibraryAction,
      reindexLibrary: reindexLibraryAction,
      retryRun,
    }),
    [
      projectsView,
      activeProjectId,
      cards,
      edges,
      currentCardId,
      references,
      collapsed,
      toast,
      lastCreated,
      cardById,
      setActiveProject,
      renameProject,
      togglePinProject,
      createProject,
      deleteProject,
      setCurrentCard,
      renameCard,
      createCard,
      deleteCard,
      restoreCards,
      purgeCards,
      toggleFavoriteCard,
      toggleCollapse,
      markRead,
      addReference,
      removeReference,
      clearReferences,
      send,
      stopStream,
      showToast,
      dismissToast,
      verdicts,
      verdictStatus,
      pendingTombstone,
      confirmTombstone,
      dismissTombstone,
      supersedeVerdictAction,
      adoptRunAction,
      ledgerOpen,
      library,
      bindLibraryAction,
      reindexLibraryAction,
      retryRun,
    ],
  );

  return (
    <StoreCtx.Provider value={value}>
      <StreamingTurnCtx.Provider value={live?.turnId ?? null}>
        <LiveRunCtx.Provider value={live}>{children}</LiveRunCtx.Provider>
      </StreamingTurnCtx.Provider>
    </StoreCtx.Provider>
  );
}

/* ================= 纯函数 ================= */

/**
 * 把 cardDetail 映射为原型的轮次序列。
 * messages 只保留成功轮的正文（失败轮会被会话回滚），所以：
 * 1) 先用 messages 建骨架（携带 entryId，包含改道继承的历史）；
 * 2) 完成轮用 bindRunsToTurns 绑定锚点（稳定 answerEntryId，禁止正文文本匹配）；
 * 3) 失败轮按 run 时序插入到下一个完成轮锚点之前，保持时间线正确。
 */
function detailToTurns(detail: CardDetail): Turn[] {
  const turns: Turn[] = detail.messages.map((message) => ({
    id: message.entryId,
    entryId: message.entryId,
    role: message.role === 'assistant' ? 'ai' : 'user',
    content: message.text,
  }));
  const ended = detail.runs.filter((run) => run.status === 'ended');

  // 第一遍：为已进入 Pi 历史的完成轮找锚点（AI 轮索引）。
  const anchors = new Map<string, number>();
  const bindings = bindRunsToTurns(turns, ended);
  for (const run of ended) {
    if (run.result !== 'completed' || !run.answer) continue;
    const i = bindings.get(run.id);
    if (i === undefined) continue;
    turns[i].runId = run.id;
    turns[i].status = run.result ?? undefined;
    turns[i].reason = run.reason ?? undefined;
    turns[i].citations = run.citations;
    turns[i].concepts = run.concepts;
    turns[i].verdictTrace = run.verdictTrace;
    turns[i].verdictUse = run.verdictUse;
    turns[i].activity = (run.activity ?? []).reduce(reduceToolActivity, []);
    turns[i].thinking = (run.activity ?? []).reduce(reduceThinkingActivity, []);
    anchors.set(run.id, i);
  }

  // 第二遍：被 Pi 历史回滚的非完成轮，按 run 时序放回产品时间线。
  for (let r = ended.length - 1; r >= 0; r -= 1) {
    const run = ended[r];
    if (run.result === 'completed') continue;
    let insertAt = turns.length;
    for (let n = r + 1; n < ended.length; n += 1) {
      const anchor = anchors.get(ended[n].id);
      if (anchor !== undefined) {
        // 锚点是 AI 轮；其用户提问紧贴在前一位
        insertAt = Math.max(0, anchor - 1);
        break;
      }
    }
    turns.splice(
      insertAt,
      0,
      { id: `runq-${run.id}`, role: 'user', content: run.question },
      {
        id: `run-${run.id}`,
        role: 'ai',
        content: run.answer ?? '',
        runId: run.id,
        status: run.result ?? 'failed',
        reason: run.reason ?? undefined,
        error: run.error ?? undefined,
        citations: run.citations,
        activity: (run.activity ?? []).reduce(reduceToolActivity, []),
        thinking: (run.activity ?? []).reduce(reduceThinkingActivity, []),
        verdictTrace: run.verdictTrace,
        verdictUse: run.verdictUse,
      },
    );
  }
  return turns;
}

/** 深挖选区：优先精确匹配偏移；失配时退化为整段回答 */
function resolveSelection(
  target: Turn,
  sourceText?: string,
): { entryId: string; text: string; start: number; end: number } {
  const entryId = target.entryId!;
  const raw = target.content;
  const text = (sourceText ?? '').trim();
  if (text) {
    const start = raw.indexOf(text);
    if (start >= 0) return { entryId, text, start, end: start + text.length };
  }
  return { entryId, text: raw, start: 0, end: raw.length };
}

function collectSubtree(edges: ServerEdge[], rootId: string): string[] {
  const out = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.sourceCardId === id && !out.includes(edge.targetCardId)) {
        out.push(edge.targetCardId);
        queue.push(edge.targetCardId);
      }
    }
  }
  return out;
}
