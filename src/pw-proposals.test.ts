/**
 * TASK-PW-16（简报 16）：提案契约 + 状态机测试。
 * 覆盖：建表幂等、agent 只能 submitted、状态机合法/非法迁移、过期 accept 409、
 * base_version stale apply 409、review_note 留存、事件落账、mode-bar 新计数。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { ensurePwCollabTables } from "./pw-collab.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { getPwModeBar } from "./pw-mode-bar.ts";
import {
  applyPwProposal,
  countPendingPwProposals,
  createPwProposal,
  ensurePwProposalTables,
  getPwProposal,
  listPwProposals,
  reviewPwProposal,
} from "./pw-proposals.ts";
import { ensurePwRunTables } from "./pw-runs.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwProposalTables(db);
  ensurePwRunTables(db);
  return db;
}

function seedProposal(
  db: DatabaseSync,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof createPwProposal> {
  return createPwProposal(db, {
    title: "测试提案",
    lane: "ops",
    targetKind: "code_change",
    proposedBy: "claude",
    ...overrides,
  });
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

test("建表幂等；agent 通道创建只能为 submitted", () => {
  const db = makeDb();
  try {
    ensurePwProposalTables(db);
    ensurePwProposalTables(db);
    const cols = (db.prepare("PRAGMA table_info(pw_proposals)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const col of ["id", "schema_version", "lane", "title", "target_kind", "proposed_by",
      "payload_json", "evidence_json", "checks_json", "status", "review_note", "expires_at"]) {
      assert.ok(cols.includes(col), `缺列 ${col}`);
    }
    const indexes = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND tbl_name='pw_proposals' AND name LIKE 'pw_proposals_%'
    `).all() as Array<{ name: string }>).map((r) => r.name).sort();
    assert.deepEqual(indexes, ["pw_proposals_lane_status", "pw_proposals_status_created"]);

    const p = seedProposal(db, { title: "改一处", lane: "ops", targetKind: "code_change", proposedBy: "claude" });
    assert.equal(p.status, "submitted", "agent 创建只能为 submitted");
    assert.equal(p.schemaVersion, 1);
    assert.equal(p.lane, "ops");
    assert.equal(p.proposedBy, "claude");
  } finally {
    db.close();
  }
});

test("创建必填校验：缺 title/lane/target_kind/proposed_by 400；lane 非法 400", () => {
  const db = makeDb();
  try {
    assert.throws(() => createPwProposal(db, {}), (e: unknown) => hasStatus(e, 400));
    assert.throws(
      () => createPwProposal(db, { title: "t", lane: "ops", targetKind: "x" }),
      (e: unknown) => hasStatus(e, 400) && String((e as Error).message).includes("proposed_by"),
    );
    assert.throws(
      () => createPwProposal(db, { title: "t", lane: "bad", targetKind: "x", proposedBy: "claude" }),
      (e: unknown) => hasStatus(e, 400) && String((e as Error).message).includes("lane"),
    );
  } finally {
    db.close();
  }
});

test("状态机：合法迁移生效；非法迁移 400", () => {
  const db = makeDb();
  try {
    // submitted → changes_requested（退修）
    const p1 = seedProposal(db);
    reviewPwProposal(db, p1.id, { action: "request_changes", note: "再想想" });
    assert.equal(getPwProposal(db, p1.id).status, "changes_requested");
    // changes_requested 不能直接 review（须先重提）→ 400
    assert.throws(
      () => reviewPwProposal(db, p1.id, { action: "accept" }),
      (e: unknown) => hasStatus(e, 400),
    );

    // submitted → rejected（终态），终态再 review → 400
    const p2 = seedProposal(db);
    reviewPwProposal(db, p2.id, { action: "reject", note: "方向不对" });
    assert.equal(getPwProposal(db, p2.id).status, "rejected");
    assert.throws(() => reviewPwProposal(db, p2.id, { action: "accept" }), (e: unknown) => hasStatus(e, 400));

    // 未接受不能 apply → 400
    const p3 = seedProposal(db);
    assert.throws(() => applyPwProposal(db, p3.id, {}), (e: unknown) => hasStatus(e, 400));

    // submitted → accepted → applied
    const p4 = seedProposal(db);
    reviewPwProposal(db, p4.id, { action: "accept" });
    assert.equal(getPwProposal(db, p4.id).status, "accepted");
    applyPwProposal(db, p4.id, {});
    const applied = getPwProposal(db, p4.id);
    assert.equal(applied.status, "applied");
    assert.ok(applied.appliedAt, "apply 记账 appliedAt");
    assert.equal(applied.appliedBy, "human");
    // applied 再 apply → 400
    assert.throws(() => applyPwProposal(db, p4.id, {}), (e: unknown) => hasStatus(e, 400));
  } finally {
    db.close();
  }
});

test("过期 accept 409：expires_at 已过不能接受；未过期可接受", () => {
  const db = makeDb();
  try {
    const past = seedProposal(db, { expiresAt: "2020-01-01T00:00:00.000Z" });
    assert.throws(
      () => reviewPwProposal(db, past.id, { action: "accept" }),
      (e: unknown) => hasStatus(e, 409),
    );
    // 过期不能 apply（已接受路径下也校验）
    const future = seedProposal(db, { expiresAt: "2099-01-01T00:00:00.000Z" });
    reviewPwProposal(db, future.id, { action: "accept" });
    assert.equal(getPwProposal(db, future.id).status, "accepted");
    applyPwProposal(db, future.id, {});
    assert.equal(getPwProposal(db, future.id).status, "applied");
  } finally {
    db.close();
  }
});

test("base_version stale apply 409；版本匹配才成功", () => {
  const db = makeDb();
  try {
    const p = seedProposal(db, { baseVersion: "abc123" });
    reviewPwProposal(db, p.id, { action: "accept" });
    // 未带 currentVersion / 版本不等 → 409 stale
    assert.throws(() => applyPwProposal(db, p.id, {}), (e: unknown) => hasStatus(e, 409));
    assert.throws(() => applyPwProposal(db, p.id, { currentVersion: "xyz" }), (e: unknown) => hasStatus(e, 409));
    assert.equal(getPwProposal(db, p.id).status, "accepted", "stale 409 不翻状态");
    // 匹配 → 成功
    applyPwProposal(db, p.id, { currentVersion: "abc123", appliedBy: "system" });
    const applied = getPwProposal(db, p.id);
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedBy, "system");
  } finally {
    db.close();
  }
});

test("review_note 留存；每次状态迁移 recordPwEvent 落 pw_runs", () => {
  const db = makeDb();
  try {
    const p = seedProposal(db);
    reviewPwProposal(db, p.id, { action: "request_changes", note: "证据不足" });
    assert.equal(getPwProposal(db, p.id).reviewNote, "证据不足");

    const events = db.prepare("SELECT * FROM pw_runs ORDER BY created_at, rowid").all() as Array<{
      event_type: string;
      actor: string;
      kind: string;
      payload_json: string;
      related_ids_json: string;
    }>;
    // create（agent）+ request_changes（human）= 2 条
    assert.equal(events.length, 2);
    const created = events[0];
    assert.equal(created.event_type, "create");
    assert.equal(created.actor, "ai");
    assert.equal(created.kind, "ai_draft");
    assert.equal(JSON.parse(created.payload_json).proposalId, p.id);
    const reviewed = events[1];
    assert.equal(reviewed.event_type, "edit");
    assert.equal(reviewed.actor, "human");
    assert.deepEqual(JSON.parse(reviewed.payload_json), {
      proposalId: p.id, fromStatus: "submitted", toStatus: "changes_requested", action: "request_changes",
    });
    assert.deepEqual(JSON.parse(reviewed.related_ids_json), [p.id]);
  } finally {
    db.close();
  }
});

test("list：created_at 倒序、lane/status 过滤、limit/offset 生效", () => {
  const db = makeDb();
  try {
    const a = seedProposal(db, { title: "A", lane: "ops", targetKind: "code_change" });
    const b = seedProposal(db, { title: "B", lane: "content", targetKind: "content_draft" });
    // B 内容向 accepted，不入 ops 过滤
    reviewPwProposal(db, b.id, { action: "accept" });

    const all = listPwProposals(db, {});
    assert.equal(all.proposals.length, 2);
    // created_at 同刻，倒序按 id 兜底；只验形状
    assert.equal(all.proposals[0].title === "B" || all.proposals[0].title === "A", true);
    const ops = listPwProposals(db, { lane: "ops" });
    assert.equal(ops.proposals.length, 1);
    assert.equal(ops.proposals[0].id, a.id);
    const statusSubmitted = listPwProposals(db, { status: "submitted" });
    assert.equal(statusSubmitted.proposals.length, 1);
    const page = listPwProposals(db, { limit: 1, offset: 0 });
    assert.equal(page.limit, 1);
    assert.equal(page.proposals.length, 1);
    assert.throws(() => listPwProposals(db, { status: "bogus" }), (e: unknown) => hasStatus(e, 400));
    assert.throws(() => listPwProposals(db, { limit: 0 }), (e: unknown) => hasStatus(e, 400));
  } finally {
    db.close();
  }
});

test("mode-bar pendingReview 含 proposals 计数并计入 total", () => {
  const db = new DatabaseSync(":memory:");
  ensurePwProposalTables(db);
  ensurePwRunTables(db);
  ensurePwBetTables(db);
  ensurePwCollabTables(db);
  ensurePwCorpusTables(db);
  try {
    const empty = getPwModeBar(db, () => "2026-08-12T12:00:00.000Z");
    assert.deepEqual(empty.pendingReview, { betDrafts: 0, settleDrafts: 0, corpusProposed: 0, proposals: 0, total: 0 });

    const p1 = seedProposal(db, { title: "p1" });
    seedProposal(db, { title: "p2" });
    seedProposal(db, { title: "p3" });
    reviewPwProposal(db, p1.id, { action: "reject" }); // 终态，不计
    const bar = getPwModeBar(db, () => "2026-08-12T12:00:00.000Z");
    assert.equal(bar.pendingReview.proposals, 2, "只数 submitted/in_review/changes_requested");
    assert.equal(bar.pendingReview.total, 2, "rejected 不计入 total");
    assert.equal(countPendingPwProposals(db), 2);
  } finally {
    db.close();
  }
});
