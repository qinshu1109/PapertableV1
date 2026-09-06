/**
 * TASK-PW-27 监督断言（规格《Harness 写权限边界》§6 店规 A 的自动判定）。
 *
 * 两条断言：
 *  - auditPwExecInstructions：擅自发动断言——kind='ai_exec' 的账行缺人指令引用
 *    （instruction_text / instruction_message_id 任一为空）即违规；exec=人发话，无引用即擅自发动。
 *  - auditPwAutoWhitelist：自主档白名单——kind='ai_auto' 的 event_type 不在白名单
 *    （当前仅 'corpus'）即违规；自主档扩张必须显式加白名单，防默许漂移。
 *
 * 范围外：ai_draft 不查指令（draft 档本无指令列属设计）；
 * human/system/manual_event/sync/sieve 不在本断言范围。
 *
 * 只读查询，不改库；runPwHarnessAudit 合并两类违规，ok = 零违规。
 */
import type { DatabaseSync } from "node:sqlite";

export type PwAuditViolation = {
  id: string;
  kind: string;
  event_type: string;
  created_at: string;
  reason: string;
};

/** 自主档白名单（显式列明，扩张时在此加白并连带测试）。 */
export const PW_AUTO_WHITELIST: readonly string[] = ["corpus"];

type PwRunAuditRow = {
  id: string;
  kind: string;
  event_type: string;
  created_at: string;
  instruction_text: string | null;
  instruction_message_id: string | null;
};

/**
 * 擅自发动断言：ai_exec 行缺人指令引用即违规。
 * 返回违规明细（created_at 升序）；无违规返回 []。
 */
export function auditPwExecInstructions(db: DatabaseSync): PwAuditViolation[] {
  const rows = db.prepare(`
    SELECT id, kind, event_type, created_at, instruction_text, instruction_message_id
    FROM pw_runs
    WHERE kind = 'ai_exec'
    ORDER BY created_at ASC, rowid ASC
  `).all() as PwRunAuditRow[];

  const violations: PwAuditViolation[] = [];
  for (const row of rows) {
    const missingText = !row.instruction_text || row.instruction_text.trim() === "";
    const missingMessage = !row.instruction_message_id || row.instruction_message_id.trim() === "";
    if (!missingText && !missingMessage) continue;
    const missing = [
      missingText ? "instruction_text" : null,
      missingMessage ? "instruction_message_id" : null,
    ].filter((item): item is string => item !== null).join(" + ");
    violations.push({
      id: row.id,
      kind: row.kind,
      event_type: row.event_type,
      created_at: row.created_at,
      reason: `擅自发动：ai_exec 行缺人指令引用（${missing} 为空）——exec=人发话，无引用即违规`,
    });
  }
  return violations;
}

/**
 * 自主档白名单断言：ai_auto 行 event_type 不在白名单即违规。
 * 返回违规明细（created_at 升序）；无违规返回 []。
 */
export function auditPwAutoWhitelist(db: DatabaseSync): PwAuditViolation[] {
  const whitelist = PW_AUTO_WHITELIST.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, kind, event_type, created_at
    FROM pw_runs
    WHERE kind = 'ai_auto' AND event_type NOT IN (${whitelist})
    ORDER BY created_at ASC, rowid ASC
  `).all(...PW_AUTO_WHITELIST) as Array<Omit<PwRunAuditRow, "instruction_text" | "instruction_message_id">>;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    event_type: row.event_type,
    created_at: row.created_at,
    reason: `自主档白名单外：ai_auto event_type='${row.event_type}' 不在白名单 ${JSON.stringify(PW_AUTO_WHITELIST)}——自主档扩张必须显式加白名单`,
  }));
}

/** 合并审计：ok = 零违规；违规按 created_at 升序、同刻按 id 升序，输出稳定可重复。 */
export function runPwHarnessAudit(db: DatabaseSync): { ok: boolean; violations: PwAuditViolation[] } {
  const violations = [
    ...auditPwExecInstructions(db),
    ...auditPwAutoWhitelist(db),
  ].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  );
  return { ok: violations.length === 0, violations };
}
