import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import {
  httpError,
  jsonObject,
  nowIso,
  requireCard,
  requireRun,
  type DataStore,
  type RunRow,
  type SourceKind,
} from "./data.ts";
import type { MemoryBridge } from "./memos.ts";

const COACH_SCRIPT = process.env.PAPERTABLE_KNOWLEDGE_COACH_SCRIPT?.trim()
  || join(homedir(), ".codex", "skills", "knowledge-coach", "scripts", "knowledge_coach.py");
const COACH_VAULT = process.env.PAPERTABLE_OBSIDIAN_VAULT?.trim()
  || join(homedir(), "主知识库_AI");
const COACH_PREVIEWS = join(COACH_VAULT, "80_AI暂存", "知识教练", "previews");

type PromotionRequest = {
  projectId: string;
  cardId: string;
  runId: string;
  selectedText: string;
  start: number;
  end: number;
  title: string;
  targetPath?: string;
  confirmedPersonalSynthesis: boolean;
};

type EvidenceRow = {
  chunk_id: string;
  document_id: string;
  source_kind: SourceKind;
  relative_path: string;
  actual_path: string;
  start_offset: number;
  end_offset: number;
  text: string;
};

type RunSourceRow = {
  document_id: string;
  source_kind: SourceKind;
  relative_path: string;
  actual_path: string;
  sha256: string;
};

export class PromotionService {
  #store: DataStore;
  #memory: MemoryBridge;

  constructor(store: DataStore, memory: MemoryBridge) {
    this.#store = store;
    this.#memory = memory;
  }

