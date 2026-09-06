import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDataStore, type DataStore } from "./data.ts";
import { PapertableEngine } from "./engine.ts";
import { createProject } from "./projects.ts";
import { ensurePwCorpusTables } from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";
import { ensurePwVoiceSieveTables, importPwVoiceSieveRun } from "./pw-voice-sieve.ts";
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
const SOURCE_LINE_1 = "—— B站 BV1dEuZ6mEii @评论甲 · 50赞 · rpid:1001";
const SOURCE_LINE_2 = "—— B站 BV1Ncs1z2Ego @评论乙 · 12赞 · rpid:2002";

/** 桶卡：无 bvid/rpid，N 从 message 非空行数推（3 行）。 */
const BUCKET_CARD = {
  title: "求助需求池",
  message: "求个使用教程\n这个功能怎么开启\n怎么批量导入",
  source: { kind: "bucket", bucket: "求助" },
};
/** 桶卡：带显式 count，优先用 count（2 行正文但共 7 条）。 */
const BUCKET_CARD_COUNT = {
  title: "价格诉求",
  message: "太贵了\n希望能便宜点",
  count: 7,
  source: { kind: "bucket", bucket: "价格" },
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
  const root = await mkdtemp(join(tmpdir(), "card-import-"));
  const store = openDataStore(join(root, "data"));
  ensurePwRunTables(store.db);
  ensurePwCorpusTables(store.db);
  ensurePwVoiceSieveTables(store.db);
  const sessions = createSessionRepo(store);
  const engine = new PapertableEngine(store, sessions);
  const project = createProject(store, "选题实验") as { id: string };
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

// ---- PW-69：筛子 run 语料 fixture（照 src/pw-voice-sieve.test.ts 套路）----
const BVID = "BV1dEuZ6mEii";
const RUN_NOW = "2026-08-12T08:00:00+08:00";
const CORPUS = [
  { rpid: 1, uname: "甲", message: "求个使用教程", like: 50, ctime: 1_700_000_000, replies: 0 },
  { rpid: 2, uname: "乙", message: "这个功能怎么开启", like: 12, ctime: 1_700_000_001, replies: 0 },
  { rpid: 3, uname: "丙", message: "笑死我了哈哈", like: 25, ctime: 1_700_000_002, replies: 0 },
];
const VERDICTS = [
  { rpid: "1", verdict: "signal", bucket: "求助", reason: "求教程" },
  { rpid: "2", verdict: "signal", bucket: "求助", reason: "咨询功能" },
  { rpid: "3", verdict: "noise", bucket: null, reason: "玩梗无信息" },
];

async function seedSieveRun(fx: Fixture): Promise<string> {
  const commentsPath = join(fx.root, "comments.jsonl");
  await writeFile(commentsPath, CORPUS.map(JSON.stringify).join("\n") + "\n");
  const resultsDir = join(fx.root, "results");
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, "batch-01.jsonl"), VERDICTS.map(JSON.stringify).join("\n") + "\n");
  const result = importPwVoiceSieveRun(fx.db, {
    bvid: BVID, resultsPath: resultsDir, commentsPath,
    provider: "deepseek", model: "mock",
  }, { dataDir: fx.store.dataDir, now: () => RUN_NOW });
  return result.runId;
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

