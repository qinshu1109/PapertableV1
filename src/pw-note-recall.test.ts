/**
 * TASK-PW-40：按押注回顾捞取（旧笔记回响）测试。
 * 覆盖：抽词算法 7 项细节、mock 库捞取与命中门槛、跨押注去重、空态、库不可用兜底、
 * day-summary 集成（对账锚点回归 + 空事件日回响段）、零写入 sha256 对账。
 * 镇纸 mock 库走内存库（pw_bets 正式建表），Memos mock 库沿用 pw-notes.test.ts 的
 * tmp 目录 + WAL 范式，经 MEMOS_DB_PATH 覆盖指向——绝不触碰真实 Memos 库。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import { getPwDaySummary, renderPwDaySummaryText } from "./pw-day-summary.ts";
import { buildPwNoteEcho, extractPwRecallKeywords } from "./pw-note-recall.ts";
import { ensurePwRunTables, recordPwEvent } from "./pw-runs.ts";

/** memo 表 schema 照抄 TASK-PW-39「已核验的库事实」（与 pw-notes.test.ts 同源）。 */
const MEMOS_SCHEMA = `
  CREATE TABLE memo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    creator_id INTEGER,
    created_ts INTEGER,
    updated_ts INTEGER,
    row_status TEXT NOT NULL DEFAULT 'NORMAL' CHECK(row_status IN ('NORMAL','ARCHIVED')),
    content TEXT,
    visibility TEXT NOT NULL DEFAULT 'PRIVATE'
      CHECK(visibility IN ('PUBLIC','PROTECTED','PRIVATE')),
    pinned INTEGER NOT NULL DEFAULT 0,
    payload TEXT
  );
`;

function makeMockDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(MEMOS_SCHEMA);
  return db;
}

function insertMemo(
  db: DatabaseSync,
  row: { uid: string; created_ts: number; content: string; row_status?: string },
): void {
  db.prepare(`
    INSERT INTO memo(uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
    VALUES(?, ?, ?, ?, ?, ?, 'PRIVATE', 0, NULL)
  `).run(row.uid, 1, row.created_ts, row.created_ts, row.row_status ?? "NORMAL", row.content);
}

/** 镇纸 mock 库：pw_bets 走正式建表（listContentBets 全列投影）；联查两表只建本刀用到的列
 *  （getPwDaySummary 会 prepare 三张联查语句，缺表即报错）。 */
function makePapertableDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  db.exec(`
    CREATE TABLE pw_sieve_cards (
      id TEXT PRIMARY KEY,
      quote_text TEXT NOT NULL
    );
    CREATE TABLE pw_content_drafts (
      id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      title_candidate TEXT NOT NULL
    );
  `);
  return db;
}

