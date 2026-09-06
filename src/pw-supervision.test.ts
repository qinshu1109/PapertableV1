/**
 * TASK-PW-27 监督断言测试。
 * 覆盖执行规格第二节：内存库夹具五条——合规 ai_exec 过 / 缺指令 ai_exec 被抓 /
 * ai_auto corpus 过 / ai_auto 非白名单被抓 / 空库 ok；外加合并审计语义一组。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  auditPwAutoWhitelist,
  auditPwExecInstructions,
  runPwHarnessAudit,
} from "./pw-supervision.ts";
import { ensurePwRunTables, recordPwEvent, recordPwExecEvent } from "./pw-runs.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  return db;
}

/** 绕过 recordPwExecEvent 守门直接落违规 ai_exec 行（模拟历史/损坏行，审计专门抓这种）。 */
function insertExecRow(
  db: DatabaseSync,
  row: {
    id: string;
    eventType: string;
    createdAt: string;
    instructionText?: string | null;
    instructionMessageId?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO pw_runs(
      id, kind, event_type, actor, payload_json, payload_hash,
      parent_id, related_ids_json, bet_id, created_at, instruction_text, instruction_message_id
    ) VALUES (?, 'ai_exec', ?, 'ai', '{}', 'hash', NULL, '[]', NULL, ?, ?, ?)
  `).run(
    row.id,
    row.eventType,
    row.createdAt,
    row.instructionText ?? null,
    row.instructionMessageId ?? null,
  );
}

test("合规 ai_exec（带指令）过：auditPwExecInstructions 与合并审计均零违规", () => {
  const db = makeDb();
  try {
    recordPwExecEvent(db, {
      eventType: "edit",
      betId: "bet-1",
      instructionText: "把标题改成 X",
      instructionMessageId: "msg-9",
      payloadJson: JSON.stringify({ betId: "bet-1", fields: { title: "X" } }),
      createdAt: "2026-08-06T01:00:00.000Z",
    });
    recordPwExecEvent(db, {
      eventType: "settle",
      betId: "bet-1",
      instructionText: "把结账草案一步结掉",
      instructionMessageId: "msg-10",
      payloadJson: "{}",
      createdAt: "2026-08-06T02:00:00.000Z",
    });

    assert.deepEqual(auditPwExecInstructions(db), []);
    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    db.close();
  }
});

test("缺指令 ai_exec 被抓：instruction_text 为空即违规，reason 点明缺失列", () => {
  const db = makeDb();
  try {
    insertExecRow(db, {
      id: "exec-bad-1",
      eventType: "edit",
      createdAt: "2026-08-06T03:00:00.000Z",
      instructionText: "  ",
      instructionMessageId: "msg-11",
    });
    insertExecRow(db, {
      id: "exec-bad-2",
      eventType: "voice",
      createdAt: "2026-08-06T04:00:00.000Z",
      instructionText: "录一条声音",
      instructionMessageId: "",
    });

    const violations = auditPwExecInstructions(db);
    assert.equal(violations.length, 2);
    assert.equal(violations[0].id, "exec-bad-1");
    assert.equal(violations[0].kind, "ai_exec");
    assert.equal(violations[0].event_type, "edit");
    assert.ok(violations[0].reason.includes("instruction_text"), violations[0].reason);
    assert.ok(violations[0].reason.includes("擅自发动"), violations[0].reason);
    assert.equal(violations[1].id, "exec-bad-2");
    assert.ok(violations[1].reason.includes("instruction_message_id"), violations[1].reason);

    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 2);
  } finally {
    db.close();
  }
});

test("ai_auto corpus 过：白名单内不违规", () => {
  const db = makeDb();
  try {
    recordPwEvent(db, {
      kind: "ai_auto",
      eventType: "corpus",
      actor: "ai",
      payloadJson: JSON.stringify({ bvid: "BV0000000001" }),
      createdAt: "2026-08-06T05:00:00.000Z",
    });

    assert.deepEqual(auditPwAutoWhitelist(db), []);
    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    db.close();
  }
});

test("ai_auto 非白名单被抓：event_type 不在白名单即违规", () => {
  const db = makeDb();
  try {
    recordPwEvent(db, {
      kind: "ai_auto",
      eventType: "edit",
      actor: "ai",
      payloadJson: "{}",
      createdAt: "2026-08-06T06:00:00.000Z",
    });

    const violations = auditPwAutoWhitelist(db);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "ai_auto");
    assert.equal(violations[0].event_type, "edit");
    assert.ok(violations[0].reason.includes("白名单"), violations[0].reason);
    assert.ok(violations[0].reason.includes("corpus"), violations[0].reason);

    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
  } finally {
    db.close();
  }
});

test("空库 ok：两条断言与合并审计均零违规", () => {
  const db = makeDb();
  try {
    assert.deepEqual(auditPwExecInstructions(db), []);
    assert.deepEqual(auditPwAutoWhitelist(db), []);
    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, true);
    assert.deepEqual(result.violations, []);
  } finally {
    db.close();
  }
});

test("合并：两类违规汇总，ok 与违规数联动，顺序按 created_at 稳定", () => {
  const db = makeDb();
  try {
    // 混合库：一条合规、一条 ai_exec 缺指令、一条 ai_auto 白名单外
    recordPwExecEvent(db, {
      eventType: "confirm",
      instructionText: "确认转正",
      instructionMessageId: "msg-12",
      payloadJson: "{}",
      createdAt: "2026-08-06T07:00:00.000Z",
    });
    insertExecRow(db, {
      id: "exec-bad-3",
      eventType: "undo",
      createdAt: "2026-08-06T08:00:00.000Z",
    });
    recordPwEvent(db, {
      id: "auto-bad-1",
      kind: "ai_auto",
      eventType: "voice",
      actor: "ai",
      payloadJson: "{}",
      createdAt: "2026-08-06T09:00:00.000Z",
    });

    const result = runPwHarnessAudit(db);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 2);
    assert.deepEqual(result.violations.map((v) => v.id), ["exec-bad-3", "auto-bad-1"]);
    assert.ok(result.violations.every((v) => v.created_at && v.event_type && v.reason));

    // 稳定可重复：二次运行结果一致
    assert.deepEqual(runPwHarnessAudit(db), result);
  } finally {
    db.close();
  }
});
