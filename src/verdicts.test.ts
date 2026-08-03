import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDataStore, nowIso, type DataStore } from "./data.ts";
import type { PapertableEngine } from "./engine.ts";
import {
  normalizeVerdictInput,
  VerdictContractError,
  type RemoteVerdict,
  type VerdictInput,
  type VerdictRemote,
} from "./verdict-memos.ts";
import {
  abandonTombstone,
  confirmVerdict,
  ensureVerdictTables,
  extractCutRerouteRounds,
  extractVerdictUse,
  getVerdictStatus,
  loadVerdictContext,
  retryPendingVerdicts,
  rewriteRatio,
  supersedeVerdict,
  verdictEventStats,
  verdictInjectionBlock,
} from "./verdicts.ts";

function memoryRemote() {
  const records: RemoteVerdict[] = [];
  let fail = false;
  let writes = 0;
  const remote: VerdictRemote = {
    health: async () => {
      if (fail) throw new Error("offline");
      return { available: true, cubeId: "papertable-verdicts" };
    },
    ensureCube: async () => ({ cubeId: "papertable-verdicts", created: false }),
    list: async (projectId, query) => {
      if (fail) throw new Error("offline");
      const project = records.filter((item) => item.projectId === projectId);
      const superseded = new Set(project.map((item) => item.supersedesMemoryId).filter(Boolean));
      const needle = query?.toLocaleLowerCase();
      const matches = (item: RemoteVerdict) => !needle
        || item.content.toLocaleLowerCase().includes(needle)
        || item.concepts.some((concept) => {
          const value = concept.toLocaleLowerCase();
          return value.includes(needle) || needle.includes(value);
        });
      return {
        history: project.filter(matches),
        verdicts: project.filter((item) => !superseded.has(item.id) && matches(item)),
      };
    },
    confirm: async (input) => {
      if (fail) throw new Error("offline");
      const normalized = normalizeVerdictInput(input);
      const existing = records.find((item) => item.idempotencyKey === normalized.idempotencyKey);
      if (existing) return { verdict: existing, created: false };
      writes += 1;
      const verdict: RemoteVerdict = {
        id: `memory-${records.length + 1}`,
        ...normalized,
        status: "confirmed",
        supersedesMemoryId: null,
      };
      records.push(verdict);
      return { verdict, created: true };
    },
    supersede: async (memoryId, input) => {
      if (fail) throw new Error("offline");
      assert.ok(records.some((item) => item.id === memoryId));
      const normalized = normalizeVerdictInput(input, memoryId);
      const existing = records.find((item) => item.idempotencyKey === normalized.idempotencyKey);
      if (existing) return { verdict: existing, created: false };
      writes += 1;
      const verdict: RemoteVerdict = {
        id: `memory-${records.length + 1}`,
        ...normalized,
        status: "confirmed",
        supersedesMemoryId: memoryId,
      };
      records.push(verdict);
      return { verdict, created: true };
    },
  };
  return {
    remote,
    records,
    get writes() {
      return writes;
    },
    setFail(value: boolean) {
      fail = value;
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "papertable-verdicts-"));
  const store = openDataStore(directory);
  ensureVerdictTables(store.db);
  const now = nowIso();
  store.db.prepare(`
    INSERT INTO pt_projects(id, name, created_at, updated_at) VALUES('p', '项目', ?, ?)
  `).run(now, now);
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('source', 'p', 'session-source', '自动写笔记', 'root', NULL, NULL, ?, ?)
  `).run(now, now);
  store.db.prepare(`
    INSERT INTO pt_cards(
      id, project_id, session_id, title, branch_kind, source_card_id,
      branch_context_json, created_at, updated_at
    ) VALUES('target', 'p', 'session-target', '换方向', 'reroute', 'source', ?, ?, ?)
  `).run(JSON.stringify({ pendingQuestion: "为什么自动写笔记会失败？" }), now, now);
  store.db.prepare(`
    INSERT INTO pt_edges(
      id, project_id, source_card_id, target_card_id, kind, snapshot_json, created_at
    ) VALUES('edge-1', 'p', 'source', 'target', 'reroute', '{}', ?)
  `).run(now);
  const runCalls: string[] = [];
  const engine = {
    startRun: async (_cardId: string, question: string) => {
      runCalls.push(question);
      return "run-started";
    },
  } as PapertableEngine;
  return {
    store,
    engine,
    runCalls,
    async close() {
      store.db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function insertProposed(store: DataStore, id = "verdict-1") {
  const now = nowIso();
  store.db.prepare(`
    INSERT INTO pt_verdicts(
      id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
      created_at, updated_at, source_kind, source_id, concepts_json, original_text
    ) VALUES(?, 'p', 'target', NULL, 'tombstone', '旧草稿', NULL, 'proposed',
      'not_applicable', ?, ?, 'edge', 'edge-1', '["自动写笔记"]', '旧草稿')
  `).run(id, now, now);
}

function insertConfirmed(store: DataStore, id = "verdict-1") {
  const input: VerdictInput = {
    projectId: "p",
    verdictType: "tombstone",
    sourceKind: "edge",
    sourceId: "edge-1",
    content: "用户否决了自动写笔记。",
    concepts: ["自动写笔记"],
  };
  const normalized = normalizeVerdictInput(input);
  const now = nowIso();
  store.db.prepare(`
    INSERT INTO pt_verdicts(
      id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
      created_at, updated_at, source_kind, source_id, concepts_json, original_text,
      idempotency_key
    ) VALUES(?, 'p', 'target', NULL, 'tombstone', ?, NULL, 'confirmed', 'pending',
      ?, ?, 'edge', 'edge-1', '["自动写笔记"]', ?, ?)
  `).run(id, input.content, now, now, input.content, normalized.idempotencyKey);
}

test("double confirm mints once, records rewrite events and opens the gated first run", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  try {
    insertProposed(value.store);
    const [first, duplicate] = await Promise.all([
      confirmVerdict(value.store, value.engine, "verdict-1", "用户否决了自动写笔记。", memos.remote),
      confirmVerdict(value.store, value.engine, "verdict-1", "用户否决了自动写笔记。", memos.remote),
    ]);
    assert.equal(first.runId, "run-started");
    assert.equal(duplicate.runId, "run-started");
    assert.equal(memos.records.length, 1);
    assert.equal(memos.writes, 1);
    assert.equal(value.runCalls.length, 1);
    assert.deepEqual(verdictEventStats(value.store.db, "p"), {
      "tombstone-confirmed": 1,
      "tombstone-rewritten": 1,
    });
    const row = value.store.db.prepare(`
      SELECT memos_status, memos_memory_id, original_text, edit_ratio
      FROM pt_verdicts WHERE id = 'verdict-1'
    `).get() as Record<string, unknown>;
    assert.equal(row.memos_status, "submitted");
    assert.equal(row.memos_memory_id, "memory-1");
    assert.equal(row.original_text, "旧草稿");
    assert.ok(Number(row.edit_ratio) > 0);
  } finally {
    await value.close();
  }
});

test("abandon is explicit, writes no MemOS record and still opens the branch", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  try {
    insertProposed(value.store);
    const result = await abandonTombstone(value.store, value.engine, "verdict-1");
    assert.equal(result.runId, "run-started");
    assert.equal(memos.records.length, 0);
    assert.deepEqual(verdictEventStats(value.store.db, "p"), {
      "tombstone-abandoned": 1,
    });
    const row = value.store.db.prepare(
      "SELECT abandoned_at, memos_memory_id FROM pt_verdicts WHERE id = 'verdict-1'",
    ).get() as Record<string, unknown>;
    assert.equal(typeof row.abandoned_at, "string");
    assert.equal(row.memos_memory_id, null);
  } finally {
    await value.close();
  }
});

test("offline confirmation stays queued and later retry cannot duplicate it", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  try {
    insertConfirmed(value.store);
    memos.setFail(true);
    await retryPendingVerdicts(value.store, memos.remote);
    assert.equal(
      (value.store.db.prepare("SELECT memos_status FROM pt_verdicts WHERE id = 'verdict-1'").get() as { memos_status: string }).memos_status,
      "failed",
    );
    assert.deepEqual(await getVerdictStatus(value.store, memos.remote), {
      available: false,
      pending: 1,
      failed: 1,
      usingLocalCache: true,
      error: "offline",
    });
    memos.setFail(false);
    await retryPendingVerdicts(value.store, memos.remote);
    await retryPendingVerdicts(value.store, memos.remote);
    assert.equal(memos.records.length, 1);
    assert.equal(memos.writes, 1);
    assert.equal(
      (value.store.db.prepare("SELECT memos_status FROM pt_verdicts WHERE id = 'verdict-1'").get() as { memos_status: string }).memos_status,
      "submitted",
    );
    assert.deepEqual(await getVerdictStatus(value.store, memos.remote), {
      available: true,
      pending: 0,
      failed: 0,
      usingLocalCache: false,
    });
  } finally {
    await value.close();
  }
});

test("provide lists all valid chain tails without relevance matching, audits A/B plus local degradation", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  const oldSwitch = process.env.PAPERTABLE_VERDICT_INJECTION;
  try {
    insertConfirmed(value.store);
    insertProposed(value.store, "verdict-draft");
    await retryPendingVerdicts(value.store, memos.remote);
    // 无关问题同样提供全部有效链尾；proposed 不提供。
    const unrelated = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "天气怎么样？",
    }, memos.remote);
    assert.equal(unrelated.items.length, 1);
    assert.equal(unrelated.items[0].verdictType, "tombstone");
    assert.equal(unrelated.trace.availability, "available");
    assert.equal(unrelated.trace.source, "memos");
    assert.equal(unrelated.trace.providedTotal, 1);
    assert.equal(unrelated.trace.truncated, false);
    assert.match(verdictInjectionBlock(unrelated.items, "available"), /必须避开，无需标注/);
    assert.match(
      verdictInjectionBlock([{ id: "g1", verdictType: "gold", content: "结论" }], "available"),
      /标注令牌（原样照抄）：\[\[verdict:g1\]\]/,
    );

    // MemOS 不可用时降级到本地缓存，提供同一集合。
    memos.setFail(true);
    const degraded = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "为什么自动写笔记会失败？",
    }, memos.remote);
    assert.deepEqual(
      degraded.items.map((item) => item.id),
      unrelated.items.map((item) => item.id),
    );
    assert.equal(degraded.trace.availability, "degraded");
    assert.match(verdictInjectionBlock(degraded.items, "degraded"), /本机待同步\/缓存副本/);

    const invalidContract = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "为什么自动写笔记会失败？",
    }, {
      ...memos.remote,
      list: async () => {
        throw new VerdictContractError("bad record");
      },
    });
    assert.equal(invalidContract.trace.availability, "degraded");
    assert.equal(invalidContract.trace.unavailableCode, "invalid_remote_contract");

    // 远端不可用且本项目无有效判决时才是 unavailable。
    const unavailable = await loadVerdictContext(value.store, {
      projectId: "other",
      cardId: "target",
      question: "天气怎么样？",
    }, memos.remote);
    assert.deepEqual(unavailable.items, []);
    assert.equal(unavailable.trace.availability, "unavailable");
    assert.equal(unavailable.trace.source, "none");

    process.env.PAPERTABLE_VERDICT_INJECTION = "off";
    const abOff = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "自动写笔记",
    }, memos.remote);
    assert.deepEqual(abOff.items, []);
    assert.equal(abOff.trace.injectionEnabled, false);
    assert.equal(abOff.trace.verdicts.length, 1);
  } finally {
    if (oldSwitch === undefined) delete process.env.PAPERTABLE_VERDICT_INJECTION;
    else process.env.PAPERTABLE_VERDICT_INJECTION = oldSwitch;
    await value.close();
  }
});

test("provide caps at ten with deterministic order", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  try {
    const now = nowIso();
    for (let index = 1; index <= 11; index += 1) {
      value.store.db.prepare(`
        INSERT INTO pt_verdicts(
          id, project_id, card_id, run_id, kind, text, handle, status, memos_status,
          created_at, updated_at, source_kind, source_id, concepts_json, original_text
        ) VALUES(?, 'p', 'target', NULL, 'tombstone', ?, NULL, 'confirmed', 'pending',
          ?, ?, 'edge', 'edge-1', '["自动写笔记"]', ?)
      `).run(
        `verdict-${String(index).padStart(2, "0")}`,
        `判决 ${index}`,
        now,
        now,
        `判决 ${index}`,
      );
    }
    memos.setFail(true);
    const context = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "任意问题",
    }, memos.remote);
    assert.equal(context.items.length, 10);
    assert.equal(context.trace.providedTotal, 11);
    assert.equal(context.trace.truncated, true);
    const ids = context.items.map((item) => item.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
  } finally {
    await value.close();
  }
});

test("supersede writes a linked remote record and later recall sees only the replacement", async () => {
  const value = await fixture();
  const memos = memoryRemote();
  try {
    insertConfirmed(value.store);
    await retryPendingVerdicts(value.store, memos.remote);
    const replacement = await supersedeVerdict(
      value.store,
      "verdict-1",
      "用户否决了自动写笔记，因为未经确认的内容会被活埋。",
      undefined,
      memos.remote,
    );
    assert.equal(replacement.memosStatus, "submitted");
    assert.equal(memos.records.length, 2);
    assert.equal(memos.records[1].supersedesMemoryId, memos.records[0].id);
    const recalled = await loadVerdictContext(value.store, {
      projectId: "p",
      cardId: "target",
      question: "自动写笔记",
    }, memos.remote);
    assert.equal(recalled.items.length, 1);
    assert.match(recalled.items[0].content, /未经确认/);
  } finally {
    await value.close();
  }
});

test("reroute extraction keeps only complete cut rounds and helpers stay deterministic", () => {
  const rounds = extractCutRerouteRounds([
    { entryId: "u1", role: "user", text: "问题一" },
    { entryId: "a1", role: "assistant", text: "回答一" },
    { entryId: "u2", role: "user", text: "问题二" },
  ], "u1");
  assert.deepEqual(rounds.map((round) => round.user.entryId), ["u1"]);
  assert.equal(rewriteRatio("完全相同", "完全相同"), 0);

  const extraction = extractVerdictUse(
    "先参考 [[verdict:a]]。再参考 [[verdict:b]]，重复 [[verdict:a]]，伪造 [[verdict:x]]。",
    ["a", "b"],
  );
  assert.deepEqual(extraction.used, ["a", "b"]);
  assert.equal(extraction.unknownCount, 1);
  assert.deepEqual(extractVerdictUse("没有任何标注。", ["a"]).used, []);
  const unknownOnly = extractVerdictUse("只标未知 [[verdict:z]]。", []);
  assert.deepEqual(unknownOnly.used, []);
  assert.equal(unknownOnly.unknownCount, 1);
});