test("导入成功：落 pt_cards（root/来源上下文）、transcript 有 user 消息、不产生 run", async () => {
  const fx = await fixture();
  try {
    const result = await fx.engine.importCommentCards(fx.projectId, [CARD_1, CARD_2]);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.imported.length, 2);

    const [cardId1, cardId2] = result.imported;
    const card1 = fx.db.prepare("SELECT * FROM pt_cards WHERE id=?").get(cardId1) as {
      project_id: string; session_id: string; title: string; branch_kind: string;
      source_card_id: string | null; branch_context_json: string | null;
    };
    assert.equal(card1.project_id, fx.projectId);
    assert.equal(card1.title, "求助：怎么批量导出");
    assert.equal(card1.branch_kind, "root");
    assert.equal(card1.source_card_id, null);
    assert.deepEqual(JSON.parse(card1.branch_context_json!),
      { source: { platform: "bilibili", bvid: "BV1dEuZ6mEii", rpid: 1001, uname: "评论甲", like: 50 } });

    // transcript：一张卡一条 user 消息 = 评论原文 + 来源行
    assert.deepEqual(await transcriptOf(fx, card1.session_id), [`${CARD_1.message}\n\n${SOURCE_LINE_1}`]);
    const card2 = fx.db.prepare("SELECT session_id FROM pt_cards WHERE id=?").get(cardId2) as { session_id: string };
    assert.deepEqual(await transcriptOf(fx, card2.session_id), [`${CARD_2.message}\n\n${SOURCE_LINE_2}`]);

    // 不触发任何 AI run：两卡在 pt_runs 均无记录
    for (const cardId of result.imported) {
      const runs = fx.db.prepare("SELECT COUNT(*) AS n FROM pt_runs WHERE card_id=?").get(cardId) as { n: number };
      assert.equal(runs.n, 0, `卡 ${cardId} 不应有 run`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("重复导入：同 rpid 跳过并分报 skipped，不产生新卡", async () => {
  const fx = await fixture();
  try {
    const first = await fx.engine.importCommentCards(fx.projectId, [CARD_1, CARD_2]);
    const countBefore = (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n;

    const again = await fx.engine.importCommentCards(fx.projectId, [CARD_1, CARD_2]);
    assert.deepEqual(again.imported, []);
    assert.deepEqual([...again.skipped].sort(), ["1001", "2002"]);
    const countAfter = (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n;
    assert.equal(countAfter, countBefore, "重复导入不新增卡");
    assert.equal(first.imported.length, 2);
  } finally {
    await fx.cleanup();
  }
});

test("同批内重复 rpid：第二张跳过", async () => {
  const fx = await fixture();
  try {
    const result = await fx.engine.importCommentCards(fx.projectId, [CARD_1, { ...CARD_1, title: "重复卡" }]);
    assert.equal(result.imported.length, 1);
    assert.deepEqual(result.skipped, ["1001"]);
  } finally {
    await fx.cleanup();
  }
});

test("超限/缺 cards 400：>50 张、空数组、缺 cards 数组", async () => {
  const fx = await fixture();
  try {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      title: `标题${i}`, message: `正文${i}`,
      source: { bvid: "BV1dEuZ6mEii", rpid: 3000 + i, uname: "u", like: 1 },
    }));
    await assert.rejects(fx.engine.importCommentCards(fx.projectId, tooMany), (error: unknown) => hasStatus(error, 400));
    await assert.rejects(fx.engine.importCommentCards(fx.projectId, []), (error: unknown) => hasStatus(error, 400));
    await assert.rejects(fx.engine.importCommentCards(fx.projectId, undefined), (error: unknown) => hasStatus(error, 400));
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n, 0, "非法批次不落卡");
  } finally {
    await fx.cleanup();
  }
});

test("字段缺失 400：缺 title/message/source/rpid 带明确信息", async () => {
  const fx = await fixture();
  try {
    const source = { bvid: "BV1dEuZ6mEii", rpid: 1 };
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ message: "有正文无标题", source }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("title"),
    );
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ title: "有标题无正文", source }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("message"),
    );
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ title: "缺来源", message: "正文" }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("source"),
    );
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ title: "缺 rpid", message: "正文", source: { bvid: "BV1dEuZ6mEii" } }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("rpid"),
    );
  } finally {
    await fx.cleanup();
  }
});

test("项目不存在 404", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.engine.importCommentCards("no-such-project", [CARD_1]),
      (error: unknown) => hasStatus(error, 404),
    );
  } finally {
    await fx.cleanup();
  }
});

test("桶卡导入成功：source.kind=bucket、来源行带桶名与条数、无 run", async () => {
  const fx = await fixture();
  try {
    const result = await fx.engine.importCommentCards(fx.projectId, [BUCKET_CARD, BUCKET_CARD_COUNT]);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.imported.length, 2);

    const [cardId1, cardId2] = result.imported;
    const card1 = fx.db.prepare("SELECT * FROM pt_cards WHERE id=?").get(cardId1) as {
      title: string; branch_kind: string; session_id: string; branch_context_json: string | null;
    };
    assert.equal(card1.title, "求助需求池");
    assert.equal(card1.branch_kind, "root");
    assert.deepEqual(JSON.parse(card1.branch_context_json!), { source: { kind: "bucket", bucket: "求助" } });
    // N 从 message 非空行数推
    assert.deepEqual(await transcriptOf(fx, card1.session_id),
      ["求个使用教程\n这个功能怎么开启\n怎么批量导入\n\n—— 评论筛子桶卡 · 求助 · 共 3 条"]);

    const card2 = fx.db.prepare("SELECT session_id FROM pt_cards WHERE id=?").get(cardId2) as { session_id: string };
    // 显式 count 优先
    assert.deepEqual(await transcriptOf(fx, card2.session_id),
      ["太贵了\n希望能便宜点\n\n—— 评论筛子桶卡 · 价格 · 共 7 条"]);

    for (const cardId of result.imported) {
      const runs = fx.db.prepare("SELECT COUNT(*) AS n FROM pt_runs WHERE card_id=?").get(cardId) as { n: number };
      assert.equal(runs.n, 0, `桶卡 ${cardId} 不应有 run`);
    }
  } finally {
    await fx.cleanup();
  }
});

test("桶卡同标题重复：skipped 返回标题，不新增卡", async () => {
  const fx = await fixture();
  try {
    const first = await fx.engine.importCommentCards(fx.projectId, [BUCKET_CARD]);
    const countBefore = (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n;

    const again = await fx.engine.importCommentCards(fx.projectId, [{ ...BUCKET_CARD, message: "换个内容" }]);
    assert.deepEqual(again.imported, []);
    assert.deepEqual(again.skipped, ["求助需求池"]);
    const countAfter = (fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n;
    assert.equal(countAfter, countBefore, "同标题桶卡不新增卡");
    assert.equal(first.imported.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("桶卡缺 source.bucket 400 / source.kind 非法 400", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ title: "缺桶名", message: "正文", source: { kind: "bucket" } }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("bucket"),
    );
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [{ title: "坏 kind", message: "正文", source: { kind: "summary", bucket: "求助" } }]),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("kind"),
    );
  } finally {
    await fx.cleanup();
  }
});

