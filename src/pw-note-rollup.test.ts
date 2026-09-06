/**
 * TASK-PW-58：笔记自动卷积后端测试（覆盖规格 10–16 + 表结构与纪律常量）。
 * 覆盖：日报卷出与幂等、无料跳过/今天不卷、周报三态（齐全才卷/缺一天不卷/本周不卷）、
 * 月报三态（齐全才卷/缺一周不卷/本月不卷）、每轮 5 条上限与最近优先、llm 连败不落行
 * 下轮重试、readPwNotesByDay 跨日边界与升序。
 * 镇纸 mock 库走内存库（pw_note_rollups 正式建表），Memos mock 库沿用
 * pw-note-recall.test.ts 的 tmp 目录 + WAL 范式，经 MEMOS_DB_PATH 覆盖指向——绝不触碰真实 Memos 库。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readPwNotesByDay } from "./pw-notes.ts";
import {
  ROLLUP_SYSTEM_PROMPT,
  ensurePwNoteRollupTables,
  listPwNoteRollups,
  publicPwNoteRollup,
  runPwNoteRollupTick,
} from "./pw-note-rollup.ts";

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

/** 插入一条笔记：created_ts 用本地时刻构造（时区无关），content 自定。 */
function insertMemo(
  db: DatabaseSync,
  row: { uid: string; created_ts: number; content: string },
): void {
  db.prepare(`
    INSERT INTO memo(uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
    VALUES(?, 1, ?, ?, 'NORMAL', ?, 'PRIVATE', 0, NULL)
  `).run(row.uid, row.created_ts, row.created_ts, row.content);
}

/** 镇纸 mock 库：pw_note_rollups 正式建表。 */
function makePapertableDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwNoteRollupTables(db);
  return db;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-note-rollup-"));
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

/** 本地时刻 → Unix 秒（YYYY-MM-DD + HH:mm，无时区标记按本地解析，测试跨时区稳定）。 */
function localTs(date: string, time: string): number {
  return Math.floor(new Date(`${date}T${time}`).getTime() / 1000);
}

/** 本地时刻 → ISO（UTC，供注入 now；模块内部再转回本地比较，口径自洽）。 */
function nowIso(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString();
}

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

function countRollups(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM pw_note_rollups").get() as { n: number }).n);
}

function rollupRows(db: DatabaseSync): Array<{ kind: string; period: string }> {
  return db.prepare("SELECT kind, period FROM pw_note_rollups").all() as Array<{
    kind: string;
    period: string;
  }>;
}

function rollupBy(db: DatabaseSync, kind: string, period: string) {
  return db.prepare("SELECT * FROM pw_note_rollups WHERE kind = ? AND period = ?")
    .get(kind, period) as
    | { id: string; kind: string; period: string; source_refs_json: string; source_count: number; model: string | null; report: string; created_at: string }
    | undefined;
}

/** 《卷积纪律》必须逐字含规格写死的五段标题与纪律条目。 */
test("0 卷积纪律 systemPrompt 逐字含五段标题与纪律", () => {
  for (const line of [
    "## 事实",
    "## 模式",
    "## 矛盾",
    "## 假设",
    "## 最小验证",
    "1. 事实与推断必须分开：第一段只写来源里能直接看到的；其余各段每条开头标【推断】。",
    "2. 每条事实或线索末尾标注来源，格式 [笔记N]/[日报N]/[周报N]，N 是输入来源的编号；禁止笼统说\"某条笔记\"或\"某份报告\"。",
    "3. 不要补全来源里没有的信息；没有证据就写\"未知\"。",
    "4. 不做人格或动机诊断，不替用户做决策。",
    "5. 某段确实没内容可写时写\"（无）\"，禁止硬凑。",
  ]) {
    assert.ok(ROLLUP_SYSTEM_PROMPT.includes(line), `卷积纪律应含：${line}`);
  }
});

