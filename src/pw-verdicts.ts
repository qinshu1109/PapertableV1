import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError } from "./data.ts";
import { recordPwRecallEvent } from "./pw-recall-events.ts";
import { recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";

export type PwOutcome = "gold" | "tomb" | "void";

export type PwVerdictRow = {
  id: string;
  bet_id: string;
  outcome: PwOutcome;
  lesson: string | null;
  cause_of_death: string | null;
  evidence_doc_ids_json: string;
  confidence_snapshot: number | null;
  decided_by: "human";
  decided_at: string;
  created_at: string;
};

export type PwSettlementInput = {
  outcome: PwOutcome;
  lesson?: string | null;
  causeOfDeath?: string | null;
  cause_of_death?: string | null;
  evidenceDocIds?: readonly string[];
  evidence_doc_ids?: readonly string[];
  decidedAt?: string;
  decided_at?: string;
  decidedBy?: string;
  decided_by?: string;
  asOfDate?: string;
};

export function ensurePwVerdictTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_verdicts (
      id TEXT PRIMARY KEY,
      bet_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('gold','tomb','void')),
      lesson TEXT,
      cause_of_death TEXT,
      evidence_doc_ids_json TEXT NOT NULL DEFAULT '[]',
      confidence_snapshot INTEGER,
      decided_by TEXT NOT NULL DEFAULT 'human' CHECK(decided_by = 'human'),
      decided_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pw_verdicts_one_non_void
      ON pw_verdicts(bet_id) WHERE outcome <> 'void';
  `);
}

export function settlePwBet(
  db: DatabaseSync,
  betId: string,
  input: PwSettlementInput,
): PwVerdictRow {
  const outcome = input.outcome;
  if (!isOutcome(outcome)) throw new Error("outcome must be gold, tomb, or void");

  const lesson = textOrNull(input.lesson);
  const causeOfDeath = textOrNull(input.causeOfDeath ?? input.cause_of_death);
  const evidenceDocIds = input.evidenceDocIds ?? input.evidence_doc_ids ?? [];
  if (!Array.isArray(evidenceDocIds) || evidenceDocIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("evidence_doc_ids must be an array of non-empty strings");
  }
  if (outcome === "gold" && !lesson) throw new Error("gold requires lesson");
  if (outcome === "tomb" && !causeOfDeath) throw new Error("tomb requires cause_of_death");
  if (outcome !== "void" && evidenceDocIds.length === 0) {
    throw new Error("gold and tomb require evidence_doc_ids");
  }

  const asOfDate = input.asOfDate ?? today();
  const decidedAt = input.decidedAt ?? input.decided_at ?? new Date().toISOString();
  const decidedBy = input.decidedBy ?? input.decided_by ?? "human";
  db.exec("BEGIN IMMEDIATE");
  try {
    const bet = db.prepare("SELECT status, checkout_date, confidence FROM pw_bets WHERE id = ?")
      .get(betId) as {
        status: string;
        checkout_date: string | null;
        confidence: number | null;
      } | undefined;
    if (!bet) throw new Error(`押注不存在：${betId}`);

    const nonVoid = db.prepare(
      "SELECT 1 FROM pw_verdicts WHERE bet_id = ? AND outcome <> 'void' LIMIT 1",
    ).get(betId);
    const canRetryAfterVoid = bet.status === "void" && !nonVoid;
    if (bet.status !== "pending" && !canRetryAfterVoid) {
      throw new Error("押注不是 pending，不能结账");
    }
    const due = db.prepare("SELECT date(?) <= date(?) AS due")
      .get(bet.checkout_date, asOfDate) as { due: number };
    if (!bet.checkout_date || !Number(due.due)) throw new Error("押注尚未到结账日");
    if (nonVoid) throw new Error("一张押注只允许一条非 void 结账记录");

    if (evidenceDocIds.length > 0) {
      const placeholders = evidenceDocIds.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT id FROM pw_data_docs WHERE id IN (${placeholders})
      `).all(...evidenceDocIds) as Array<{ id: string }>;
      if (new Set(rows.map((row) => row.id)).size !== new Set(evidenceDocIds).size) {
        throw new Error("引用的数据文档不存在");
      }
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO pw_verdicts(
        id, bet_id, outcome, lesson, cause_of_death, evidence_doc_ids_json,
        confidence_snapshot, decided_by, decided_at, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      betId,
      outcome,
      lesson,
      causeOfDeath,
      JSON.stringify(evidenceDocIds),
      bet.confidence,
      decidedBy,
      decidedAt,
      new Date().toISOString(),
    );
    db.prepare(
      "UPDATE pw_bets SET status = ?, settled_verdict_id = ? WHERE id = ?",
    ).run(outcome === "void" ? "void" : "settled", id, betId);
    // TASK-PW-12：结账归因——对押注已 attached 的笔记每条记 settled（surface=verdict）。
    // void 作废不是「用上」，不记。pw_verdict_refs 目前只挂 collab_message/content_draft
    // （无 note_uid），映射不到笔记，故以 pw_note_attach 为准；将来若 refs 带笔记标识再优先按 refs。
    if (outcome !== "void") {
      const hasAttachTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pw_note_attach'",
      ).get();
      if (hasAttachTable) {
        const attachedNotes = db.prepare(
          "SELECT note_uid FROM pw_note_attach WHERE bet_id = ? AND status = 'confirmed'",
        ).all(betId) as Array<{ note_uid: string }>;
        for (const row of attachedNotes) {
          recordPwRecallEvent(db, {
            eventKind: "settled",
            surface: "verdict",
            betId,
            noteUid: row.note_uid,
          });
        }
      }
    }
    db.exec("COMMIT");
    return db.prepare("SELECT * FROM pw_verdicts WHERE id = ?").get(id) as PwVerdictRow;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint or validation error.
    }
    throw error;
  }
}

