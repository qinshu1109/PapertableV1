import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildNotifyPayload,
  computeDueSignals,
  createBetSignal,
  ensurePwNotifyTables,
  listPendingOutbox,
  markOutboxFailed,
  markOutboxSent,
  verifyDispositionToken,
} from "./pw-notify.ts";

const NOW = "2026-08-28T16:00:00.000Z";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwNotifyTables(db);
  ensurePwNotifyTables(db);
  return db;
}

function ensureBets(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pw_bets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      thesis TEXT NOT NULL,
      metric TEXT,
      checkout_date TEXT,
      status TEXT NOT NULL
    );
  `);
}

function insertBet(
  db: DatabaseSync,
  row: { id: string; status: string; checkout_date: string | null; title?: string },
): void {
  ensureBets(db);
  db.prepare(`
    INSERT INTO pw_bets(id, title, thesis, metric, checkout_date, status)
    VALUES(?, ?, 'thesis-secret', 'metric-secret', ?, ?)
  `).run(row.id, row.title ?? `bet-${row.id}`, row.checkout_date, row.status);
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshotCounts(db: DatabaseSync): Record<string, number> {
  return {
    pw_bet_signals: count(db, "pw_bet_signals"),
    pw_notification_outbox: count(db, "pw_notification_outbox"),
    pw_disposition_tokens: count(db, "pw_disposition_tokens"),
  };
}

function sha256Hex(value: string): string {
  return hash("sha256", value, "hex");
}

test("建表幂等且列齐全", () => {
  const db = database();
  try {
    const signalCols = (db.prepare("PRAGMA table_info(pw_bet_signals)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.deepEqual(signalCols, [
      "id",
      "event_uuid",
      "bet_id",
      "kind",
      "observed_at",
      "bet_version",
      "evidence_snapshot_id",
      "reason_json",
      "severity",
      "created_at",
    ]);
    const outboxCols = (db.prepare("PRAGMA table_info(pw_notification_outbox)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.deepEqual(outboxCols, [
      "id",
      "event_uuid",
      "transport",
      "payload_json",
      "attempts",
      "next_attempt_at",
      "sent_at",
      "last_error",
      "created_at",
    ]);
    const tokenCols = (db.prepare("PRAGMA table_info(pw_disposition_tokens)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    assert.deepEqual(tokenCols, [
      "id",
      "token_hash",
      "event_uuid",
      "expires_at",
      "used_at",
      "created_at",
    ]);
  } finally {
    db.close();
  }
});

test("createBetSignal 同事务写入三表", () => {
  const db = database();
  try {
    const result = createBetSignal(db, { betId: "bet-1", kind: "MANUAL_TEST" }, { now: NOW });
    assert.equal(result.alreadyExists, false);
    assert.ok(result.tokenPlaintext);
    assert.equal(result.tokenPlaintext?.length, 32);
    assert.equal(count(db, "pw_bet_signals"), 1);
    assert.equal(count(db, "pw_notification_outbox"), 1);
    assert.equal(count(db, "pw_disposition_tokens"), 1);
    const signal = db.prepare("SELECT * FROM pw_bet_signals").get() as { event_uuid: string; bet_version: number };
    const outbox = db.prepare("SELECT * FROM pw_notification_outbox").get() as { event_uuid: string };
    const token = db.prepare("SELECT * FROM pw_disposition_tokens").get() as { event_uuid: string };
    assert.equal(signal.event_uuid, outbox.event_uuid);
    assert.equal(signal.event_uuid, token.event_uuid);
    assert.equal(signal.bet_version, 1);
  } finally {
    db.close();
  }
});

test("任一步失败则三表全回滚", () => {
  const db = database();
  try {
    db.exec(`
      CREATE TRIGGER pw_notify_test_abort
      AFTER INSERT ON pw_disposition_tokens
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);
    assert.throws(
      () => createBetSignal(db, { betId: "bet-roll", kind: "MANUAL_TEST" }, { now: NOW }),
      /forced rollback/,
    );
    db.exec("DROP TRIGGER pw_notify_test_abort");
    assert.equal(count(db, "pw_bet_signals"), 0);
    assert.equal(count(db, "pw_notification_outbox"), 0);
    assert.equal(count(db, "pw_disposition_tokens"), 0);
  } finally {
    db.close();
  }
});

