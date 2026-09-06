/**
 * TASK-PW-39：笔记只读连接与读取函数测试。
 * 覆盖：五函数主路径与字段细节、WAL 可见性回归（钉死 immutable 陷阱）、
 * 零写入 sha256 对账、搜索转义、跨本地午夜按日统计、状态兜底、环境变量覆盖。
 * 全部走临时目录模拟 Memos 库（schema 照抄 TASK-PW-39 实测），绝不触碰真实 Memos 库
 * （~/Library/Application Support/memos/ 下任何东西都不读写）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getPwNotesDailyStats,
  getPwNotesStatus,
  getPwNotesTagCounts,
  queryPwNotesByKeywords,
  readPwNotesList,
  resolvePwNotesDbPath,
  searchPwNotes,
} from "./pw-notes.ts";

/** memo 表 schema 照抄 TASK-PW-39「已核验的库事实」（payload 简化，json_valid 仍能兜底） */
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
  row: {
    uid: string;
    created_ts: number;
    content: string;
    updated_ts?: number;
    visibility?: string;
    pinned?: number;
    payload?: string | null;
    row_status?: string;
  },
): void {
  db.prepare(`
    INSERT INTO memo(uid, creator_id, created_ts, updated_ts, row_status, content, visibility, pinned, payload)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.uid,
    1,
    row.created_ts,
    row.updated_ts ?? row.created_ts,
    row.row_status ?? "NORMAL",
    row.content,
    row.visibility ?? "PRIVATE",
    row.pinned ?? 0,
    row.payload ?? null,
  );
}

/** 临时目录生命周期：目录内库文件每次唯一，测试互不干扰。 */
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pw-notes-"));
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

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("list：created_ts 倒序、分页、默认 50 上限 200、归档排除、参数校验", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      const base = 1_700_000_000;
      for (let i = 0; i < 205; i++) {
        insertMemo(writer, {
          uid: `n-${String(i).padStart(3, "0")}`,
          created_ts: base - i,
          content: `笔记 #${i}`,
        });
      }
      insertMemo(writer, {
        uid: "arch-1",
        created_ts: base + 100,
        content: "归档笔记",
        row_status: "ARCHIVED",
      });
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        const all = readPwNotesList();
        assert.equal(all.length, 50, "默认 limit 50");
        assert.equal(all[0].uid, "n-000", "created_ts 倒序最新在前");
        assert.equal(all[49].uid, "n-049");
        assert.ok(!all.some((note) => note.uid === "arch-1"), "归档不返回");

        assert.deepEqual(
          readPwNotesList({ limit: 2, offset: 1 }).map((note) => note.uid),
          ["n-001", "n-002"],
        );
        assert.equal(readPwNotesList({ limit: 500 }).length, 200, "limit 上限 200");
        assert.equal(readPwNotesList({ offset: 999 }).length, 0);

        assert.throws(() => readPwNotesList({ limit: 0 }), /limit/);
        assert.throws(() => readPwNotesList({ limit: -1 }), /limit/);
        assert.throws(() => readPwNotesList({ limit: 1.5 }), /limit/);
        assert.throws(() => readPwNotesList({ offset: -1 }), /offset/);
        assert.throws(() => readPwNotesList({ offset: 1.5 }), /offset/);
      });
    } finally {
      writer.close();
    }
  });
});