test("1 建表列断言（照 pw-bets.test.ts 期望列范式）：幂等建表、八列齐全、UNIQUE(kind,period) 幂等", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensurePwNoteRollupTables(db);
    const columns = (db.prepare("PRAGMA table_info(pw_note_rollups)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.deepEqual(columns, [
      "id",
      "kind",
      "period",
      "source_refs_json",
      "source_count",
      "model",
      "report",
      "created_at",
    ]);
    // 再跑一次幂等：列结构不变
    ensurePwNoteRollupTables(db);
    assert.deepEqual(
      (db.prepare("PRAGMA table_info(pw_note_rollups)").all() as Array<{ name: string }>)
        .map(({ name }) => name),
      columns,
    );
    // UNIQUE(kind, period) + INSERT OR IGNORE：同期重复插入被忽略
    db.prepare(`
      INSERT OR IGNORE INTO pw_note_rollups(
        id, kind, period, source_refs_json, source_count, model, report, created_at
      ) VALUES(?, 'day', '2026-08-09', '[]', 0, NULL, '报告', '2026-08-10T00:00:00.000Z')
    `).run("r-1");
    const second = db.prepare(`
      INSERT OR IGNORE INTO pw_note_rollups(
        id, kind, period, source_refs_json, source_count, model, report, created_at
      ) VALUES(?, 'day', '2026-08-09', '[]', 0, NULL, '报告', '2026-08-10T00:00:00.000Z')
    `).run("r-2");
    assert.equal(second.changes, 0, "UNIQUE 冲突被 INSERT OR IGNORE 忽略");
    assert.equal(countRollups(db), 1);
  } finally {
    db.close();
  }
});