  async preview(request: PromotionRequest): Promise<Record<string, unknown>> {
    const run = requireRun(this.#store.db, request.runId);
    const card = requireCard(this.#store.db, request.cardId);
    if (
      run.project_id !== request.projectId
      || run.card_id !== request.cardId
      || card.project_id !== request.projectId
    ) {
      throw httpError(400, "项目、卡片与回答不匹配");
    }
    if (run.result !== "completed" || !run.answer) {
      throw httpError(409, "只有已完成且通过出口门禁的回答才能保留");
    }
    if (request.confirmedPersonalSynthesis !== true) {
      throw httpError(409, "必须先确认选区是你自己的提炼，才能进入保留流程");
    }
    const selection = validateSelection(run, request);
    const userClaim = selection.replace(/\[\[source:[^\]]+\]\]/g, "").trim();
    if (!userClaim) {
      throw httpError(409, "选区只有引用，没有你自己的提炼内容");
    }
    const chunkIds = [...selection.matchAll(/\[\[source:([^\]\s]+)\]\]/g)]
      .map((match) => match[1])
      .filter((id, index, all) => all.indexOf(id) === index);
    if (chunkIds.length === 0) {
      throw httpError(409, "这段选区没有受控引用，请先补证据再发布");
    }
    if (chunkIds.length > 5) {
      throw httpError(409, "一次预览最多包含 5 个引用片段，请缩小选区");
    }
    const evidence = await evidenceRows(this.#store.db, run, chunkIds);
    if (evidence.length !== chunkIds.length) {
      throw httpError(409, "选区包含已经失效或不属于该回答的引用");
    }
    const roots = sourceRoots(evidence);
    const refs = new Map<string, string>();
    const sourceEvidence = evidence.map((row) => {
      const ref = sourceRef(row);
      refs.set(ref, ref);
      return {
        ref,
        locator: `chars ${row.start_offset}-${row.end_offset}`,
        excerpt: row.text,
        capture: "verbatim",
      };
    });
    const title = cleanTitle(request.title);
    const target = validateTarget(
      request.targetPath || `10_活跃知识/概念/${safeFilename(title)}.md`,
    );
    const proposal = await runCoach(
      coachArgs(roots, "propose", "--input", "-"),
      {
        source_refs: [...refs.keys()],
        candidates: [{
          title,
          source_evidence: sourceEvidence,
          coach_relevance: "用户在 Papertable 的完整检索回答中主动选中这段内容，并要求保留为长期知识。",
          evidence_boundary: "用户选择的文字是个人提炼；来源原文仅限上列逐字片段，二者不能互相冒充。",
          related_knowledge: [],
        }],
      },
    );
    const created = Array.isArray(proposal.created) ? proposal.created : [];
    const recordId = String(asRecord(created[0]).id || "");
    if (!recordId) throw new Error("Knowledge Coach did not return a record id");
    await runCoach(coachArgs(
      roots,
      "decide",
      "--id",
      recordId,
      "--disposition",
      "keep",
      "--user-claim",
      userClaim,
      "--artifact-type",
      "evidence-note",
      "--target",
      target,
      "--applicable-when",
      "需要重新进入这个概念或核对其来源时",
    ));
    const preview = await runCoach(coachArgs(roots, "preview", "--id", recordId));
    const previewDigest = String(preview.preview_digest || "");
    const knowledgeId = String(preview.knowledge_id || "");
    if (!/^[a-f0-9]{64}$/.test(previewDigest)) throw new Error("Knowledge Coach returned an invalid preview digest");
    const [human, diff] = await Promise.all([
      readFile(`${COACH_PREVIEWS}/${recordId}/human.md`, "utf8"),
      readFile(`${COACH_PREVIEWS}/${recordId}/human.diff`, "utf8"),
    ]);
    const promotionId = randomUUID();
    const now = nowIso();
    const privatePreview = {
      manifest: preview,
      roots,
      sourceChunkIds: chunkIds,
      selectedText: selection,
      human,
      diff,
    };
    this.#store.db.prepare(`
      INSERT INTO pt_promotions(
        id, project_id, card_id, run_id, record_id, preview_digest, target_path,
        knowledge_id, state, preview_json, publish_json, verify_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?, NULL, NULL, ?, ?)
    `).run(
      promotionId,
      request.projectId,
      request.cardId,
      request.runId,
      recordId,
      previewDigest,
      target,
      knowledgeId || null,
      JSON.stringify(privatePreview),
      now,
      now,
    );
    return {
      id: promotionId,
      recordId,
      targetPath: target,
      knowledgeId,
      previewDigest,
      human,
      diff,
    };
  }

  async publish(promotionId: string): Promise<Record<string, unknown>> {
    const row = this.#store.db.prepare(
      "SELECT * FROM pt_promotions WHERE id = ?",
    ).get(promotionId) as {
      id: string;
      record_id: string;
      preview_digest: string;
      target_path: string;
      knowledge_id: string | null;
      state: string;
      preview_json: string;
      publish_json: string | null;
      verify_json: string | null;
    } | undefined;
    if (!row) throw httpError(404, "发布预览不存在");
    if (row.state === "verified") throw httpError(409, "这个预览已经发布并验证");
    const stored = asRecord(JSON.parse(row.preview_json));
    const roots = asStringRecord(stored.roots);
    let published = row.publish_json ? asRecord(JSON.parse(row.publish_json)) : {};
    if (row.state === "previewed") {
      published = await runCoach(coachArgs(
        roots,
        "publish",
        "--id",
        row.record_id,
        "--preview-digest",
        row.preview_digest,
      ));
      this.#store.db.prepare(`
        UPDATE pt_promotions
        SET state = 'published', publish_json = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(published), nowIso(), promotionId);
    }
    let verified = row.verify_json ? asRecord(JSON.parse(row.verify_json)) : {};
    if (row.state !== "reconcile_pending") {
      verified = await runCoach(coachArgs(roots, "verify", "--id", row.record_id));
      if (verified.ok !== true) {
        throw new Error(`Knowledge Coach verify failed: ${JSON.stringify(verified.errors || [])}`);
      }
      this.#store.db.prepare(`
        UPDATE pt_promotions SET verify_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(verified), nowIso(), promotionId);
    }
    let reconcile: Record<string, unknown> | undefined;
    let reconcileError: string | undefined;
    try {
      reconcile = await this.#memory.reconcileCuratedKnowledge();
    } catch (error) {
      reconcileError = error instanceof Error ? error.message : String(error);
    }
    const state = reconcileError ? "reconcile_pending" : "verified";
    this.#store.db.prepare(`
      UPDATE pt_promotions
      SET state = ?, publish_json = ?, verify_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      state,
      JSON.stringify({ ...published, curatedReconcile: reconcile, reconcileError }),
      JSON.stringify(verified),
      nowIso(),
      promotionId,
    );
    return {
      id: promotionId,
      state,
      targetPath: row.target_path,
      knowledgeId: row.knowledge_id,
      published,
      verified,
      curatedReconcile: reconcile || { pending: true, error: reconcileError },
      personalApplication: "正式知识已发布；Papertable 不会自动把来源观点写成你的业务记忆。",
    };
  }

  async retryPendingReconciles(): Promise<number> {
    const rows = this.#store.db.prepare(`
      SELECT id FROM pt_promotions
      WHERE state = 'reconcile_pending'
      ORDER BY updated_at
    `).all() as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const reconcile = await this.#memory.reconcileCuratedKnowledge();
    const now = nowIso();
    for (const row of rows) {
      const current = this.#store.db.prepare(
        "SELECT publish_json FROM pt_promotions WHERE id = ? AND state = 'reconcile_pending'",
      ).get(row.id) as { publish_json: string | null } | undefined;
      if (!current) continue;
      const published = current.publish_json ? asRecord(JSON.parse(current.publish_json)) : {};
      this.#store.db.prepare(`
        UPDATE pt_promotions
        SET state = 'verified', publish_json = ?, updated_at = ?
        WHERE id = ? AND state = 'reconcile_pending'
      `).run(JSON.stringify({ ...published, curatedReconcile: reconcile }), now, row.id);
    }
    return rows.length;
  }
}

function validateSelection(run: RunRow, request: PromotionRequest): string {
  if (!Number.isInteger(request.start) || !Number.isInteger(request.end)) {
    throw httpError(400, "选区必须携带文本偏移");
  }
  if (
    request.start < 0
    || request.end <= request.start
    || request.end > (run.answer?.length || 0)
    || run.answer?.slice(request.start, request.end) !== request.selectedText
  ) {
    throw httpError(400, "选区与冻结回答不一致，请重新选择");
  }
  return request.selectedText;
}

async function evidenceRows(
  db: DatabaseSync,
  run: RunRow,
  chunkIds: string[],
): Promise<EvidenceRow[]> {
  const citationRows = db.prepare(`
    SELECT payload_json FROM pt_run_events
    WHERE run_id = ? AND event_type = 'citation_resolved'
    ORDER BY seq
  `).all(run.id) as Array<{ payload_json: string }>;
  const citations = new Map(
    citationRows.map((row) => {
      const citation = jsonObject(row.payload_json);
      return [String(citation.chunkId || ""), citation] as const;
    }),
  );
  const sources = db.prepare(
    "SELECT * FROM pt_run_sources WHERE run_id = ?",
  ).all(run.id) as RunSourceRow[];
  const sourceByDocument = new Map(sources.map((source) => [source.document_id, source]));
  const legacySource = db.prepare(`
    SELECT id AS document_id, source_kind, relative_path, actual_path, sha256
    FROM pt_documents WHERE id = ?
  `);
  const evidence: EvidenceRow[] = [];
  for (const chunkId of chunkIds) {
    const citation = citations.get(chunkId);
    if (!citation) continue;
    const documentId = String(citation.documentId || "");
    const source = sourceByDocument.get(documentId)
      || legacySource.get(documentId) as RunSourceRow | undefined;
    if (
      !source
      || source.source_kind !== citation.sourceKind
      || source.relative_path !== citation.path
    ) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(source.actual_path);
    } catch {
      throw httpError(409, `引用来源已经不存在：${source.relative_path}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) {
      throw httpError(409, `引用来源在回答后发生了变化，请重新检索后再发布：${source.relative_path}`);
    }
    evidence.push({
      chunk_id: chunkId,
      document_id: documentId,
      source_kind: source.source_kind,
      relative_path: source.relative_path,
      actual_path: source.actual_path,
      start_offset: Number(citation.start),
      end_offset: Number(citation.end),
      text: String(citation.excerpt || ""),
    });
  }
  return evidence;
}