test("search：命中/空串/默认 50；字段细节（tags 四态、pinned 布尔化、回链 url、visibility）", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, {
        uid: "a-1",
        created_ts: 1_700_000_000,
        content: "落座验证：镇纸能搜到我",
        visibility: "PUBLIC",
        pinned: 1,
        payload: JSON.stringify({ tags: ["镇纸", "笔记"] }),
      });
      insertMemo(writer, {
        uid: "a-2",
        created_ts: 1_699_000_000,
        content: "无标签无 pinned",
        payload: null,
      });
      insertMemo(writer, {
        uid: "a-3",
        created_ts: 1_698_000_000,
        content: "payload 非 JSON",
        payload: "not-json",
      });
      insertMemo(writer, {
        uid: "a-4",
        created_ts: 1_697_000_000,
        content: "payload tags 非数组",
        payload: JSON.stringify({ tags: "oops" }),
      });
      insertMemo(writer, {
        uid: "a-5",
        created_ts: 1_696_000_000,
        content: "这条是归档但含镇纸",
        row_status: "ARCHIVED",
        payload: JSON.stringify({ tags: ["镇纸"] }),
      });
      for (let i = 0; i < 55; i++) {
        insertMemo(writer, {
          uid: `bulk-${String(i).padStart(2, "0")}`,
          created_ts: 1_695_000_000 - i,
          content: "批量搜索命中 #" + i,
        });
      }

      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        const hits = searchPwNotes("镇纸");
        assert.ok(hits.some((note) => note.uid === "a-1"));
        assert.ok(!hits.some((note) => note.uid === "a-5"), "归档条目不出现在搜索里");

        const found = hits.find((note) => note.uid === "a-1")!;
        assert.deepEqual(found.tags, ["镇纸", "笔记"]);
        assert.equal(found.pinned, true);
        assert.equal(found.visibility, "PUBLIC");
        assert.equal(found.url, "http://127.0.0.1:5230/memos/a-1", "回链格式 {base}/memos/{uid}");
        assert.equal(new Date(found.createdAt).getTime(), 1_700_000_000_000, "createdAt 是含偏移的 ISO 本地时间");
        assert.match(found.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

        const bare = searchPwNotes("无标签").find((note) => note.uid === "a-2")!;
        assert.deepEqual(bare.tags, []);
        assert.equal(bare.pinned, false);

        assert.deepEqual(searchPwNotes("非 JSON").find((note) => note.uid === "a-3")!.tags, []);
        assert.deepEqual(searchPwNotes("非数组").find((note) => note.uid === "a-4")!.tags, []);

        assert.deepEqual(searchPwNotes(""), [], "空 query 返回 []");
        assert.deepEqual(searchPwNotes("   "), [], "空白 query 返回 []");

        assert.equal(searchPwNotes("批量搜索命中").length, 50, "search 默认 limit 50");
        assert.equal(searchPwNotes("批量搜索命中", { limit: 500 }).length, 55);

        // MEMOS_BASE_URL 覆盖 + 尾部斜杠清理
        withEnv(
          { MEMOS_DB_PATH: dbPath, MEMOS_BASE_URL: "http://memos.example.com/" },
          () => {
            assert.equal(
              searchPwNotes("镇纸").find((note) => note.uid === "a-1")!.url,
              "http://memos.example.com/memos/a-1",
            );
          },
        );
      });
    } finally {
      writer.close();
    }
  });
});

test("queryByKeywords：命中关键词数降序、同数 created_ts 倒序、matchedKeywords、空数组返回空", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, { uid: "k-1", created_ts: 1_700_000_000, content: "镇纸 落座 都在" });
      insertMemo(writer, { uid: "k-2", created_ts: 1_700_000_100, content: "只有镇纸" });
      insertMemo(writer, { uid: "k-3", created_ts: 1_700_000_200, content: "只有落座" });
      insertMemo(writer, { uid: "k-4", created_ts: 1_700_000_300, content: "都不沾边" });
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        const hits = queryPwNotesByKeywords(["镇纸", "落座"]);
        assert.deepEqual(
          hits.map((hit) => hit.uid),
          ["k-1", "k-3", "k-2"],
          "两词命中在前，同数按 created_ts 倒序",
        );
        assert.deepEqual(hits[0].matchedKeywords, ["镇纸", "落座"]);
        assert.deepEqual(hits[1].matchedKeywords, ["落座"]);
        assert.deepEqual(hits[2].matchedKeywords, ["镇纸"]);
        assert.equal(hits[0].url, "http://127.0.0.1:5230/memos/k-1", "PwNoteHit 含完整 PwNote 字段");

        assert.deepEqual(queryPwNotesByKeywords([]), [], "空关键词数组返回 []");
        assert.deepEqual(queryPwNotesByKeywords(["  "]), [], "全空白关键词返回 []");
      });
    } finally {
      writer.close();
    }
  });
});