// ---- PW-69：corpusRunIds → 信号评论写成项目临时材料 ----

function materialName(runId: string): string {
  return `评论语料·BV1dEuZ6mEii·2026-08-12·${runId.slice(0, 8)}.md`;
}

function materialDocCount(fx: Fixture): number {
  return (fx.db.prepare(
    `SELECT COUNT(*) AS n FROM pt_documents WHERE project_id=? AND source_kind='project_material'`,
  ).get(fx.projectId) as { n: number }).n;
}

test("corpusRunIds：信号评论写成 project_material，chunk 含信号不含噪音", async () => {
  const fx = await fixture();
  try {
    const runId = await seedSieveRun(fx);
    const name = materialName(runId);
    const result = await fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: [runId] });
    assert.equal(result.imported.length, 1, "卡片照常导入");
    assert.deepEqual(result.corpus, { imported: [name], skipped: [] });

    const doc = fx.db.prepare(
      `SELECT id, source_kind, relative_path FROM pt_documents WHERE project_id=? AND source_kind='project_material' AND relative_path=?`,
    ).get(fx.projectId, name) as { id: string; source_kind: string; relative_path: string } | undefined;
    assert.ok(doc, "材料文档应落库");
    assert.equal(doc.source_kind, "project_material");

    const chunks = fx.db.prepare(
      `SELECT text FROM pt_chunks WHERE document_id=? ORDER BY ordinal`,
    ).all(doc.id) as Array<{ text: string }>;
    const allText = chunks.map((row) => row.text).join("\n");
    assert.ok(allText.includes("求个使用教程"), "chunk 含信号评论原文");
    assert.ok(allText.includes("这个功能怎么开启"), "chunk 含另一条信号原文");
    assert.equal(allText.includes("笑死我了哈哈"), false, "chunk 不含噪音评论原文");
  } finally {
    await fx.cleanup();
  }
});

test("corpusRunIds：同 run 重放 → 材料已存在，文档数不增", async () => {
  const fx = await fixture();
  try {
    const runId = await seedSieveRun(fx);
    const name = materialName(runId);
    await fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: [runId] });
    const before = materialDocCount(fx);

    const again = await fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: [runId] });
    assert.deepEqual(again.corpus.imported, []);
    assert.deepEqual(again.corpus.skipped, [`${name}（已存在）`]);
    assert.equal(materialDocCount(fx), before, "重放不新增文档");
  } finally {
    await fx.cleanup();
  }
});

test("不传 corpusRunIds：无材料产生，corpus 两数组为空", async () => {
  const fx = await fixture();
  try {
    const result = await fx.engine.importCommentCards(fx.projectId, [CARD_1]);
    assert.deepEqual(result.corpus, { imported: [], skipped: [] });
    assert.equal(materialDocCount(fx), 0, "不传 corpusRunIds 不产生材料");
  } finally {
    await fx.cleanup();
  }
});

test("corpusRunIds 未知 runId / status 非 done → 400 fail-fast，不落卡不写材料", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: ["no-such-run"] }),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("no-such-run"),
    );
    // status 非 done 同样 400
    fx.db.prepare(`
      INSERT INTO pw_voice_sieve_runs(id,bvid,provider,model,total,signal,noise,reassigned,report_path,created_at,status)
      VALUES('pending-run',?,?,?,?,?,?,?,?,?,'pending')
    `).run(BVID, "deepseek", "mock", 0, 0, 0, 0, null, RUN_NOW);
    await assert.rejects(
      fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: ["pending-run"] }),
      (error: unknown) => hasStatus(error, 400) && String((error as Error).message).includes("pending-run"),
    );
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS n FROM pt_cards").get() as { n: number }).n, 0, "fail-fast 不落卡");
    assert.equal(materialDocCount(fx), 0, "fail-fast 不写材料");
  } finally {
    await fx.cleanup();
  }
});

test("信号 message 全空（语料被删）→ 不写材料，skipped 注明不可读", async () => {
  const fx = await fixture();
  try {
    const runId = await seedSieveRun(fx);
    const name = materialName(runId);
    // 删除语料文件：getPwVoiceSieveRun 的语料 join 把 message 留空
    await rm(join(fx.store.dataDir, "corpus", BVID, "comments.jsonl"));

    const result = await fx.engine.importCommentCards(fx.projectId, [CARD_1], { corpusRunIds: [runId] });
    assert.deepEqual(result.corpus.imported, []);
    assert.deepEqual(result.corpus.skipped, [`${name}（语料原文不可读）`]);
    assert.equal(materialDocCount(fx), 0, "信号全空不写材料");
  } finally {
    await fx.cleanup();
  }
});