test("UNIQUE(bet_id, kind, bet_version) 幂等不重复出 outbox", () => {
  const db = database();
  try {
    const first = createBetSignal(db, { betId: "bet-dup", kind: "SETTLEMENT_NEAR" }, { now: NOW });
    const second = createBetSignal(db, { betId: "bet-dup", kind: "SETTLEMENT_NEAR" }, { now: NOW });
    assert.equal(first.alreadyExists, false);
    assert.equal(second.alreadyExists, true);
    assert.equal(second.signal.id, first.signal.id);
    assert.equal(second.signal.event_uuid, first.signal.event_uuid);
    assert.equal(second.tokenPlaintext, undefined);
    assert.equal(count(db, "pw_bet_signals"), 1);
    assert.equal(count(db, "pw_notification_outbox"), 1);
    assert.equal(count(db, "pw_disposition_tokens"), 1);
  } finally {
    db.close();
  }
});

test("token 只存 sha256 hash，verify 三态正确", () => {
  const db = database();
  try {
    const created = createBetSignal(db, { betId: "bet-tok", kind: "MANUAL_TEST" }, {
      now: NOW,
      tokenTtlHours: 48,
    });
    const plaintext = created.tokenPlaintext!;
    const stored = db.prepare("SELECT token_hash, event_uuid FROM pw_disposition_tokens").get() as {
      token_hash: string;
      event_uuid: string;
    };
    assert.equal(stored.token_hash, sha256Hex(plaintext));
    assert.equal(stored.token_hash.includes(plaintext), false);
    const dump = JSON.stringify(db.prepare("SELECT * FROM pw_disposition_tokens").all());
    assert.equal(dump.includes(plaintext), false);

    assert.equal(verifyDispositionToken(db, "deadbeef", NOW).status, "not_found");

    const ok = verifyDispositionToken(db, plaintext, NOW);
    assert.equal(ok.status, "ok");
    if (ok.status === "ok") {
      assert.equal(ok.eventUuid, stored.event_uuid);
      assert.equal(ok.signal.betId, "bet-tok");
      assert.equal(ok.signal.kind, "MANUAL_TEST");
    }

    const expired = verifyDispositionToken(db, plaintext, "2026-08-31T16:00:00.000Z");
    assert.equal(expired.status, "expired");
  } finally {
    db.close();
  }
});

test("verifyDispositionToken 读路径零写入", () => {
  const db = database();
  try {
    const created = createBetSignal(db, { betId: "bet-ro", kind: "MANUAL_TEST" }, { now: NOW });
    const before = snapshotCounts(db);
    const tokenRow = db.prepare("SELECT used_at FROM pw_disposition_tokens").get() as { used_at: string | null };
    assert.equal(tokenRow.used_at, null);

    verifyDispositionToken(db, created.tokenPlaintext!, NOW);
    verifyDispositionToken(db, "missing", NOW);
    verifyDispositionToken(db, created.tokenPlaintext!, "2026-09-01T00:00:00.000Z");

    assert.deepEqual(snapshotCounts(db), before);
    const after = db.prepare("SELECT used_at FROM pw_disposition_tokens").get() as { used_at: string | null };
    assert.equal(after.used_at, null);
  } finally {
    db.close();
  }
});