test("WAL 可见性回归：可写连接插入不 checkpoint，只读函数必须读到（钉死 immutable 陷阱）", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, {
        uid: "wal-1",
        created_ts: 1_700_000_000,
        content: "WAL 未 checkpoint 的新笔记",
      });
      const walPath = dbPath + "-wal";
      assert.ok(existsSync(walPath), "WAL 文件应存在");
      assert.ok(readFileSync(walPath).length > 0, "数据应只落在 WAL 里（未 checkpoint）");
      // 模拟 Memos 常驻：writer 保持打开，不 close 不 checkpoint
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        assert.ok(
          readPwNotesList({ limit: 10 }).some((note) => note.uid === "wal-1"),
          "只读连接必须读到 WAL 新数据",
        );
        assert.ok(searchPwNotes("WAL").some((note) => note.uid === "wal-1"));
      });
    } finally {
      writer.close();
    }
  });
});

test("零写入：只读读取前后 db + -wal sha256 逐字节一致；只读连接 CREATE TABLE 必须抛错", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, { uid: "rw-1", created_ts: 1_700_000_000, content: "零写入验证" });
      const walPath = dbPath + "-wal";
      const before = fileSha(dbPath, walPath);
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        readPwNotesList({ limit: 10 });
        searchPwNotes("零写入");
        getPwNotesDailyStats({ days: 3 });
        queryPwNotesByKeywords(["零写入"]);
        getPwNotesTagCounts();
        assert.deepEqual(getPwNotesStatus(), { ok: true, path: dbPath });

        // 只读连接上任何写操作必须被 SQLite 拒绝
        const ro = new DatabaseSync(dbPath, { readOnly: true });
        try {
          assert.throws(() => ro.exec("CREATE TABLE hacker(x INTEGER)"), /readonly/i);
        } finally {
          ro.close();
        }
      });
      const after = fileSha(dbPath, walPath);
      assert.equal(after, before, "只读读取不得改动主库或 -wal 任何字节");
    } finally {
      writer.close();
    }
  });
});

test("搜索转义：100% 与 a_b 按字面匹配不炸；空 query 返回空数组", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, { uid: "e-1", created_ts: 1_700_000_000, content: "进度 100% 完成" });
      insertMemo(writer, { uid: "e-2", created_ts: 1_699_000_000, content: "进度 100 完成" });
      insertMemo(writer, { uid: "e-3", created_ts: 1_698_000_000, content: "a_b 分隔符" });
      insertMemo(writer, { uid: "e-4", created_ts: 1_697_000_000, content: "axb 分隔符" });
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        assert.deepEqual(
          searchPwNotes("100%").map((note) => note.uid),
          ["e-1"],
          "% 必须按字面匹配，不吞掉后面内容",
        );
        assert.deepEqual(
          searchPwNotes("a_b").map((note) => note.uid),
          ["e-3"],
          "_ 必须按字面匹配，不作单字符通配",
        );
        assert.deepEqual(queryPwNotesByKeywords(["100%"]).map((hit) => hit.uid), ["e-1"]);
        assert.deepEqual(searchPwNotes(""), []);
        assert.deepEqual(searchPwNotes("   "), []);
      });
    } finally {
      writer.close();
    }
  });
});

test("每日统计：跨本地午夜的两条记录落在不同日期；缺日补 0；日期连续", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      const now = new Date();
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const todayLater = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1, 0);
      insertMemo(writer, {
        uid: "d-1",
        created_ts: Math.floor(yesterday.getTime() / 1000),
        content: "昨晚 23:59:59",
      });
      insertMemo(writer, {
        uid: "d-2",
        created_ts: Math.floor(todayStart.getTime() / 1000),
        content: "今天 00:00:00",
      });
      insertMemo(writer, {
        uid: "d-3",
        created_ts: Math.floor(todayLater.getTime() / 1000),
        content: "今天 00:01:00",
      });
      // 前天（缺日）不插数据，用于验证补 0
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        const stats = getPwNotesDailyStats({ days: 3 });
        assert.equal(stats.length, 3, "返回连续日期段");
        const dayBefore = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
        assert.deepEqual(stats.map((s) => s.date), [
          localDateKey(dayBefore),
          localDateKey(yesterday),
          localDateKey(todayStart),
        ]);
        assert.deepEqual(stats.map((s) => s.count), [0, 1, 2], "缺日补 0，昨日 1 条今日 2 条");
        for (const stat of stats) assert.match(stat.date, /^\d{4}-\d{2}-\d{2}$/);
      });
    } finally {
      writer.close();
    }
  });
});