test("2 日报：当天 2 条笔记 → kind=day/period/source_refs/report 落库；同期重复 tick 不重复生成", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      insertMemo(notesWriter, { uid: "n-a", created_ts: localTs("2026-08-09", "09:00"), content: "今天记了选题 A" });
      insertMemo(notesWriter, { uid: "n-b", created_ts: localTs("2026-08-09", "18:30"), content: "晚上补一条执行复盘" });

      let calls = 0;
      const prompts: string[] = [];
      const fixedReport = "## 事实\n- 记了两条 [笔记1][笔记2]\n\n## 模式\n（无）";
      const llm = async (prompt: string): Promise<string> => {
        calls += 1;
        prompts.push(prompt);
        return fixedReport;
      };
      const now = nowIso("2026-08-10", "23:59");

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        // 2 条笔记卷成 1 份日报，日报补齐后同轮再卷 1 份周报（W32 唯一有料日=08-09）
        const generated = await runPwNoteRollupTick(papertable, { llm, modelLabel: "mock-rollup", now: () => now });
        assert.equal(generated, 2, "1 份日报 + 同轮卷 1 份周报");
        assert.equal(calls, 2, "成功路径每期只调一次模型");

        // 日报 prompt 装配：期、来源编号、五段标题
        const dayPrompt = prompts[0];
        assert.match(dayPrompt, /卷积期：2026-08-09（日报，2 条笔记）/);
        assert.match(dayPrompt, /来源（共 2 条，逐条编号）：/);
        assert.match(dayPrompt, /\[笔记1\]（2026-08-09T09:00:00/);
        assert.match(dayPrompt, /\[笔记2\]（2026-08-09T18:30:00/);
        assert.match(dayPrompt, /今天记了选题 A/);
        for (const header of ["## 事实", "## 模式", "## 矛盾", "## 假设", "## 最小验证"]) {
          assert.ok(dayPrompt.includes(header), `prompt 应含五段标题：${header}`);
        }
        // 周报 prompt：由日报编号来源
        assert.match(prompts[1], /卷积期：2026-W32（周报，1 条日报）/);
        assert.match(prompts[1], /\[日报1\]（2026-08-09）/);

        const row = rollupBy(papertable, "day", "2026-08-09");
        assert.ok(row, "日报落库可查");
        assert.equal(row!.kind, "day");
        assert.equal(row!.period, "2026-08-09");
        assert.deepEqual(JSON.parse(row!.source_refs_json) as Array<Record<string, unknown>>, [
          { uid: "n-a", url: "http://127.0.0.1:5230/memos/n-a", createdAt: rowToIso(localTs("2026-08-09", "09:00")) },
          { uid: "n-b", url: "http://127.0.0.1:5230/memos/n-b", createdAt: rowToIso(localTs("2026-08-09", "18:30")) },
        ]);
        assert.equal(row!.source_count, 2);
        assert.equal(row!.model, "mock-rollup", "注入 llm 时 model 记 modelLabel");
        assert.equal(row!.report, fixedReport, "报告原文落库不改写");
        assert.equal(row!.created_at, now);

        // 同期重复 tick：不重复生成（幂等）
        const again = await runPwNoteRollupTick(papertable, { llm, modelLabel: "mock-rollup", now: () => now });
        assert.equal(again, 0, "已卷过的期不再生成");
        assert.equal(calls, 2, "无新候选不调模型");
        assert.equal(countRollups(papertable), 2);
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("3 无笔记的日子跳过；今天不生成", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      insertMemo(notesWriter, { uid: "a", created_ts: localTs("2026-08-08", "10:00"), content: "昨天之前的笔记" });
      insertMemo(notesWriter, { uid: "b", created_ts: localTs("2026-08-10", "11:00"), content: "今天的笔记（未结束）" });

      let calls = 0;
      const llm = async (): Promise<string> => {
        calls += 1;
        return "## 事实\n（无）";
      };
      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const generated = await runPwNoteRollupTick(papertable, {
          llm,
          now: () => nowIso("2026-08-10", "23:59"),
        });
        // 1 份日报（08-08）+ 该日报补齐后同轮卷出的周报（W31：07-27..08-02，唯一有料日=08-08）
        assert.equal(generated, 2, "只卷已结束且有笔记的 08-08（及由此补齐的周）");
        assert.equal(calls, 2, "今天不算候选；无笔记的日子不算候选");
        const dayPeriods = rollupRows(papertable).filter((r) => r.kind === "day").map((r) => r.period);
        assert.deepEqual(dayPeriods, ["2026-08-08"]);
        assert.equal(rollupBy(papertable, "day", "2026-08-10"), undefined, "今天不生成");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("4 周报：本周有笔记的日子都有日报 → 卷出 kind=week；缺一天日报的周不卷；本周不生成", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 2026-W32 = 08-03（周一）..08-09；2026-W33 = 08-10..08-16（当前周，now=周三）
      insertMemo(notesWriter, { uid: "a", created_ts: localTs("2026-08-03", "09:00"), content: "周一笔记" });
      insertMemo(notesWriter, { uid: "b", created_ts: localTs("2026-08-04", "09:00"), content: "周二笔记" });
      insertMemo(notesWriter, { uid: "c", created_ts: localTs("2026-08-05", "09:00"), content: "周三笔记" });
      insertMemo(notesWriter, { uid: "d", created_ts: localTs("2026-08-11", "09:00"), content: "本周（W33）笔记" });

      // 阶段 1：周二（08-04）日报生成失败 → W32 缺一天日报 → 周报不卷；W33 未结束不卷
      const phase1Llm = async (prompt: string): Promise<string> => {
        if (prompt.includes("周二笔记")) throw new Error("08-04 日报生成失败");
        return "## 事实\n- 今天记了东西\n\n## 模式\n（无）";
      };
      const phase2Llm = async (): Promise<string> => "## 事实\n- 汇总\n\n## 模式\n（无）";

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const first = await runPwNoteRollupTick(papertable, {
          llm: phase1Llm,
          now: () => nowIso("2026-08-12", "23:00"),
        });
        assert.equal(first, 3, "三份日报（08-03/08-05/08-11），08-04 失败跳过");
        const dayPeriods = rollupRows(papertable).filter((r) => r.kind === "day").map((r) => r.period).sort();
        assert.deepEqual(dayPeriods, ["2026-08-03", "2026-08-05", "2026-08-11"]);
        assert.equal(rollupBy(papertable, "week", "2026-W32"), undefined, "缺一天日报的周不卷");
        assert.equal(rollupBy(papertable, "week", "2026-W33"), undefined, "本周不生成");

        // 阶段 2：模型恢复 → 补 08-04 日报，W32 齐全后卷出周报；W33 仍不卷
        const second = await runPwNoteRollupTick(papertable, {
          llm: phase2Llm,
          now: () => nowIso("2026-08-12", "23:00"),
        });
        assert.equal(second, 2, "补 1 份日报 + 卷 1 份周报");
        const week = rollupBy(papertable, "week", "2026-W32");
        assert.ok(week, "W32 周报落库");
        assert.equal(week!.kind, "week");
        assert.equal(week!.source_count, 3, "W32 由三份日报卷成");
        assert.deepEqual(
          (JSON.parse(week!.source_refs_json) as Array<{ id: string; period: string }>)
            .map((ref) => ref.period),
          ["2026-08-03", "2026-08-04", "2026-08-05"],
          "来源按时间正序编号",
        );
        assert.equal(rollupBy(papertable, "week", "2026-W33"), undefined, "本周（W33）仍不生成");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("5 月报：本月内有日报的周都有周报 → 卷出 kind=month；缺一周周报的月不卷；本月不生成", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 2026-07：W28=07-06..07-12、W29=07-13..07-19；2026-08：W32=08-03..08-09（当前月）
      insertMemo(notesWriter, { uid: "a", created_ts: localTs("2026-07-06", "09:00"), content: "七月一" });
      insertMemo(notesWriter, { uid: "b", created_ts: localTs("2026-07-08", "09:00"), content: "七月二" });
      insertMemo(notesWriter, { uid: "c", created_ts: localTs("2026-07-15", "09:00"), content: "七月三" });
      insertMemo(notesWriter, { uid: "d", created_ts: localTs("2026-08-05", "09:00"), content: "八月一" });

      // 阶段 1：周报生成全失败（prompt 含 [日报）→ 七月缺一周周报不卷、八月缺周报不卷
      const phase1Llm = async (prompt: string): Promise<string> => {
        if (prompt.includes("[日报")) throw new Error("周报生成失败");
        return "## 事实\n- 有料\n\n## 模式\n（无）";
      };
      const phase2Llm = async (): Promise<string> => "## 事实\n- 月度汇总\n\n## 模式\n（无）";

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const first = await runPwNoteRollupTick(papertable, {
          llm: phase1Llm,
          now: () => nowIso("2026-08-15", "12:00"),
        });
        // 日报配额 ≤3：候选 4 天只出 3 份（08-05/07-15/07-08 最近优先），07-06 留到下一轮
        assert.equal(first, 3, "日报配额 ≤3（候选 4 个只出 3 份）");
        assert.equal(countRollups(papertable), 3);
        assert.equal(rollupBy(papertable, "month", "2026-07"), undefined, "缺一周周报的月不卷");
        assert.equal(rollupBy(papertable, "month", "2026-08"), undefined, "本月不卷");

        // 阶段 2：模型恢复 → 逐轮补齐（日报每轮 ≤3、周报每轮 ≤1），七月齐全后卷出月报；八月仍不卷
        for (let i = 0; i < 10; i += 1) {
          const n = await runPwNoteRollupTick(papertable, {
            llm: phase2Llm,
            now: () => nowIso("2026-08-15", "12:00"),
          });
          if (n === 0) break;
        }
        const weekPeriods = rollupRows(papertable).filter((r) => r.kind === "week").map((r) => r.period).sort();
        assert.deepEqual(weekPeriods, ["2026-W28", "2026-W29", "2026-W32"]);
        const month = rollupBy(papertable, "month", "2026-07");
        assert.ok(month, "七月月报落库");
        assert.equal(month!.kind, "month");
        assert.equal(month!.source_count, 2, "七月由两周报卷成");
        assert.deepEqual(
          (JSON.parse(month!.source_refs_json) as Array<{ id: string; period: string }>)
            .map((ref) => ref.period),
          ["2026-W28", "2026-W29"],
          "来源按时间正序编号",
        );
        assert.equal(rollupBy(papertable, "month", "2026-08"), undefined, "本月（2026-08）不生成");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("6 每轮预算分层：日报候选 8 个且无周可卷时一轮只出 3 条（配额不转给下层）；期按最近优先；逐轮补齐后周报按周配额 1 卷出", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 连续 8 个已结束的日子（2026-08-02..08-09），每天一条笔记
      for (let day = 2; day <= 9; day += 1) {
        const date = `2026-08-0${day}`;
        insertMemo(notesWriter, { uid: `n-${day}`, created_ts: localTs(date, "10:00"), content: `第${day}天笔记` });
      }
      const llm = async (): Promise<string> => "## 事实\n- 有料\n\n## 模式\n（无）";

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const first = await runPwNoteRollupTick(papertable, {
          llm,
          now: () => nowIso("2026-08-10", "12:00"),
        });
        assert.equal(first, 3, "日报配额 ≤3：候选 8 个也只出 3 条，配额不挪给周报/月报");
        const firstDays = rollupRows(papertable).filter((r) => r.kind === "day").map((r) => r.period).sort();
        assert.deepEqual(
          firstDays,
          ["2026-08-07", "2026-08-08", "2026-08-09"],
          "最近优先：先卷最近 3 天",
        );
        assert.equal(
          rollupRows(papertable).filter((r) => r.kind === "week").length,
          0,
          "W31/W32 都还没凑齐日报，本轮周报配额闲置也不转给日报",
        );

        // 逐轮补齐（日报每轮 ≤3、周报每轮 ≤1），直至无事可做
        for (let i = 0; i < 20; i += 1) {
          const n = await runPwNoteRollupTick(papertable, {
            llm,
            now: () => nowIso("2026-08-10", "12:00"),
          });
          if (n === 0) break;
        }
        assert.equal(
          rollupRows(papertable).filter((r) => r.kind === "day").length,
          8,
          "8 天日报全部补齐",
        );
        const weekPeriods = rollupRows(papertable).filter((r) => r.kind === "week").map((r) => r.period).sort();
        assert.deepEqual(weekPeriods, ["2026-W31", "2026-W32"], "日报补齐后周报逐轮卷出（每周配额 1）");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("6b 每轮预算分层：日报候选 5+ 且周/月可卷时，一轮出 3 日报 + 1 周报 + 1 月报（合计 5）；期按最近优先", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      // 预置：六月月报可卷（W23/W24 日报+周报齐）；W32（08-05..08-09）日报齐但周报缺 → 可卷周
      const seed = (id: string, kind: string, period: string, refs: string, sourceCount: number): void => {
        papertable.prepare(`
          INSERT INTO pw_note_rollups(
            id, kind, period, source_refs_json, source_count, model, report, created_at
          ) VALUES(?, ?, ?, ?, ?, 'mock', '预置报告', '2026-08-14T00:00:00.000Z')
        `).run(id, kind, period, refs, sourceCount);
      };
      const dayRef = (uid: string, date: string): string =>
        `[{"uid":"${uid}","url":"http://127.0.0.1:5230/memos/${uid}","createdAt":"${date}T10:00:00+08:00"}]`;
      const weekRef = (dayId: string, dayPeriod: string): string =>
        `[{"id":"${dayId}","period":"${dayPeriod}"}]`;
      seed("d-0603", "day", "2026-06-03", dayRef("u0603", "2026-06-03"), 1);
      seed("d-0610", "day", "2026-06-10", dayRef("u0610", "2026-06-10"), 1);
      seed("w-23", "week", "2026-W23", weekRef("d-0603", "2026-06-03"), 1);
      seed("w-24", "week", "2026-W24", weekRef("d-0610", "2026-06-10"), 1);
      for (let day = 5; day <= 9; day += 1) {
        const date = `2026-08-0${day}`;
        seed(`d-08-0${day}`, "day", date, dayRef(`u08${day}`, date), 1);
      }
      // 有料的日：六月两天、W32 五天、七月待卷五天（W28×4 + W29×1）→ 日报候选 = 七月 5 天（≥5）
      insertMemo(notesWriter, { uid: "u0603", created_ts: localTs("2026-06-03", "10:00"), content: "六月三" });
      insertMemo(notesWriter, { uid: "u0610", created_ts: localTs("2026-06-10", "10:00"), content: "六月十" });
      for (let day = 5; day <= 9; day += 1) {
        insertMemo(notesWriter, { uid: `u08${day}`, created_ts: localTs(`2026-08-0${day}`, "10:00"), content: `八月${day}` });
      }
      insertMemo(notesWriter, { uid: "p1", created_ts: localTs("2026-07-06", "10:00"), content: "七月六" });
      insertMemo(notesWriter, { uid: "p2", created_ts: localTs("2026-07-07", "10:00"), content: "七月七" });
      insertMemo(notesWriter, { uid: "p3", created_ts: localTs("2026-07-08", "10:00"), content: "七月八" });
      insertMemo(notesWriter, { uid: "p4", created_ts: localTs("2026-07-09", "10:00"), content: "七月九" });
      insertMemo(notesWriter, { uid: "p5", created_ts: localTs("2026-07-13", "10:00"), content: "七月十三" });

      let calls = 0;
      const llm = async (): Promise<string> => {
        calls += 1;
        return "## 事实\n- 有料\n\n## 模式\n（无）";
      };

      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const generated = await runPwNoteRollupTick(papertable, {
          llm,
          now: () => nowIso("2026-08-15", "12:00"),
        });
        // 3 份日报（最近 3 天）+ 1 份周报（W32 日报早齐）+ 1 份月报（六月早齐）= 合计 5
        assert.equal(generated, 5, "日报 3 + 周报 1 + 月报 1（合计 ≤5）");
        assert.equal(calls, 5, "每层各按配额调用一次模型");

        const dayPeriods = rollupRows(papertable).filter((r) => r.kind === "day").map((r) => r.period).sort();
        assert.deepEqual(
          dayPeriods,
          ["2026-06-03", "2026-06-10", "2026-07-08", "2026-07-09", "2026-07-13", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09"],
          "本轮只新增 3 份日报：07-13/07-09/07-08（最近优先），07-06/07-07 留到下轮",
        );
        assert.equal(rollupBy(papertable, "day", "2026-07-06"), undefined, "07-06 未到配额轮次");
        assert.equal(rollupBy(papertable, "day", "2026-07-07"), undefined, "07-07 未到配额轮次");

        assert.ok(rollupBy(papertable, "week", "2026-W32"), "周报配额 1：W32 本轮卷出");
        assert.equal(rollupBy(papertable, "week", "2026-W29"), undefined, "周报配额用完，W29 不抢配额");

        const june = rollupBy(papertable, "month", "2026-06");
        assert.ok(june, "月报配额 1：六月月报本轮卷出");
        assert.equal(june!.source_count, 2);
        assert.deepEqual(
          (JSON.parse(june!.source_refs_json) as Array<{ id: string; period: string }>)
            .map((ref) => ref.period),
          ["2026-W23", "2026-W24"],
        );
        assert.equal(rollupBy(papertable, "month", "2026-07"), undefined, "七月周报没齐，月报不卷");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("7 llm 连续失败：不落行、下轮 tick 重试成功", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    const papertable = makePapertableDb();
    try {
      insertMemo(notesWriter, { uid: "a", created_ts: localTs("2026-08-09", "10:00"), content: "一条笔记" });

      let calls = 0;
      const alwaysFail = async (): Promise<string> => {
        calls += 1;
        throw new Error("模型彻底失败");
      };
      await withEnv({ MEMOS_DB_PATH: notesPath }, async () => {
        const first = await runPwNoteRollupTick(papertable, {
          llm: alwaysFail,
          now: () => nowIso("2026-08-10", "12:00"),
        });
        assert.equal(first, 0, "llm 两败不落行");
        assert.equal(calls, 2, "异常/空文本重试 1 次（共 2 次）");
        assert.equal(countRollups(papertable), 0, "失败不落行");

        // 下轮 tick：模型恢复 → 重试成功（补 08-09 日报 + 该周 W32 同轮卷出）
        const okLlm = async (): Promise<string> => "## 事实\n- 恢复成功\n\n## 模式\n（无）";
        const second = await runPwNoteRollupTick(papertable, {
          llm: okLlm,
          now: () => nowIso("2026-08-10", "12:00"),
        });
        assert.equal(second, 2, "下轮重试成功：补 1 份日报 + 同轮卷 1 份周报");
        const row = rollupBy(papertable, "day", "2026-08-09");
        assert.ok(row, "重试成功后日报落库");
        assert.equal(row!.report, "## 事实\n- 恢复成功\n\n## 模式\n（无）");
        assert.ok(rollupBy(papertable, "week", "2026-W32"), "日报补齐后周报同轮卷出");
      });
    } finally {
      notesWriter.close();
      papertable.close();
    }
  });
});

test("8 readPwNotesByDay：跨日边界、按 createdAt 升序", async () => {
  await withDir(async (dir) => {
    const notesPath = join(dir, "memos_prod.db");
    const notesWriter = makeMockDb(notesPath);
    try {
      insertMemo(notesWriter, { uid: "late-prev", created_ts: localTs("2026-08-09", "23:50"), content: "前一日深夜" });
      insertMemo(notesWriter, { uid: "early", created_ts: localTs("2026-08-10", "00:05"), content: "当日凌晨" });
      insertMemo(notesWriter, { uid: "mid", created_ts: localTs("2026-08-10", "09:00"), content: "当日上午" });
      insertMemo(notesWriter, { uid: "noon", created_ts: localTs("2026-08-10", "12:00"), content: "当日中午" });
      insertMemo(notesWriter, { uid: "early-next", created_ts: localTs("2026-08-11", "00:10"), content: "次日凌晨" });

      await withEnv({ MEMOS_DB_PATH: notesPath }, () => {
        const day = readPwNotesByDay("2026-08-10");
        assert.deepEqual(
          day.map((note) => note.uid),
          ["early", "mid", "noon"],
          "只含当日笔记，按 createdAt 升序",
        );
        assert.equal(day[0].createdAt.slice(0, 10), "2026-08-10", "createdAt 前 10 位即本地日期");
        assert.deepEqual(readPwNotesByDay("2026-08-09").map((note) => note.uid), ["late-prev"]);
        assert.deepEqual(readPwNotesByDay("2026-08-11").map((note) => note.uid), ["early-next"]);
        assert.throws(() => readPwNotesByDay("2026-8-10"), /YYYY-MM-DD/);
      });
    } finally {
      notesWriter.close();
    }
  });
});

test("9 listPwNoteRollups：kind 过滤 + period DESC 封顶 200；publicPwNoteRollup 解析 JSON 列", () => {
  const db = makePapertableDb();
  try {
    const insertRow = (
      id: string,
      kind: string,
      period: string,
      sourceRefsJson: string,
      sourceCount: number,
      createdAt: string,
    ): void => {
      db.prepare(`
        INSERT INTO pw_note_rollups(
          id, kind, period, source_refs_json, source_count, model, report, created_at
        ) VALUES(?, ?, ?, ?, ?, 'mock', '报告', ?)
      `).run(id, kind, period, sourceRefsJson, sourceCount, createdAt);
    };
    insertRow("r-week", "week", "2026-W32", '[{"id":"d1","period":"2026-08-03"},{"id":"d2","period":"2026-08-04"}]', 2, "2026-08-10T00:00:00.000Z");
    insertRow("r-day-old", "day", "2026-07-31", '[{"uid":"u1","url":"http://x","createdAt":"2026-07-31T10:00:00+08:00"}]', 1, "2026-08-01T00:00:00.000Z");
    insertRow("r-day-new", "day", "2026-08-09", '[]', 0, "2026-08-10T00:00:00.000Z");

    const days = listPwNoteRollups(db, { kind: "day" });
    assert.deepEqual(days.map((row) => row.period), ["2026-08-09", "2026-07-31"], "kind 过滤 + period DESC");

    const all = listPwNoteRollups(db);
    assert.deepEqual(
      all.map((row) => row.period),
      ["2026-W32", "2026-08-09", "2026-07-31"],
      "kind 缺省返回全部，period DESC",
    );

    const pub = publicPwNoteRollup(all[0]);
    assert.equal(pub.kind, "week");
    assert.equal(pub.createdAt, all[0].created_at);
    assert.deepEqual(pub.sourceRefs, [
      { id: "d1", period: "2026-08-03" },
      { id: "d2", period: "2026-08-04" },
    ]);
    assert.equal(pub.sourceCount, all[0].source_count);
    assert.equal(pub.model, "mock");

    const broken = publicPwNoteRollup({
      id: "x",
      kind: "day",
      period: "2026-08-09",
      source_refs_json: "oops",
      source_count: 1,
      model: null,
      report: "报告",
      created_at: "2026-08-10T00:00:00.000Z",
    });
    assert.deepEqual(broken.sourceRefs, [], "坏 JSON 兜底空数组");
  } finally {
    db.close();
  }
});