/** TASK-PW-25：结账作废的 AI 执行审计（照 addPwVoiceItem 先例）。 */
export type PwSettlementAudit = {
  actor: "ai";
  instructionText: string;
  instructionMessageId: string;
};

/**
 * TASK-PW-25：冲正键——作废一笔已结账的押注（不改 settlePwBet）。
 * 事务内：押注必须 status='settled'（否则 409）；其非 void 判决（唯一索引保证至多一条）
 * outcome→'void'（lesson/cause_of_death 原文保留）；押注 status→'void'、
 * settled_verdict_id 保留（历史指针不抹）。自记账一条 undo。
 * 重结语义复用既有 canRetryAfterVoid 通路，不加新逻辑。
 */
export function voidPwSettlement(
  db: DatabaseSync,
  betId: string,
  audit?: PwSettlementAudit,
): PwVerdictRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    const bet = db.prepare("SELECT status, settled_verdict_id FROM pw_bets WHERE id = ?")
      .get(betId) as { status: string; settled_verdict_id: string | null } | undefined;
    if (!bet) throw httpError(404, "押注不存在");
    if (bet.status !== "settled") throw httpError(409, "仅 settled 押注可作废结账");
    const verdict = db.prepare(
      "SELECT * FROM pw_verdicts WHERE bet_id = ? AND outcome <> 'void' LIMIT 1",
    ).get(betId) as PwVerdictRow | undefined;
    if (!verdict) throw httpError(409, "押注无生效判决可作废");

    db.prepare("UPDATE pw_verdicts SET outcome = 'void' WHERE id = ?").run(verdict.id);
    db.prepare("UPDATE pw_bets SET status = 'void' WHERE id = ?").run(betId);

    if (audit) {
      recordPwExecEvent(db, {
        eventType: "undo",
        instructionText: audit.instructionText,
        instructionMessageId: audit.instructionMessageId,
        betId,
        payloadJson: JSON.stringify({ betId, verdictId: verdict.id }),
      });
    } else {
      recordPwEvent(db, {
        eventType: "undo",
        actor: "human",
        betId,
        payloadJson: JSON.stringify({ betId, verdictId: verdict.id }),
      });
    }
    db.exec("COMMIT");
    return db.prepare("SELECT * FROM pw_verdicts WHERE id = ?").get(verdict.id) as PwVerdictRow;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint or validation error.
    }
    throw error;
  }
}