test("getPwNotesStatus：路径不存在 → ok:false 且 error 含路径；存在 → ok:true", async () => {
  await withDir(async (dir) => {
    const missing = join(dir, "missing.db");
    withEnv({ MEMOS_DB_PATH: missing }, () => {
      const status = getPwNotesStatus();
      assert.equal(status.ok, false);
      assert.equal(status.path, missing);
      assert.ok(status.error && status.error.includes(missing), "error 带路径信息");
    });

    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        assert.deepEqual(getPwNotesStatus(), { ok: true, path: dbPath });
      });
    } finally {
      writer.close();
    }
  });
});

test("MEMOS_DB_PATH 覆盖生效；缺省解析到 ~/Library/Application Support/memos/memos_prod.db", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "custom-memos.db");
    const writer = makeMockDb(dbPath);
    try {
      insertMemo(writer, { uid: "env-1", created_ts: 1_700_000_000, content: "环境变量指向的库" });
      withEnv({ MEMOS_DB_PATH: `  ${dbPath}  ` }, () => {
        assert.equal(resolvePwNotesDbPath(), dbPath, "env 覆盖且 trim 空白");
        assert.ok(readPwNotesList().some((note) => note.uid === "env-1"), "读的是覆盖后的库");
      });
      withEnv({ MEMOS_DB_PATH: undefined }, () => {
        assert.equal(
          resolvePwNotesDbPath(),
          join(homedir(), "Library", "Application Support", "memos", "memos_prod.db"),
        );
      });
    } finally {
      writer.close();
    }
  });
});

// TASK-PW-41：标签聚合计数（第七屏标签树原料）
test("tagCounts：多标签/嵌套标签/计数排序；坏 payload 与归档行不进统计；空库返回 []", async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, "memos_prod.db");
    const writer = makeMockDb(dbPath);
    try {
      const base = 1_700_000_000;
      insertMemo(writer, {
        uid: "t-1",
        created_ts: base,
        content: "双标签",
        payload: JSON.stringify({ tags: ["镇纸", "笔记"] }),
      });
      insertMemo(writer, {
        uid: "t-2",
        created_ts: base - 1,
        content: "嵌套标签",
        payload: JSON.stringify({ tags: ["镇纸/协作台", "镇纸"] }),
      });
      insertMemo(writer, {
        uid: "t-3",
        created_ts: base - 2,
        content: "无标签",
        payload: null,
      });
      insertMemo(writer, {
        uid: "t-4",
        created_ts: base - 3,
        content: "坏 payload",
        payload: "not-json",
      });
      insertMemo(writer, {
        uid: "t-5",
        created_ts: base - 4,
        content: "tags 非数组",
        payload: JSON.stringify({ tags: "oops" }),
      });
      insertMemo(writer, {
        uid: "t-6",
        created_ts: base - 5,
        content: "归档但含标签",
        row_status: "ARCHIVED",
        payload: JSON.stringify({ tags: ["幽灵"] }),
      });
      withEnv({ MEMOS_DB_PATH: dbPath }, () => {
        const tags = getPwNotesTagCounts();
        assert.deepEqual(tags, [
          { tag: "镇纸", count: 2 },
          { tag: "笔记", count: 1 },
          { tag: "镇纸/协作台", count: 1 },
        ], "count 降序、同数 tag 升序；嵌套标签原样返回不拆");
        assert.ok(!tags.some((row) => row.tag === "幽灵"), "归档行不进统计");
      });

      // 空库（只有无标签行）→ []
      const emptyPath = join(dir, "empty_prod.db");
      const emptyWriter = makeMockDb(emptyPath);
      try {
        insertMemo(emptyWriter, { uid: "e-1", created_ts: base, content: "无标签" });
        withEnv({ MEMOS_DB_PATH: emptyPath }, () => {
          assert.deepEqual(getPwNotesTagCounts(), []);
        });
      } finally {
        emptyWriter.close();
      }
    } finally {
      writer.close();
    }
  });
});
