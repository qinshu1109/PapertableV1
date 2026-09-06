import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openDataStore, type DataStore } from "./data.ts";
import { PapertableEngine } from "./engine.ts";
import { ensurePwGoldMirrorTables } from "./pw-gold-sync.ts";
import {
  createProject,
  deleteProject,
  listProjects,
  projectDetail,
  restoreCards,
  trashCards,
} from "./projects.ts";
import { ensureVerdictTables } from "./verdicts.ts";
import { addProjectMaterial } from "./notes.ts";
import {
  activeConversation,
  closeSession,
  createSessionRepo,
  openSessionById,
  type SessionRepo,
} from "./sessions.ts";

const CARD_1 = {
  title: "求助：怎么批量导出",
  message: "请问有没有办法把表格一次性导出成 Excel？",
  source: { platform: "bilibili", bvid: "BV1dEuZ6mEii", rpid: 1001, uname: "评论甲", like: 50 },
};
const CARD_2 = {
  title: "价格吐槽",
  message: "太贵了，性价比不高",
  source: { platform: "bilibili", bvid: "BV1Ncs1z2Ego", rpid: 2002, uname: "评论乙", like: 12 },
};
/** 桶卡：按标题去重。 */
const BUCKET_CARD = {
  title: "求助需求池",
  message: "求个使用教程\n这个功能怎么开启\n怎么批量导入",
  source: { kind: "bucket", bucket: "求助" },
};

