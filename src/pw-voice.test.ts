import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  addPwVoiceItem,
  classifyPwVoiceItems,
  dropPwVoiceItem,
  ensurePwVoiceTables,
  listPwVoiceItems,
} from "./pw-voice.ts";
import { ensurePwRunTables } from "./pw-runs.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwVoiceTables(db);
  // TASK-PW-23：写动作模块内记账，测试库需有 pw_runs 账本
  ensurePwRunTables(db);
  return db;
}

test("录入只保存作者哈希，不保存昵称原文", () => {
  const db = database();
  try {
    const item = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "张三",
      content: "希望增加一个失败复盘栏目",
      capturedAt: "2026-08-04T00:00:00.000Z",
    });
    assert.match(item.author_hash, /^[0-9a-f]{64}$/);
    assert.equal(
      item.author_hash,
      createHash("sha256").update("张三", "utf8").digest("hex"),
    );
    const dump = JSON.stringify(db.prepare("SELECT * FROM pw_voice_items").all());
    assert.ok(!dump.includes("张三"));
  } finally {
    db.close();
  }
});

test("合法的 LLM JSON 会回写类型和 cluster", async () => {
  const db = database();
  try {
    const first = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "甲",
      content: "想看更多翻车复盘",
      capturedAt: "2026-08-04T00:00:00.000Z",
    });
    const second = addPwVoiceItem(db, {
      platform: "xiaohongshu",
      author: "乙",
      content: "这个标题太长了",
      capturedAt: "2026-08-04T00:01:00.000Z",
    });
    let prompt = "";
    await classifyPwVoiceItems(db, [first.id, second.id], async (value) => {
      prompt = value;
      return JSON.stringify([
        { id: first.id, signal_type: "topic_lead", cluster: "复盘" },
        { id: second.id, signal_type: "content_critique", cluster: "标题" },
      ]);
    });
    assert.match(prompt, /topic_lead/);
    assert.match(prompt, /想看更多翻车复盘/);
    const rows = listPwVoiceItems(db);
    const topic = rows.find((row) => row.id === first.id)!;
    const critique = rows.find((row) => row.id === second.id)!;
    assert.equal(topic.signal_type, "topic_lead");
    assert.equal(topic.cluster_id, "复盘");
    assert.equal(critique.signal_type, "content_critique");
    assert.equal(critique.cluster_id, "标题");
  } finally {
    db.close();
  }
});

test("坏 JSON 不阻断整批，条目保持未分拣", async () => {
  const db = database();
  try {
    const item = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "丙",
      content: "坏结果也不能让录入失败",
      capturedAt: "2026-08-04T00:02:00.000Z",
    });
    await assert.doesNotReject(
      classifyPwVoiceItems(db, [item.id], async () => "不是 JSON"),
    );
    assert.equal(listPwVoiceItems(db)[0].signal_type, null);
  } finally {
    db.close();
  }
});

test("丢弃必须有原因且保留原行", () => {
  const db = database();
  try {
    const item = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "丁",
      content: "重复广告",
      capturedAt: "2026-08-04T00:03:00.000Z",
    });
    assert.throws(() => dropPwVoiceItem(db, item.id, "   "), /reason 必填/);
    const dropped = dropPwVoiceItem(db, item.id, "广告噪音");
    assert.equal(dropped.dropped_reason, "广告噪音");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pw_voice_items").get().count, 1);
  } finally {
    db.close();
  }
});

test("列表支持按类型和未分拣过滤", async () => {
  const db = database();
  try {
    const topic = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "戊",
      content: "选题线索",
      capturedAt: "2026-08-04T00:04:00.000Z",
    });
    const unprocessed = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "己",
      content: "还没分拣",
      capturedAt: "2026-08-04T00:05:00.000Z",
    });
    await classifyPwVoiceItems(db, [topic.id], async () => JSON.stringify([
      { id: topic.id, signal_type: "topic_lead", cluster: "选题" },
    ]));
    assert.deepEqual(listPwVoiceItems(db, { signalType: "topic_lead" }).map((row) => row.id), [topic.id]);
    assert.deepEqual(listPwVoiceItems(db, { unprocessed: true }).map((row) => row.id), [unprocessed.id]);
  } finally {
    db.close();
  }
});

test("TASK-PW-50 分拣 prompt 含新纪律关键点：四类判定标准 / 拿不准返回 null / trae 对照示例", async () => {
  const db = database();
  try {
    const item = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "庚",
      content: "自从用过 trae 后，感觉这些兴起的 ide 都比 cursor 差远了[笑哭]",
      capturedAt: "2026-08-04T00:06:00.000Z",
    });
    let prompt = "";
    await classifyPwVoiceItems(db, [item.id], async (value) => {
      prompt = value;
      return JSON.stringify([{ id: item.id, signal_type: "topic_lead", cluster: "体验对比" }]);
    });
    // 四类判定标准
    assert.match(prompt, /topic_lead=可拍的选题线索（含使用体验对比、踩坑、价格\/选型讨论、求测求更）/);
    assert.match(prompt, /content_critique=对内容的批评/);
    assert.match(prompt, /form_suggestion=对形式\/节奏\/封面的建议/);
    assert.match(prompt, /noise=纯灌水\/广告\/无信息\/表情包/);
    // 拿不准返回 null、禁止硬标
    assert.match(prompt, /拿不准时返回 null（留未分拣），禁止硬标/);
    // 规格里的 trae 对照示例
    assert.match(prompt, /自从用过 trae 后，感觉这些兴起的 ide 都比 cursor 差远了/);
    assert.match(prompt, /使用体验对比是选题素材，不算噪音/);
  } finally {
    db.close();
  }
});

test("TASK-PW-50 解析回归：LLM 对某条返回 null（拿不准）→ 留未分拣；合法四类照常落库", async () => {
  const db = database();
  try {
    const unsure = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "辛",
      content: "这条AI拿不准",
      capturedAt: "2026-08-04T00:07:00.000Z",
    });
    const lead = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "壬",
      content: "求更新一期踩坑合集",
      capturedAt: "2026-08-04T00:08:00.000Z",
    });
    const form = addPwVoiceItem(db, {
      platform: "bilibili",
      author: "癸",
      content: "节奏再快点就好了",
      capturedAt: "2026-08-04T00:09:00.000Z",
    });
    await classifyPwVoiceItems(db, [unsure.id, lead.id, form.id], async () => JSON.stringify([
      { id: unsure.id, signal_type: null, cluster: null },
      { id: lead.id, signal_type: "topic_lead", cluster: "求更新" },
      { id: form.id, signal_type: "form_suggestion", cluster: "节奏" },
    ]));
    const rows = listPwVoiceItems(db);
    assert.equal(rows.find((row) => row.id === unsure.id)!.signal_type, null, "null 不硬标，留未分拣");
    assert.equal(rows.find((row) => row.id === lead.id)!.signal_type, "topic_lead", "合法四类照常落库");
    assert.equal(rows.find((row) => row.id === lead.id)!.cluster_id, "求更新");
    assert.equal(rows.find((row) => row.id === form.id)!.signal_type, "form_suggestion");
  } finally {
    db.close();
  }
});