function sourceRoots(rows: EvidenceRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  const library = rows.find((row) => row.source_kind === "library");
  if (library) {
    let root = library.actual_path;
    for (const _segment of library.relative_path.split("/")) root = dirname(root);
    result["papertable-library"] = root;
  }
  const material = rows.find((row) => row.source_kind === "project_material");
  if (material) result["papertable-materials"] = dirname(material.actual_path);
  return result;
}

function sourceRef(row: EvidenceRow): string {
  return row.source_kind === "library"
    ? `papertable-library://${row.relative_path}`
    : `papertable-materials://${basename(row.actual_path)}`;
}

function coachArgs(
  roots: Record<string, string>,
  ...command: string[]
): string[] {
  const args: string[] = [
    COACH_SCRIPT,
    "--destination",
    COACH_VAULT,
  ];
  for (const [alias, path] of Object.entries(roots)) {
    args.push("--source-root", `${alias}=${path}`);
  }
  args.push(...command);
  return args;
}

async function runCoach(
  args: string[],
  input?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const executable = process.env.PAPERTABLE_KNOWLEDGE_COACH_PYTHON?.trim() || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error((errorOutput || output || `Knowledge Coach exited ${code}`).slice(0, 1200)));
        return;
      }
      try {
        resolve(asRecord(JSON.parse(output)));
      } catch {
        reject(new Error(`Knowledge Coach returned invalid JSON: ${output.slice(0, 600)}`));
      }
    });
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

function validateTarget(value: string): string {
  const target = value.replaceAll("\\", "/").replace(/^\/+/u, "").trim();
  if (
    !target.endsWith(".md")
    || !target.startsWith("10_活跃知识/概念/")
    || target.includes("../")
  ) {
    throw httpError(400, "首版发布目标必须位于 10_活跃知识/概念/ 且以 .md 结尾");
  }
  return target;
}

function cleanTitle(value: string): string {
  const title = String(value || "").replace(/\s+/gu, " ").trim();
  if (!title) throw httpError(400, "标题不能为空");
  return title.slice(0, 120);
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/gu, "-").replace(/\.+$/u, "").slice(0, 100) || "未命名概念";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