test("失败退避 1 分钟 × 2^(attempts-1)，上限 30 分钟", () => {
  const db = database();
  try {
    createBetSignal(db, { betId: "bet-bo", kind: "MANUAL_TEST" }, { now: NOW });
    const pending = listPendingOutbox(db, NOW);
    assert.equal(pending.length, 1);
    const id = pending[0].id;

    const fail1 = markOutboxFailed(db, id, "e1", { now: NOW });
    assert.equal(fail1.attempts, 1);
    assert.equal(fail1.next_attempt_at, "2026-08-28T16:01:00.000Z");
    assert.equal(listPendingOutbox(db, NOW).length, 0);
    assert.equal(listPendingOutbox(db, fail1.next_attempt_at).length, 1);

    const fail2 = markOutboxFailed(db, id, "e2", { now: fail1.next_attempt_at });
    assert.equal(fail2.attempts, 2);
    assert.equal(fail2.next_attempt_at, "2026-08-28T16:03:00.000Z");

    let last = fail2;
    for (let n = 3; n <= 6; n++) {
      last = markOutboxFailed(db, id, `e${n}`, { now: last.next_attempt_at });
    }
    assert.equal(last.attempts, 6);
    const delayMs = Date.parse(last.next_attempt_at) - Date.parse("2026-08-28T16:31:00.000Z");
    // attempts=6 → 2^5=32 min capped at 30; now at that step is 16:31 after previous delays
    assert.equal(delayMs, 30 * 60 * 1000);

    markOutboxSent(db, id, "2026-08-28T17:10:00.000Z");
    assert.equal(listPendingOutbox(db, "2026-08-28T18:00:00.000Z").length, 0);
  } finally {
    db.close();
  }
});

test("payload 标题固定且不含押注全文", () => {
  const db = database();
  try {
    const bet = {
      id: "bet-full",
      title: "秘密标题不得入卡",
      thesis: "秘密假设不得入卡",
      metric: "秘密指标不得入卡",
    };
    const created = createBetSignal(db, { betId: bet.id, kind: "SETTLEMENT_NEAR" }, {
      now: NOW,
      baseUrl: "https://dsh.cozai.net",
    });
    const payload = buildNotifyPayload(
      created.signal,
      bet,
      created.tokenPlaintext!,
      "https://dsh.cozai.net",
    );
    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes("秘密标题不得入卡"), false);
    assert.equal(encoded.includes("秘密假设不得入卡"), false);
    assert.equal(encoded.includes("秘密指标不得入卡"), false);
    assert.equal(encoded.includes("押注状态变化"), true);
    assert.equal(encoded.includes("结账日临近"), true);
    assert.equal(encoded.includes("查看证据"), true);
    assert.equal(encoded.includes(`https://dsh.cozai.net/n/${created.tokenPlaintext}`), true);

    const stored = db.prepare("SELECT payload_json FROM pw_notification_outbox").get() as { payload_json: string };
    assert.equal(stored.payload_json.includes("秘密"), false);
    assert.equal(stored.payload_json.includes("押注状态变化"), true);

    const testPayload = buildNotifyPayload(
      { kind: "MANUAL_TEST" },
      bet,
      "aa".repeat(16),
      "https://dsh.cozai.net",
    );
    assert.equal(JSON.stringify(testPayload).includes("测试信号"), true);
  } finally {
    db.close();
  }
});

test("computeDueSignals 只选窗口内 pending，重复跑幂等", () => {
  const db = database();
  try {
    ensureBets(db);
    insertBet(db, { id: "due-soon", status: "pending", checkout_date: "2026-08-29T10:00:00.000Z" });
    insertBet(db, { id: "due-expired", status: "pending", checkout_date: "2026-08-01" });
    insertBet(db, { id: "due-later", status: "pending", checkout_date: "2026-09-10T00:00:00.000Z" });
    insertBet(db, { id: "due-draft", status: "draft", checkout_date: "2026-08-29T10:00:00.000Z" });
    insertBet(db, { id: "due-null", status: "pending", checkout_date: null });

    const first = computeDueSignals(db, { now: NOW, leadHours: 24 });
    const ids = first.map((r) => r.signal.bet_id).sort();
    assert.deepEqual(ids, ["due-expired", "due-soon"]);
    assert.equal(first.every((r) => r.alreadyExists === false), true);
    assert.equal(count(db, "pw_bet_signals"), 2);
    assert.equal(count(db, "pw_notification_outbox"), 2);

    const second = computeDueSignals(db, { now: NOW, leadHours: 24 });
    assert.equal(second.length, 2);
    assert.equal(second.every((r) => r.alreadyExists === true), true);
    assert.equal(count(db, "pw_bet_signals"), 2);
    assert.equal(count(db, "pw_notification_outbox"), 2);
    assert.equal(count(db, "pw_disposition_tokens"), 2);
  } finally {
    db.close();
  }
});
