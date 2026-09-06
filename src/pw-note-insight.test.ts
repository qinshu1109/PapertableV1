/**
 * TASK-PW-53：笔记定向洞察后端测试（五组断言）。
 * 覆盖：建表列、mock llm 跑通（prompt 内容与落行字段）、0 命中（400 不调模型不落行）、
 * 重试（首败重试成功 / 两败 502）、list 排序与 betId 过滤。
 * 镇纸 mock 库走内存库（pw_bets + pw_note_insights 正式建表），Memos mock 库沿用
 * pw-note-recall.test.ts 的 tmp 目录 + WAL 范式，经 MEMOS_DB_PATH 覆盖指向——绝不触碰真实 Memos 库。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensurePwBetTables } from "./pw-bets.ts";
import {
  INSIGHT_SYSTEM_PROMPT,
  ensurePwNoteInsightTables,
  listPwNoteInsights,
  publicPwNoteInsight,
  runPwNoteInsight,
} from "./pw-note-insight.ts";

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
  row: { uid: string; created_ts: number; content: string },
): void {
  db.prepare(`
    INSERT INTO memo(uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
    VALUES(?, 1, ?, ?, 'NORMAL', ?, 'PRIVATE', 0, NULL)
  `).run(row.uid, row.created_ts, row.created_ts, row.content);
}

/** 镇纸 mock 库：pw_bets + pw_note_insights 正式建表。 */
function makePapertableDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwBetTables(db);
  ensurePwNoteInsightTables(db);
  return db;
}

/** 直接落一张押注（title/thesis 决定捞取关键词）。 */
function seedBet(
  db: DatabaseSync,
  seed: { id: string; title: string; thesis?: string },
): void {
  db.prepare(`
    INSERT INTO pw_bets(
      id, title, thesis, metric, metric_target, confidence, data_source_plan,
      checkout_date, status, gold_refs_json, created_from, created_at,
      settled_verdict_id, kind, source_card_id
    ) VALUES(?, ?, ?, NULL, NULL, NULL, NULL, NULL, 'pending', '[]', NULL, '2026-08-08T00:00:00.000Z', NULL, 'content', NULL)
  `).run(seed.id, seed.title, seed.thesis ?? "");
}