type Fixture = {
  db: DataStore["db"];
  store: DataStore;
  engine: PapertableEngine;
  sessions: SessionRepo;
  projectId: string;
  root: string;
  cleanup: () => Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "card-trash-"));
  const store = openDataStore(join(root, "data"));
  ensureVerdictTables(store.db);
  ensurePwGoldMirrorTables(store.db);
  const sessions = createSessionRepo(store);
  const engine = new PapertableEngine(store, sessions);
  const project = createProject(store, "回收站实验") as { id: string };
  return {
    db: store.db,
    store,
    engine,
    sessions,
    projectId: project.id,
    root,
    cleanup: async () => {
      store.db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

async function transcriptOf(fx: Fixture, sessionId: string): Promise<string[]> {
  const session = await openSessionById(fx.sessions, sessionId, fx.projectId);
  try {
    const conversation = await activeConversation(session);
    return conversation.filter((entry) => entry.role === "user").map((entry) => entry.text);
  } finally {
    await closeSession(session).catch(() => undefined);
  }
}

// ---- a) trash → 卡带 trashedAt → 同标题桶卡可重新导入（旧卡仍在回收站）→ restore 后两份并存 ----

test("trash 后同标题桶卡可重新导入；restore 后两份并存", async () => {
  const fx = await fixture();
  try {
    const first = await fx.engine.importCommentCards(fx.projectId, [BUCKET_CARD]);
    const oldCardId = first.imported[0];
    const before = fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = ?").get(oldCardId) as
      { trashed_at: string | null };
    assert.equal(before.trashed_at, null, "未删卡 trashed_at 应为 NULL");

    assert.deepEqual(trashCards(fx.store, fx.projectId, [oldCardId]).trashed, [oldCardId]);
    const trashedRow = fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = ?").get(oldCardId) as
      { trashed_at: string | null };
    assert.ok(trashedRow.trashed_at, "已删卡应有 trashed_at 时间戳");

    // 回收站里的旧卡不挡重送：同标题桶卡重新导入成新卡
    const again = await fx.engine.importCommentCards(fx.projectId, [{ ...BUCKET_CARD, message: "换个内容" }]);
    assert.deepEqual(again.skipped, [], "回收站中的旧卡不应挡重送");
    assert.equal(again.imported.length, 1, "应导入一张新卡");
    const newCardId = again.imported[0];
    assert.notEqual(newCardId, oldCardId);
    assert.ok(
      (fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = ?").get(oldCardId) as { trashed_at: string | null }).trashed_at,
      "旧卡仍在回收站",
    );
    assert.equal(
      (fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = ?").get(newCardId) as { trashed_at: string | null }).trashed_at,
      null,
      "新卡在册",
    );

    // restore 旧卡后：同标题两份并存
    assert.deepEqual(restoreCards(fx.store, fx.projectId, [oldCardId]).restored, [oldCardId]);
    const active = fx.db.prepare(`
      SELECT COUNT(*) AS n FROM pt_cards
      WHERE project_id = ? AND trashed_at IS NULL AND title = ?
    `).get(fx.projectId, "求助需求池") as { n: number };
    assert.equal(active.n, 2, "restore 后同标题两份并存");
  } finally {
    await fx.cleanup();
  }
});

test("trash 后同 rpid 评论卡可重新导入（comment 去重同样只看在册卡）", async () => {
  const fx = await fixture();
  try {
    const first = await fx.engine.importCommentCards(fx.projectId, [CARD_1]);
    const cardId = first.imported[0];
    trashCards(fx.store, fx.projectId, [cardId]);

    const again = await fx.engine.importCommentCards(fx.projectId, [{ ...CARD_1, message: "重发" }]);
    assert.deepEqual(again.skipped, []);
    assert.equal(again.imported.length, 1, "回收站里的同 rpid 卡不挡重送");
  } finally {
    await fx.cleanup();
  }
});

// ---- b) trash 幂等、跨项目/不存在 id 静默跳过 ----

test("trash 幂等；跨项目与不存在 id 静默跳过；restore 同样跳过跨项目", async () => {
  const fx = await fixture();
  try {
    const other = createProject(fx.store, "他项目") as { id: string };
    const stamp = new Date().toISOString();
    const insert = fx.db.prepare(`
      INSERT INTO pt_cards(id, project_id, session_id, title, branch_kind, source_card_id,
        branch_context_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'root', NULL, NULL, ?, ?)
    `);
    insert.run("card-p1", fx.projectId, "s-p1", "甲", stamp, stamp);
    insert.run("card-p2", other.id, "s-p2", "乙", stamp, stamp);

    assert.deepEqual(trashCards(fx.store, fx.projectId, ["card-p1"]).trashed, ["card-p1"]);
    // 已删重复删幂等照返回
    assert.deepEqual(trashCards(fx.store, fx.projectId, ["card-p1"]).trashed, ["card-p1"]);
    // 跨项目与不存在 id 静默跳过
    assert.deepEqual(trashCards(fx.store, fx.projectId, ["card-p2"]).trashed, []);
    assert.deepEqual(trashCards(fx.store, fx.projectId, ["no-such"]).trashed, []);
    assert.equal(
      (fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = 'card-p2'").get() as { trashed_at: string | null }).trashed_at,
      null,
      "他项目卡不受影响",
    );

    // restore 跨项目同样跳过；本项目照恢复
    assert.deepEqual(restoreCards(fx.store, fx.projectId, ["card-p2"]).restored, []);
    assert.deepEqual(restoreCards(fx.store, fx.projectId, ["card-p1"]).restored, ["card-p1"]);
    assert.equal(
      (fx.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = 'card-p1'").get() as { trashed_at: string | null }).trashed_at,
      null,
      "restore 后 trashed_at 清空",
    );
  } finally {
    await fx.cleanup();
  }
});

// ---- c) listProjects cardCount 排除已删 ----

test("listProjects cardCount 只数在册卡（trashed_at IS NULL）", async () => {
  const fx = await fixture();
  try {
    const cardCount = () => listProjects(fx.store.db)
      .find((project) => project.id === fx.projectId)?.cardCount;
    const first = await fx.engine.importCommentCards(fx.projectId, [CARD_1, CARD_2]);
    assert.equal(cardCount(), 2);
    trashCards(fx.store, fx.projectId, [first.imported[0]]);
    assert.equal(cardCount(), 1, "已删卡不计入 cardCount");
    restoreCards(fx.store, fx.projectId, [first.imported[0]]);
    assert.equal(cardCount(), 2, "恢复后重新计入");
  } finally {
    await fx.cleanup();
  }
});

// ---- d) DELETE 项目：全表无残留、磁盘目录消失、再访问 404、他项目数据保留 ----

test("DELETE 项目：全表无该项目残留、磁盘目录消失、再访问 404、他项目保留", async () => {
  const fx = await fixture();
  try {
    const other = createProject(fx.store, "保留项目") as { id: string };
    const stamp = new Date().toISOString();
    const insertCard = fx.db.prepare(`
      INSERT INTO pt_cards(id, project_id, session_id, title, branch_kind, source_card_id,
        branch_context_json, created_at, updated_at)
      VALUES(?, ?, ?, ?, 'root', NULL, NULL, ?, ?)
    `);
    insertCard.run("del-a", fx.projectId, "s-a", "甲", stamp, stamp);
    insertCard.run("del-b", fx.projectId, "s-b", "乙", stamp, stamp);
    insertCard.run("keep-a", other.id, "s-k", "丙", stamp, stamp);
    fx.db.prepare("UPDATE pt_cards SET trashed_at = ? WHERE id = 'del-b'").run(stamp);

    // 磁盘材料（先于 running run 创建，避免 assertProjectMutable 409）
    await addProjectMaterial(fx.store, fx.projectId, "材料.md", new TextEncoder().encode("# 材料\n正文"));
    const projectDir = join(fx.store.projectsDir, fx.projectId);
    assert.ok(await stat(projectDir).catch(() => undefined), "项目磁盘目录应存在");

    // running run（无保护：不挡删）
    fx.db.prepare(`
      INSERT INTO pt_runs(id, project_id, card_id, question, status, result, reason,
        scope_json, created_at, ended_at)
      VALUES('del-run', ?, 'del-a', '问', 'running', NULL, NULL, '[]', ?, NULL)
    `).run(fx.projectId, stamp);
    fx.db.prepare(`
      INSERT INTO pt_runs(id, project_id, card_id, question, status, result, reason,
        scope_json, created_at, ended_at)
      VALUES('keep-run', ?, 'keep-a', '问', 'ended', 'completed', 'none', '[]', ?, ?)
    `).run(other.id, stamp, stamp);
    fx.db.prepare(`
      INSERT INTO pt_run_events(run_id, seq, event_type, payload_json, created_at)
      VALUES('del-run', 1, 'run_created', '{}', ?)
    `).run(stamp);
    fx.db.prepare(`
      INSERT INTO pt_run_sources(run_id, document_id, source_kind, relative_path, actual_path, sha256)
      VALUES('del-run', 'doc-del', 'project_material', 'x.md', '/tmp/x.md', 'abc')
    `).run();
    fx.db.prepare(`
      INSERT INTO pt_edges(id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at)
      VALUES('del-edge', ?, 'del-a', 'del-b', 'deep_dive', '{}', ?)
    `).run(fx.projectId, stamp);
    fx.db.prepare(`
      INSERT INTO pt_verdicts(id, project_id, card_id, kind, text, status, memos_status, created_at, updated_at)
      VALUES('del-verdict', ?, 'del-a', 'gold', '结论', 'confirmed', 'pending', ?, ?)
    `).run(fx.projectId, stamp, stamp);
    fx.db.prepare(`
      INSERT INTO pt_verdict_events(id, project_id, event_type, target_card_id, created_at)
      VALUES('del-vev', ?, 'tombstone-confirmed', 'del-a', ?)
    `).run(fx.projectId, stamp);
    fx.db.prepare(`
      INSERT INTO pt_stage_exports(stage_key, project_id, card_id, transcript_path, transcript_offset, status, reason, created_at)
      VALUES('del-stage', ?, 'del-a', '/tmp/t.md', 0, 'pending', 'r', ?)
    `).run(fx.projectId, stamp);
    fx.db.prepare(`
      INSERT INTO pt_promotions(id, project_id, card_id, run_id, record_id, preview_digest, target_path,
        state, preview_json, created_at, updated_at)
      VALUES('del-promo', ?, 'del-a', 'del-run', 'rec', 'digest', '/tmp/p.md', 'previewed', '{}', ?, ?)
    `).run(fx.projectId, stamp, stamp);
    fx.db.prepare(`
      INSERT INTO pt_project_libraries(project_id, root_path, document_count, chunk_count)
      VALUES(?, '/lib', 0, 0)
    `).run(fx.projectId);
    fx.db.prepare(`
      INSERT INTO pw_gold_mirror(id, source_verdict_id, kind, text, project_id, mirrored_at)
      VALUES('del-gold', 'del-verdict', 'gold', '结论', ?, ?)
    `).run(fx.projectId, stamp);

    // running run 不挡删（无保护）
    assert.deepEqual(await deleteProject(fx.store, fx.projectId), { deleted: true });

    const countFor = (table: string, projectId: string) =>
      Number((fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`)
        .get(projectId) as { n: number }).n);
    for (const table of [
      "pt_cards", "pt_runs", "pt_edges", "pt_verdicts", "pt_verdict_events",
      "pt_stage_exports", "pt_promotions", "pt_documents", "pt_chunks",
      "pt_project_libraries", "pw_gold_mirror",
    ]) {
      assert.equal(countFor(table, fx.projectId), 0, `${table} 不应有该项目残留`);
    }
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_run_events WHERE run_id = 'del-run'").get() as { n: number }).n,
      0,
      "run_events 随 run 删除",
    );
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_run_sources WHERE run_id = 'del-run'").get() as { n: number }).n,
      0,
      "run_sources 随 run 删除",
    );
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_chunks_fts WHERE project_id = ?").get(fx.projectId) as { n: number }).n,
      0,
      "pt_chunks_fts 无该项目残留",
    );
    assert.equal(await stat(projectDir).catch(() => undefined), undefined, "项目磁盘目录应已删除");

    // 他项目数据保留
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards WHERE project_id = ?").get(other.id) as { n: number }).n, 1);
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS n FROM pt_runs WHERE project_id = ?").get(other.id) as { n: number }).n, 1);
    // 再访问 404
    await assert.rejects(
      async () => projectDetail(fx.store, fx.projectId),
      (error: unknown) => hasStatus(error, 404),
    );
  } finally {
    await fx.cleanup();
  }
});

// ---- e) 迁移 v4 幂等：旧 schema 库能正常加列，重开不重复加 ----

test("迁移 v4 幂等：旧 schema 库正常加列，重开不重复加", async () => {
  const root = await mkdtemp(join(tmpdir(), "card-trash-migrate-"));
  try {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const oldDb = new DatabaseSync(join(dataDir, "papertable.sqlite3"));
    oldDb.exec(`
      CREATE TABLE pt_schema (version INTEGER NOT NULL);
      INSERT INTO pt_schema(version) VALUES (3);
      CREATE TABLE pt_projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE pt_cards (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES pt_projects(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        branch_kind TEXT NOT NULL,
        source_card_id TEXT REFERENCES pt_cards(id) ON DELETE SET NULL,
        branch_context_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO pt_projects VALUES('p-old', '老项目', 't', 't');
      INSERT INTO pt_cards VALUES('c-old', 'p-old', 's-old', '旧卡', 'root', NULL, NULL, 't', 't');
    `);
    oldDb.close();

    const store = openDataStore(dataDir);
    try {
      const columns = store.db.prepare("PRAGMA table_info(pt_cards)").all().map((c) => c.name);
      assert.ok(columns.includes("trashed_at"), "迁移后应有 trashed_at 列");
      assert.equal(
        (store.db.prepare("SELECT version FROM pt_schema LIMIT 1").get() as { version: number }).version,
        5,
        "schema version 应升到 5（v4 trashed_at + v5 学习闭环三新表）",
      );
      assert.equal(
        (store.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = 'c-old'").get() as { trashed_at: string | null }).trashed_at,
        null,
        "旧数据保留且 trashed_at 为 NULL",
      );
      assert.deepEqual(trashCards(store, "p-old", ["c-old"]).trashed, ["c-old"]);
      assert.ok(
        (store.db.prepare("SELECT trashed_at FROM pt_cards WHERE id = 'c-old'").get() as { trashed_at: string | null }).trashed_at,
        "迁移后 trashed_at 列可正常写入",
      );
    } finally {
      store.db.close();
    }

    const store2 = openDataStore(dataDir);
    try {
      assert.equal(
        (store2.db.prepare("SELECT version FROM pt_schema LIMIT 1").get() as { version: number }).version,
        5,
        "重开 schema version 保持 5",
      );
      assert.ok(
        store2.db.prepare("PRAGMA table_info(pt_cards)").all().map((c) => c.name).includes("trashed_at"),
        "重开不重复加列、无异常",
      );
    } finally {
      store2.db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