export function listDuePwBets(db: DatabaseSync, asOfDate: string): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT * FROM pw_bets
    WHERE status = 'pending' AND checkout_date IS NOT NULL
      AND date(checkout_date) <= date(?)
    ORDER BY checkout_date, created_at
  `).all(asOfDate) as Array<Record<string, unknown>>;
}

export function listPwVerdicts(
  db: DatabaseSync,
  options: { outcome?: PwOutcome } = {},
): PwVerdictRow[] {
  if (options.outcome !== undefined && !isOutcome(options.outcome)) {
    throw new Error("outcome must be gold, tomb, or void");
  }
  if (options.outcome === undefined) {
    return db.prepare("SELECT * FROM pw_verdicts ORDER BY decided_at, created_at")
      .all() as PwVerdictRow[];
  }
  return db.prepare(
    "SELECT * FROM pw_verdicts WHERE outcome = ? ORDER BY decided_at, created_at",
  ).all(options.outcome) as PwVerdictRow[];
}

export function searchPwVerdicts(db: DatabaseSync, keyword: string): PwVerdictRow[] {
  const pattern = `%${keyword}%`;
  return db.prepare(`
    SELECT * FROM pw_verdicts
    WHERE id LIKE ? OR bet_id LIKE ? OR lesson LIKE ? OR cause_of_death LIKE ?
    ORDER BY decided_at, created_at
  `).all(pattern, pattern, pattern, pattern) as PwVerdictRow[];
}

export function tombstoneCauseStats(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare(`
    SELECT cause_of_death, COUNT(*) AS count
    FROM pw_verdicts
    WHERE outcome = 'tomb'
    GROUP BY cause_of_death
    ORDER BY cause_of_death
  `).all() as Array<{ cause_of_death: string | null; count: number }>;
  return Object.fromEntries(
    rows.map((row) => [row.cause_of_death ?? "", Number(row.count)]),
  );
}

export type PwVerdictEvidenceDoc = {
  id: string;
  platform: string;
  collected_at: string;
  /** metrics_json 的紧凑 JSON 摘要（单行，供回显） */
  metrics: string;
};

export type PwVerdictDetail = PwVerdictRow & {
  /** 来源押注标题（押注行已删时 null） */
  bet_title: string | null;
  /** evidence_doc_ids 解析后按原顺序联查的数据文档摘要 */
  evidence_docs: PwVerdictEvidenceDoc[];
};

/**
 * TASK-PW-17：判决详情读取——verdict 整行 + evidence_doc_ids 解析并联查
 * pw_data_docs 摘要（平台/采集时间/metrics 紧凑 JSON）+ 来源押注标题。只读。
 */
export function getPwVerdictDetail(db: DatabaseSync, id: string): PwVerdictDetail {
  const verdict = db.prepare("SELECT * FROM pw_verdicts WHERE id = ?").get(id) as
    | PwVerdictRow
    | undefined;
  if (!verdict) throw httpError(404, "判决不存在");

  const evidenceIds = parseEvidenceIds(verdict.evidence_doc_ids_json);
  const evidenceDocs: PwVerdictEvidenceDoc[] = [];
  if (evidenceIds.length > 0) {
    const placeholders = evidenceIds.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT id, platform, collected_at, metrics_json
      FROM pw_data_docs
      WHERE id IN (${placeholders})
    `).all(...evidenceIds) as Array<{
      id: string;
      platform: string;
      collected_at: string;
      metrics_json: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const evidenceId of evidenceIds) {
      const row = byId.get(evidenceId);
      if (!row) continue;
      evidenceDocs.push({
        id: row.id,
        platform: row.platform,
        collected_at: row.collected_at,
        metrics: compactJson(row.metrics_json),
      });
    }
  }

  const bet = db.prepare("SELECT title FROM pw_bets WHERE id = ?").get(verdict.bet_id) as
    | { title: string }
    | undefined;
  return { ...verdict, bet_title: bet?.title ?? null, evidence_docs: evidenceDocs };
}

function parseEvidenceIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function compactJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
}

function isOutcome(value: unknown): value is PwOutcome {
  return value === "gold" || value === "tomb" || value === "void";
}

function textOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text || null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