/** 直接落一张 content 押注（status/kind 可由调用方指定，覆盖 void/settled/verdict 情形）。 */
function seedContentBet(
  db: DatabaseSync,
  seed: {
    id: string;
    title: string;
    thesis?: string;
    status?: string;
    kind?: string;
    checkout_date?: string | null;
    created_at?: string;
  },
): void {
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at,
      settled_verdict_id, kind, source_card_id
    ) VALUES(?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '[]', NULL, ?, NULL, ?, NULL)
  `).run(
    seed.id,
    seed.title,
    seed.thesis ?? "",
    seed.checkout_date ?? null,
    seed.status ?? "pending",
    seed.created_at ?? "2026-08-08T00:00:00.000Z",
    seed.kind ?? "content",
  );
}

/** thesis 按 PW-19 buildThesis 的固定格式：原文：{quote}\n来源：bvid=…，uname=…，like=… */
function thesisOf(quote: string): string {
  return `原文：${quote}\n来源：bvid=BV1NprhBPEtR，uname=路人甲，like=42`;
}

/** 临时目录生命周期：目录内库文件每次唯一，测试互不干扰。 */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-note-recall-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 设置/清除环境变量，结束后恢复原值。 */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** db + -wal 的 sha256 对账串（规格对账口径，-shm 属瞬时 wal-index 不在内）。 */
function fileSha(...paths: string[]): string {
  return paths.map((p) => {
    if (!existsSync(p)) return "MISSING";
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  }).join("|");
}

test("1 抽词：CJK 二字组/段长 2 即段本身、ASCII 整词、停用词/纯数字/单字符剔除、来源噪声剔除、去重与 40 封顶、全停用词返回 []", () => {
  // CJK 相邻二字组（规格示例「这也太全能了吧」→ 这也/也太/太全/全能/能了/了吧）；段长恰为 2 时即段本身
  assert.deepEqual(extractPwRecallKeywords("这也太全能了吧", ""), ["这也", "也太", "太全", "全能", "能了", "了吧"]);
  assert.deepEqual(extractPwRecallKeywords("全能", ""), ["全能"]);
  // 停用词只整段过滤：段内生成的二字组不再二次过滤（防过度收敛靠命中门槛兜）
  assert.deepEqual(extractPwRecallKeywords("这个价值", ""), ["这个", "个价", "价值"]);
  // ASCII 词段整词保留（大小写与字母数字混排均不拆）
  assert.deepEqual(extractPwRecallKeywords("cozai AU C4D", ""), ["cozai", "AU", "C4D"]);
  // 纯数字段 / 单字符段 / 停用词段丢弃
  assert.deepEqual(extractPwRecallKeywords("153", ""), []);
  assert.deepEqual(extractPwRecallKeywords("全", ""), []);
  assert.deepEqual(extractPwRecallKeywords("这个 那个", ""), []);
  // 「来源：」行整行剔除、「原文：」前缀剔除；title 段先于 thesis 段（title 权重天然靠前）
  assert.deepEqual(
    extractPwRecallKeywords("标题", thesisOf("这也太全能了吧")),
    ["标题", "这也", "也太", "太全", "全能", "能了", "了吧"],
  );
  // 全停用词输入 → []
  assert.deepEqual(extractPwRecallKeywords("这个", "原文：那个 什么\n来源：x"), []);
  // 按出现顺序去重
  assert.deepEqual(extractPwRecallKeywords("全能力量 全能力量", ""), ["全能", "能力", "力量"]);
  // 40 封顶：46 个不同字符一段 → 45 个二字组 → 只留前 40
  const longSegment = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥一二三四五六七八九十百千万亿兆京垓秭穰沟涧正载极";
  const capped = extractPwRecallKeywords(longSegment, "");
  assert.equal(capped.length, 40);
  assert.equal(capped[0], "甲乙");
  assert.equal(capped[39], "秭穰");
});

test("2 捞取（mock 库）：≥2 词命中进 hits、单词命中被门槛挡掉、hits≤3、matchedKeywords/keywords 如实", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 标题「全能力量测试」+ 引文「AI 全能力量验证」→ 8 个关键词：全能/能力/力量/量测/测试/AI/量验/验证
      seedContentBet(papertable, { id: "bet-1", title: "全能力量测试", thesis: thesisOf("AI 全能力量验证") });
      insertMemo(notesWriter, { uid: "n-a", created_ts: 300, content: "全能 力量 能力 都在" });
      insertMemo(notesWriter, { uid: "n-b", created_ts: 200, content: "全能 力量 都有" });
      insertMemo(notesWriter, { uid: "n-c", created_ts: 100, content: "全能 能力 都有" });
      insertMemo(notesWriter, { uid: "n-d", created_ts: 400, content: "全能 力量 也有" });
      insertMemo(notesWriter, { uid: "n-single", created_ts: 500, content: "只有全能关键词" });

      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "ok");
        assert.ok(echo.status === "ok");
        assert.equal(echo.bets.length, 1);
        const bet = echo.bets[0];
        assert.equal(bet.betId, "bet-1");
        assert.equal(bet.betTitle, "全能力量测试");
        // 3 词命中最前，同数按 created_ts 倒序；单词命中（n-single）被门槛挡掉；hits ≤ 3
        assert.deepEqual(bet.hits.map((hit) => hit.uid), ["n-a", "n-d", "n-b"]);
        assert.equal(bet.hits.length, 3);
        assert.deepEqual(bet.hits[0].matchedKeywords, ["全能", "能力", "力量"]);
        assert.deepEqual(bet.keywords, ["全能", "能力", "力量", "量测", "测试", "AI", "量验", "验证"]);
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("3 跨押注去重：同一 uid 命中两张押注只挂在展示序第一张下，剔除后不补位", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 展示序：pending 优先 → checkout_date 升序（bet-1 早于 bet-2）
      seedContentBet(papertable, {
        id: "bet-1", title: "全能力量", checkout_date: "2026-08-10", created_at: "2026-08-08T00:00:00.000Z",
      });
      seedContentBet(papertable, {
        id: "bet-2", title: "选手测试", checkout_date: "2026-08-20", created_at: "2026-08-08T00:00:00.000Z",
      });
      // shared 同时命中两张押注；only-b2 / extra-b2 只命中 bet-2
      insertMemo(notesWriter, { uid: "shared", created_ts: 100, content: "全能 能力 选手 测试 关键词" });
      insertMemo(notesWriter, { uid: "only-b2", created_ts: 50, content: "选手 测试 单独命中" });
      insertMemo(notesWriter, { uid: "extra-b2", created_ts: 40, content: "选手 测试 更多命中" });

      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "ok");
        assert.ok(echo.status === "ok");
        assert.deepEqual(echo.bets.map((bet) => bet.betId), ["bet-1", "bet-2"]);
        assert.deepEqual(echo.bets[0].hits.map((hit) => hit.uid), ["shared"]);
        assert.deepEqual(
          echo.bets[1].hits.map((hit) => hit.uid),
          ["only-b2", "extra-b2"],
          "shared 被去重且不补位（原始 3 条 → 2 条，小于 maxHits）",
        );
        const allUids = echo.bets.flatMap((bet) => bet.hits.map((hit) => hit.uid));
        assert.equal(new Set(allUids).size, allUids.length, "同一条笔记全局只出现一次");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("4 空态：无在途内容押注（void/settled/verdict 均不算）→ no_bets；有押注无命中 → hits 空、keywords 如实", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      seedContentBet(papertable, { id: "void-1", title: "已作废押注", status: "void" });
      seedContentBet(papertable, { id: "settled-1", title: "已结算押注", status: "settled" });
      seedContentBet(papertable, { id: "verdict-1", title: "传统押注", kind: "verdict" });
      insertMemo(notesWriter, { uid: "any", created_ts: 100, content: "随便一条笔记" });
      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        assert.deepEqual(buildPwNoteEcho(papertable), { status: "no_bets" });
      });

      // 有在途押注但笔记对不上词 → ok + hits 空 + keywords 如实列出
      seedContentBet(papertable, {
        id: "bet-nomatch", title: "量子计算机与极低温", created_at: "2026-08-09T00:00:00.000Z",
      });
      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "ok");
        assert.ok(echo.status === "ok");
        assert.deepEqual(echo.bets.map((bet) => bet.betId), ["bet-nomatch"]);
        assert.deepEqual(echo.bets[0].hits, []);
        assert.deepEqual(echo.bets[0].keywords, ["量子", "子计", "计算", "算机", "机与", "与极", "极低", "低温"]);
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("5 库不可用：MEMOS_DB_PATH 指向不存在路径 → buildPwNoteEcho 返回 unavailable 不抛错；getPwDaySummary 照常返回", async () => {
  await withDir(async (dir) => {
    const papertable = makePapertableDb();
    ensurePwRunTables(papertable);
    try {
      seedContentBet(papertable, { id: "bet-1", title: "全能力量" });
      const missing = join(dir, "no-such-memos.db");
      withEnv({ MEMOS_DB_PATH: missing }, () => {
        const echo = buildPwNoteEcho(papertable);
        assert.equal(echo.status, "unavailable");
        assert.ok(echo.status === "unavailable" && echo.error.includes("无法只读打开笔记库"), "error 带库路径信息");

        // 无在途押注时先短路为 no_bets，不触库
        const emptyDb = makePapertableDb();
        try {
          assert.deepEqual(buildPwNoteEcho(emptyDb), { status: "no_bets" });
        } finally {
          emptyDb.close();
        }

        // 收工小结照常返回，noteEcho.status === 'unavailable'，文本含回响段兜底文案
        const s = getPwDaySummary(papertable, { date: "2026-08-08", now: new Date(2026, 7, 8, 20, 0) });
        assert.equal(s.totalEvents, 0);
        assert.equal(s.noteEcho.status, "unavailable");
        const text = renderPwDaySummaryText(s);
        assert.match(text, /■ 旧笔记回响/);
        assert.match(text, /连不上笔记库/);
      });
    } finally {
      papertable.close();
    }
  });
});

test("6 day-summary 集成：命中笔记进回响段、对账锚点不变（回响不进计数）、空事件日也输出回响段", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    ensurePwRunTables(papertable);
    try {
      seedContentBet(papertable, { id: "bet-1", title: "全能力量测试", thesis: thesisOf("AI 全能力量验证") });
      insertMemo(notesWriter, { uid: "hit-1", created_ts: 1_700_000_000, content: "三个月前的全能 力量 灵感" });
      // 当日两条事件：manual mirror（其余档）+ ai_auto corpus（自主档），验证回响不进计数
      recordPwEvent(papertable, {
        kind: "manual_event", actor: "human", event_type: "mirror",
        payload_json: JSON.stringify({ inserted: 1 }),
        created_at: new Date(2026, 7, 8, 9, 0).toISOString(),
      });
      recordPwEvent(papertable, {
        kind: "ai_auto", actor: "ai", event_type: "corpus",
        payload_json: JSON.stringify({ corpusId: "c1" }),
        created_at: new Date(2026, 7, 8, 18, 0).toISOString(),
      });

      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const s = getPwDaySummary(papertable, { date: "2026-08-08", now: new Date(2026, 7, 8, 20, 0) });
        // 对账锚点：各档和 + otherCount = totalEvents（回响不参与任何一档计数）
        assert.equal(s.totalEvents, 2);
        assert.equal(s.otherCount, 1);
        const reconciled = s.picks.length + s.betConfirms.length + s.finalizes.length
          + s.cardRejects.length + s.draftRejects.length + s.draftRunBatches
          + s.execActions.length + s.autoActions.length + s.otherCount;
        assert.equal(reconciled, s.totalEvents);
        assert.equal(s.noteEcho.status, "ok");
        assert.ok(s.noteEcho.status === "ok" && s.noteEcho.bets[0].hits.length === 1);

        const text = renderPwDaySummaryText(s);
        assert.match(text, /■ 旧笔记回响/);
        assert.match(text, /押注《全能力量测试》→ 命中 1 条：/);
        assert.match(text, /「三个月前的全能 力量 灵感」（\d{2}-\d{2}，命中词：全能、力量）→ http:\/\/127\.0\.0\.1:5230\/memos\/hit-1/);

        // 空事件日：回响段照常输出（回响与当日事件无关）
        const empty = getPwDaySummary(papertable, { date: "2026-08-09", now: new Date(2026, 7, 9, 20, 0) });
        assert.equal(empty.totalEvents, 0);
        const emptyText = renderPwDaySummaryText(empty);
        assert.match(emptyText, /今天没有协作台事件。/);
        assert.match(emptyText, /■ 旧笔记回响/);
        assert.match(emptyText, /押注《全能力量测试》→ 命中 1 条：/);
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("7 零写入对账：捞取前后 mock Memos 库 db + -wal sha256 逐字节一致", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      seedContentBet(papertable, { id: "bet-1", title: "全能力量测试" });
      insertMemo(notesWriter, { uid: "z-1", created_ts: 1_700_000_000, content: "全能 力量 关键词" });
      const walPath = notesPath + "-wal";
      const before = fileSha(notesPath, walPath);
      withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        buildPwNoteEcho(papertable);
      });
      const after = fileSha(notesPath, walPath);
      assert.equal(after, before, "捞取只读，不得改动主库或 -wal 任何字节");
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});
