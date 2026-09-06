import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensurePwRunTables,
  getPwBetTimeline,
  recordPwEvent,
  type PwEventType,
} from "./pw-runs.ts";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensurePwRunTables(db);
  return db;
}

test("建表幂等且包含 P0 事件日志字段", () => {
  const db = makeDb();
  ensurePwRunTables(db);
  const columns = db.prepare("PRAGMA table_info(pw_runs)").all() as Array<{ name: string }>;
  assert.deepEqual(columns.map(({ name }) => name), [
    "id",
    "kind",
    "event_type",
    "actor",
    "payload_json",
    "payload_hash",
    "parent_id",
    "related_ids_json",
    "bet_id",
    "created_at",
    "instruction_text",
    "instruction_message_id",
  ]);
});

test("七类手工事件可记录，payload 原文、摘要、父节点和关联 id 均保留", () => {
  const db = makeDb();
  const eventTypes: PwEventType[] = [
    "create",
    "attach",
    "data_doc",
    "draft",
    "confirm",
    "reject",
    "settle",
  ];
  const payload = '{"text":"原文不重排","n":1}';
  const ids = eventTypes.map((eventType, index) => recordPwEvent(db, {
    id: `event-${index}`,
    bet_id: "bet-1",
    event_type: eventType,
    actor: index === 6 ? "system" : "human",
    payload_json: payload,
    payload_hash: "caller-supplied-wrong-hash",
    parent_id: index === 0 ? null : "event-0",
    related_ids: [`ref-${index}`],
    created_at: `2026-08-04T00:00:0${index}.000Z`,
  }));

  assert.deepEqual(ids.map(({ event_type }) => event_type), eventTypes);
  assert.equal(ids[0].payload_json, payload);
  assert.equal(
    ids[0].payload_hash,
    createHash("sha256").update(payload).digest("hex"),
  );
  assert.equal(ids[1].parent_id, "event-0");
  assert.deepEqual(JSON.parse(ids[1].related_ids_json), ["ref-1"]);
});

test("非法 payload_json 与 actor/kind 守卫：ai 只走 ai_draft", () => {
  const db = makeDb();
  const base = {
    bet_id: "bet-1",
    event_type: "create" as const,
    payload_json: "{}",
  };
  assert.throws(
    () => recordPwEvent(db, { ...base, payload_json: "{bad" }),
    /合法 JSON/,
  );
  assert.throws(
    () => recordPwEvent(db, { ...base, actor: "ai" }),
    /actor=ai 只允许 kind=ai_draft/,
  );
  assert.throws(
    () => recordPwEvent(db, { ...base, kind: "bogus" }),
    /kind=manual_event/,
  );
  const ai = recordPwEvent(db, {
    bet_id: "bet-1",
    kind: "ai_draft",
    event_type: "draft",
    actor: "ai",
    payload_json: "{\"draftId\":\"d-1\"}",
  });
  assert.equal(ai.kind, "ai_draft");
  assert.equal(ai.actor, "ai");
});

test("按 created_at 升序回放，且保留全部字段与 parent_id 树结构", () => {
  const db = makeDb();
  recordPwEvent(db, {
    id: "root",
    bet_id: "bet-2",
    event_type: "create",
    payload_json: "{\"step\":0}",
    created_at: "2026-08-04T00:00:02.000Z",
  });
  recordPwEvent(db, {
    id: "child",
    bet_id: "bet-2",
    event_type: "confirm",
    payload_json: "{\"step\":1}",
    parent_id: "root",
    created_at: "2026-08-04T00:00:01.000Z",
  });
  recordPwEvent(db, {
    id: "other-bet",
    bet_id: "bet-other",
    event_type: "settle",
    payload_json: "{}",
  });

  const timeline = getPwBetTimeline(db, "bet-2");
  assert.deepEqual(timeline.map(({ id }) => id), ["child", "root"]);
  assert.equal(timeline[0].parent_id, "root");
  assert.deepEqual(Object.keys(timeline[0]).sort(), [
    "actor",
    "bet_id",
    "created_at",
    "event_type",
    "id",
    "instruction_message_id",
    "instruction_text",
    "kind",
    "parent_id",
    "payload_hash",
    "payload_json",
    "related_ids_json",
  ].sort());
});

test("模块不回读改写，表上直接改动不会被下一次记录覆盖", () => {
  const db = makeDb();
  recordPwEvent(db, {
    id: "first",
    bet_id: "bet-3",
    event_type: "create",
    payload_json: "{}",
  });
  db.prepare("UPDATE pw_runs SET payload_json = ? WHERE id = ?").run("{\"manual\":true}", "first");
  recordPwEvent(db, {
    id: "second",
    bet_id: "bet-3",
    event_type: "attach",
    payload_json: "{}",
  });
  assert.equal(getPwBetTimeline(db, "bet-3")[0].payload_json, '{"manual":true}');
});
