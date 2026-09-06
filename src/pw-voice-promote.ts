/**
 * TASK-PW-45：观众声音提升链——原文逐字提升为协作台候选卡草稿（回收 → 生产跨域）。
 *
 * 纪律（写进代码的纪律）：
 * - 提请即产卡：人主动提（声音屏按钮 / 对话指令），不走筛子的排序公式——
 *   scale_value=0、sort_score=0（0 分沉底可接受，候选区照常展示）。
 * - 防重：promoted_to_draft_id 非空拒绝；已丢弃（dropped_reason 非空）拒绝；噪音拒绝。
 * - kind 映射：content_critique（批评=说得狠的异类信号）→ wildcard 进少数派区；
 *   其余（topic_lead / form_suggestion / NULL 未分拣）→ normal 证据区。
 * - 哨兵 run：trigger_source='voice_promotion'、direction 取提请时点的当前快照、
 *   model=NULL、created_at=finished_at 同刻（照 pw-sieve.ts run 范式直写）。
 * - 账：audit（AI exec 工具）→ recordPwExecEvent 一条 ai_exec(voice)；
 *   缺省（屏幕按钮）→ recordPwEvent human(voice)；payload 同形（voiceId/cardId/runId）。
 * - 哨兵 run + 卡 + 回写同生共死（一个事务），成了才有账。
 *
 * TASK-PW-46：语料评论只读展出与一键收录（双通路）——评论真值留语料库（落盘 comments.jsonl），
 * 声音行只存原文快照与出处（platform='bilibili:{bvid}'），与手动录入同构；
 * 收录即分拣（PW-26 自动分拣挂钩自然触发）；dropped 旧条不参与防重（人丢过的允许再收）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { httpError, nowIso } from "./data.ts";
import { getPwCorpusDoc, readPwCorpusComments, type PwCorpusCommentDetail } from "./pw-corpus.ts";
import { getSieveDirection, type PwSieveCardRow } from "./pw-sieve.ts";
import { recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";
import { addPwVoiceItem, type PwVoiceAudit, type PwVoiceRow } from "./pw-voice.ts";

/** 观众声音伪来源标记（与筛子 VOICE_BVID 同值）：声音没有 BV 号，quote_source.bvid 用该固定值区分。 */
const VOICE_BVID = "voice";

export type PwVoicePromoteResult = {
  runId: string;
  card: PwSieveCardRow;
};

/**
 * TASK-PW-45：把一条观众声音逐字提升为候选卡草稿（人主动提请，跨域写生产侧）。
 * 校验三连 409（已丢弃 / 噪音 / 已提升带既有卡 id）；条目不存在 404。
 * 写操作（哨兵 run + 卡 + 回写）包一个事务；账在提交后按 audit 两路落。
 */
export function promotePwVoiceToCard(
  db: DatabaseSync,
  voiceId: string,
  audit?: PwVoiceAudit,
): PwVoicePromoteResult {
  const voice = requireVoiceItem(db, voiceId);
  if (voice.dropped_reason !== null) throw httpError(409, "已丢弃的观众声音不进候选");
  if (voice.signal_type === "noise") throw httpError(409, "噪音不进候选");
  if (voice.promoted_to_draft_id !== null) {
    throw httpError(409, `该声音已提升为候选卡（draft_id=${voice.promoted_to_draft_id}）`);
  }
  // kind 映射：批评=说得狠的异类信号，进少数派区；其余（含未分拣 NULL）进证据区
  const kind = voice.signal_type === "content_critique" ? "wildcard" : "normal";
  const runId = randomUUID();
  const cardId = randomUUID();
  const now = nowIso();
  // 提请时点的方向快照（此后换方向不影响这张卡所在 run 的展示语义）
  const direction = getSieveDirection(db);

  db.exec("BEGIN IMMEDIATE");
  try {
    // 哨兵 run：人主动提请直写，model=NULL、created_at=finished_at 同刻
    db.prepare(`
      INSERT INTO pw_sieve_runs(
        id, trigger_source, input_ids_json, cards_count, dropped_count,
        status, error, model, direction, created_at, finished_at
      ) VALUES(?, 'voice_promotion', ?, 1, 0, 'done', NULL, NULL, ?, ?, ?)
    `).run(runId, JSON.stringify([voiceId]), direction, now, now);
    // 产卡直写：quote_text 逐字；提请链不走排序公式（scale_value=0、sort_score=0）
    db.prepare(`
      INSERT INTO pw_sieve_cards(
        id, run_id, kind, quote_text, quote_source_json, scale_note, scale_value,
        hook_note, freshness_note, sort_score, status, created_at
      ) VALUES(?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0, 'pending', ?)
    `).run(
      cardId,
      runId,
      kind,
      voice.content,
      JSON.stringify({
        bvid: VOICE_BVID,
        uname: `观众声音·${voice.platform}`,
        voice_id: voice.id,
        signal_type: voice.signal_type,
        like: null,
        rpid: null,
      }),
      now,
    );
    // 回写防重：提请过的按钮置灰「已进候选」，不会重复产卡
    db.prepare("UPDATE pw_voice_items SET promoted_to_draft_id = ? WHERE id = ?").run(cardId, voiceId);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original constraint error.
    }
    throw error;
  }

  const payload = { voiceId, cardId, runId };
  if (audit) {
    // TASK-PW-45：AI 经 exec 工具提请——合成一条 ai_exec(voice) 账（eventType 复用 'voice'）
    recordPwExecEvent(db, {
      eventType: "voice",
      instructionText: audit.instructionText,
      instructionMessageId: audit.instructionMessageId,
      payloadJson: JSON.stringify(payload),
    });
  } else {
    // 声音屏按钮提请——human(voice) 账
    recordPwEvent(db, {
      eventType: "voice",
      actor: "human",
      payloadJson: JSON.stringify(payload),
    });
  }
  const card = requireSieveCard(db, cardId);
  return { runId, card };
}