/** thesis 按 PW-19 buildThesis 的固定格式：原文：{quote}\n来源：bvid=…，uname=…，like=… */
function thesisOf(quote: string): string {
  return `原文：${quote}\n来源：bvid=BV1NprhBPEtR，uname=路人甲，like=42`;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-note-insight-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 设置/清除环境变量，异步回调结束后恢复原值（回调里 await 期间 env 保持有效）。 */
async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertStatus(error: unknown, status: number): void {
  assert.equal((error as { status?: number }).status, status);
}

function countInsights(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM pw_note_insights").get() as { n: number }).n);
}

/** 《洞察纪律》必须逐字含规格写死的五段标题与纪律条目。 */
test("0 洞察纪律 systemPrompt 逐字含五段标题与纪律", () => {
  for (const line of [
    "## 可核对的事实与原文线索",
    "## 反复出现的模式",
    "## 当前主要矛盾",
    "## 尚未证实的假设",
    "## 一个最小验证动作",
    "1. 事实与推断必须分开：第一段只写笔记里能直接看到的；其余各段每条开头标【推断】。",
    "2. 每条事实或线索末尾标注来源，格式 [笔记N]，N 是输入笔记的编号；禁止笼统说\"某条笔记\"。",
    "3. 不要补全笔记里没有的信息；没有证据就写\"未知\"。",
    "4. 不做人格或动机诊断，不替用户做决策。",
    "5. 某段确实没内容可写时写\"（无）\"，禁止硬凑。",
  ]) {
    assert.ok(INSIGHT_SYSTEM_PROMPT.includes(line), `洞察纪律应含：${line}`);
  }
});

test("1 建表列断言（照 pw-bets.test.ts 期望列范式）：幂等建表、七列齐全", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwNoteInsightTables(db);
    const columns = (db.prepare("PRAGMA table_info(pw_note_insights)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.deepEqual(columns, [
      "id",
      "bet_id",
      "keywords_json",
      "note_refs_json",
      "model",
      "report",
      "created_at",
    ]);
    // 再跑一次幂等：列结构不变
    ensurePwNoteInsightTables(db);
    assert.deepEqual(
      (db.prepare("PRAGMA table_info(pw_note_insights)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
      columns,
    );
  } finally {
    db.close();
  }
});

test("2 mock llm 跑通：prompt 含五段标题/押注标题/笔记全文/命中词；落行字段正确且可查", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      seedBet(papertable, { id: "bet-1", title: "全能力量测试", thesis: thesisOf("AI 全能力量验证") });
      insertMemo(notesWriter, { uid: "n-a", created_ts: 300, content: "全能 力量 能力 都在" });
      insertMemo(notesWriter, { uid: "n-b", created_ts: 200, content: "全能 力量 也有" });

      let calls = 0;
      let capturedPrompt = "";
      const fixedReport = "## 可核对的事实与原文线索\n- 笔记里写了全能 力量【事实】[笔记1]\n\n## 反复出现的模式\n（无）";
      const llm = async (prompt: string): Promise<string> => {
        calls += 1;
        capturedPrompt = prompt;
        return fixedReport;
      };

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const row = await runPwNoteInsight(papertable, "bet-1", {
          llm,
          modelLabel: "mock-insight",
          now: () => "2026-08-10T00:00:00.000Z",
        });
        assert.equal(calls, 1, "成功路径只调一次模型");

        // prompt 装配内容：五段标题 / 押注标题 / 笔记全文 / 命中词
        for (const header of [
          "## 可核对的事实与原文线索",
          "## 反复出现的模式",
          "## 当前主要矛盾",
          "## 尚未证实的假设",
          "## 一个最小验证动作",
        ]) {
          assert.ok(capturedPrompt.includes(header), `prompt 应含五段标题：${header}`);
        }
        assert.match(capturedPrompt, /押注标题：全能力量测试/);
        assert.match(capturedPrompt, /AI 全能力量验证/, "prompt 含 thesis 原文");
        assert.match(capturedPrompt, /捞取关键词：/);
        assert.match(capturedPrompt, /全能/);
        assert.match(capturedPrompt, /\[笔记1\]/, "命中笔记逐条编号 [笔记N]");
        assert.match(capturedPrompt, /全能 力量 能力 都在/, "prompt 含笔记全文");
        assert.match(capturedPrompt, /命中词：/);

        // 落行字段
        assert.equal(row.bet_id, "bet-1");
        assert.deepEqual(JSON.parse(row.keywords_json) as string[], [
          "全能", "能力", "力量", "量测", "测试", "AI", "量验", "验证",
        ]);
        const noteRefs = JSON.parse(row.note_refs_json) as Array<Record<string, unknown>>;
        assert.deepEqual(noteRefs, [
          { uid: "n-a", url: "http://127.0.0.1:5230/memos/n-a", createdAt: rowToIso(300), matchedKeywords: ["全能", "能力", "力量"] },
          { uid: "n-b", url: "http://127.0.0.1:5230/memos/n-b", createdAt: rowToIso(200), matchedKeywords: ["全能", "力量"] },
        ]);
        assert.equal(row.model, "mock-insight", "注入 llm 时 model 记 modelLabel");
        assert.equal(row.report, fixedReport, "报告原文落库不改写");
        assert.equal(row.created_at, "2026-08-10T00:00:00.000Z");

        // 落库可查
        const stored = papertable.prepare("SELECT * FROM pw_note_insights WHERE id = ?").get(row.id) as
          | { model: string | null }
          | undefined;
        assert.ok(stored, "落库可查");
        assert.equal(stored.model, "mock-insight");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("3 0 命中：400 带捞取词、不调模型（计数 0）、不落行；押注不存在 404", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 押注关键词非空但笔记库没有任何命中（量子计算机与极低温 → 8 个二字组）
      seedBet(papertable, { id: "bet-nomatch", title: "量子计算机与极低温" });
      insertMemo(notesWriter, { uid: "unrelated", created_ts: 100, content: "完全无关的日常记录" });

      let calls = 0;
      const llm = async (): Promise<string> => {
        calls += 1;
        return "不应被调用";
      };

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        await assert.rejects(
          runPwNoteInsight(papertable, "bet-nomatch", { llm }),
          (error: unknown) => {
            assertStatus(error, 400);
            assert.match(String((error as Error).message), /没有捞到相关旧笔记/);
            assert.match(String((error as Error).message), /量子/, "400 消息带捞取词");
            return true;
          },
        );
        assert.equal(calls, 0, "0 命中不调模型");
        assert.equal(countInsights(papertable), 0, "0 命中不落行");
      });

      // 押注不存在 → 404（getPwBet 先短路，不触笔记库）
      await assert.rejects(
        runPwNoteInsight(papertable, "no-such-bet", { llm }),
        (error: unknown) => {
          assertStatus(error, 404);
          return true;
        },
      );
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("4 重试：llm 首次抛错 → 重试 1 次成功；两次都败 → 502、不落行；空文本同样算失败", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      seedBet(papertable, { id: "bet-1", title: "全能力量测试" });
      insertMemo(notesWriter, { uid: "n-a", created_ts: 300, content: "全能 力量 能力 都在" });

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        // 首次抛错 → 重试 1 次成功
        let attempts = 0;
        const flaky = async (): Promise<string> => {
          attempts += 1;
          if (attempts === 1) throw new Error("瞬时失败");
          return "## 可核对的事实与原文线索\n（无）";
        };
        const row = await runPwNoteInsight(papertable, "bet-1", { llm: flaky, modelLabel: "mock" });
        assert.equal(attempts, 2, "首次失败应重试 1 次");
        assert.equal(row.report, "## 可核对的事实与原文线索\n（无）");
        assert.equal(countInsights(papertable), 1, "重试成功后落 1 行");

        // 两次都败 → 502、不落行
        let attempts2 = 0;
        const alwaysFail = async (): Promise<string> => {
          attempts2 += 1;
          throw new Error("模型彻底失败");
        };
        const before = countInsights(papertable);
        await assert.rejects(
          runPwNoteInsight(papertable, "bet-1", { llm: alwaysFail }),
          (error: unknown) => {
            assertStatus(error, 502);
            assert.match(String((error as Error).message), /模型调用失败/);
            return true;
          },
        );
        assert.equal(attempts2, 2, "两败应各调一次（共 2 次）");
        assert.equal(countInsights(papertable), before, "两败不落行");

        // 空文本也触发重试（算异常）：两次都空 → 502
        const emptyLlm = async (): Promise<string> => "";
        await assert.rejects(
          runPwNoteInsight(papertable, "bet-1", { llm: emptyLlm }),
          (error: unknown) => {
            assertStatus(error, 502);
            return true;
          },
        );
        assert.equal(countInsights(papertable), before, "空文本两败不落行");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("5 list：created_at DESC, id DESC 排序 + betId 过滤", () => {
  const db = makePapertableDb();
  try {
    const insertRow = (id: string, betId: string, createdAt: string): void => {
      db.prepare(`
        INSERT INTO pw_note_insights(
          id, bet_id, keywords_json, note_refs_json, model, report, created_at
        ) VALUES(?, ?, '[]', '[]', 'mock', ?, ?)
      `).run(id, betId, `报告-${id}`, createdAt);
    };
    insertRow("i-old", "bet-a", "2026-08-01T00:00:00.000Z");
    insertRow("i-new", "bet-a", "2026-08-03T00:00:00.000Z");
    insertRow("i-same1", "bet-a", "2026-08-02T00:00:00.000Z");
    insertRow("i-same2", "bet-a", "2026-08-02T00:00:00.000Z");
    insertRow("i-other", "bet-b", "2026-08-04T00:00:00.000Z");

    const forA = listPwNoteInsights(db, "bet-a");
    assert.deepEqual(
      forA.map((row) => row.id),
      ["i-new", "i-same2", "i-same1", "i-old"],
      "created_at DESC，同时刻按 id DESC",
    );
    assert.ok(forA.every((row) => row.bet_id === "bet-a"), "betId 过滤");

    const forB = listPwNoteInsights(db, "bet-b");
    assert.deepEqual(forB.map((row) => row.id), ["i-other"]);

    assert.deepEqual(listPwNoteInsights(db, "no-such-bet"), [], "无记录 betId → []");
  } finally {
    db.close();
  }
});

test("6 publicPwNoteInsight：JSON 列解析成数组 + camelCase，坏 JSON 兜底空数组", () => {
  const row = {
    id: "i-1",
    bet_id: "bet-a",
    keywords_json: '["选题","harness"]',
    note_refs_json: '[{"uid":"u1","url":"http://x","createdAt":"2026-08-01","matchedKeywords":["选题"]}]',
    model: "mock-model",
    report: "五段报告",
    created_at: "2026-08-10T00:00:00.000Z",
  };
  const pub = publicPwNoteInsight(row);
  assert.equal(pub.betId, "bet-a");
  assert.equal(pub.createdAt, row.created_at);
  assert.deepEqual(pub.keywords, ["选题", "harness"]);
  assert.deepEqual(pub.noteRefs, [
    { uid: "u1", url: "http://x", createdAt: "2026-08-01", matchedKeywords: ["选题"] },
  ]);
  assert.equal(pub.model, "mock-model");

  const broken = publicPwNoteInsight({ ...row, keywords_json: "oops", note_refs_json: "{}" });
  assert.deepEqual(broken.keywords, [], "坏 JSON 兜底空数组");
  assert.deepEqual(broken.noteRefs, [], "非数组兜底空数组");
});

/** Unix 秒 → 与 pw-notes 同口径的本地 ISO（带时区偏移）；仅测试内对齐断言用。 */
function rowToIso(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