export type PwVoiceCorpusComment = PwCorpusCommentDetail & { collected: boolean };

/**
 * TASK-PW-46：语料评论只读分页展出（回收域内部），每条附 collected 标记——
 * pw_voice_items 存在 `platform='bilibili:{bvid}' AND content=message 逐字
 * AND dropped_reason IS NULL` 即 true。评论真值留语料库，本函数只读不写。
 */
export function listPwVoiceCorpusComments(
  db: DatabaseSync,
  bvid: string,
  options: { offset?: number; limit?: number } = {},
): PwVoiceCorpusComment[] {
  const comments = readPwCorpusComments(db, bvid, options);
  if (comments.length === 0) return [];
  const collectedMessages = new Set<string>();
  const rows = db.prepare(`
    SELECT DISTINCT content FROM pw_voice_items
    WHERE platform = ? AND dropped_reason IS NULL
      AND content IN (${comments.map(() => "?").join(", ")})
  `).all(`bilibili:${bvid}`, ...comments.map((comment) => comment.message)) as Array<{ content: string }>;
  for (const row of rows) collectedMessages.add(row.content);
  return comments.map((comment) => ({
    ...comment,
    collected: collectedMessages.has(comment.message),
  }));
}

export type PwVoiceCollectInput = {
  bvid: string;
  rpid: number;
};

/**
 * TASK-PW-46：一键收录——按 rpid 全量扫语料评论匹配（量级百级，可接受），
 * 找不到 404；已收录（platform + 逐字 content + 未丢弃）409 带既有声音 id；
 * 否则 addPwVoiceItem（platform='bilibili:{bvid}'、content 逐字、author=uname ?? '匿名'、
 * capturedAt=ctime 转 ISO、ctime 为空则用当前刻）——PW-26 自动分拣挂钩自然触发，收录即分拣。
 * dropped 旧条不参与防重（人丢过的允许再收）。
 */
export function collectPwCorpusComment(
  db: DatabaseSync,
  input: PwVoiceCollectInput,
  audit?: PwVoiceAudit,
): PwVoiceRow {
  const bvid = requiredText(input.bvid, "bvid");
  const rpid = input.rpid;
  if (!Number.isInteger(rpid) || rpid < 0) throw httpError(400, "rpid 必须是非负整数");
  const comments = readPwCorpusComments(db, bvid);
  const comment = comments.find((item) => item.rpid === rpid);
  if (!comment) throw httpError(404, `语料评论不存在：rpid=${rpid}`);
  const existing = db.prepare(`
    SELECT id FROM pw_voice_items
    WHERE platform = ? AND content = ? AND dropped_reason IS NULL
    LIMIT 1
  `).get(`bilibili:${bvid}`, comment.message) as { id: string } | undefined;
  if (existing) throw httpError(409, `该评论已收录为观众声音（id=${existing.id}）`);
  const capturedAt = comment.ctime == null
    ? new Date().toISOString()
    : new Date(comment.ctime * 1000).toISOString();
  return addPwVoiceItem(db, {
    platform: `bilibili:${bvid}`,
    content: comment.message,
    author: comment.uname ?? "匿名",
    capturedAt,
  }, audit);
}

/** 读单条声音（写路径与校验用；不存在抛 404）。 */
function requireVoiceItem(db: DatabaseSync, id: string): PwVoiceRow {
  const row = db.prepare("SELECT * FROM pw_voice_items WHERE id = ?").get(id) as PwVoiceRow | undefined;
  if (!row) throw httpError(404, "观众声音不存在");
  return row;
}

/** 读单张候选卡（回写后取回；理论必存在，兜底 500 语义不吞）。 */
function requireSieveCard(db: DatabaseSync, id: string): PwSieveCardRow {
  const row = db.prepare("SELECT * FROM pw_sieve_cards WHERE id = ?").get(id) as PwSieveCardRow | undefined;
  if (!row) throw new Error(`候选卡不存在: ${id}`);
  return row;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(400, `${field} 必填`);
  return value.trim();
}
