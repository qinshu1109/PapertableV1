import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ANSWER_SENTINEL, AnswerSentenceGate, gateAnswer } from "./gate.ts";
import type { RunContext } from "./notes.ts";

/** 最小可用 RunContext：内存库 + 一个已读 chunk，满足 getChunkCitation 查询 */
function makeContext(): RunContext {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pt_documents (id TEXT PRIMARY KEY, actual_path TEXT NOT NULL);
    CREATE TABLE pt_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    INSERT INTO pt_documents VALUES ('doc-1', '/abs/a.md');
    INSERT INTO pt_chunks VALUES ('chunk-1', 'doc-1', 'library', 'a.md', 0, 10, '片段内容');
  `);
  return {
    db,
    projectId: "p1",
    documents: [],
    documentIds: new Set(["doc-1"]),
    readableIds: new Set(["chunk-1"]),
    readIds: new Set(["chunk-1"]),
  };
}

const MERMAID = "```mermaid\nflowchart TD\n  A[根卡] --> B[深挖卡]\n```\n";

function rawAnswer(withDiagram: boolean): string {
  return [
    ANSWER_SENTINEL,
    "结构如下 [[source:chunk-1]]。",
    withDiagram ? MERMAID : "",
    "三种关系的继承策略各不相同 [[source:chunk-1]]。",
  ].join("\n");
}

test("gateAnswer 保留 mermaid 围栏块", () => {
  const terminal = gateAnswer(rawAnswer(true), makeContext());
  assert.equal(terminal.result, "completed");
  assert.ok(terminal.answer?.includes("```mermaid"), "围栏头应保留");
  assert.ok(terminal.answer?.includes("A[根卡] --> B[深挖卡]"), "图内容应保留");
});

test("gateAnswer 不带图时行为不变", () => {
  const terminal = gateAnswer(rawAnswer(false), makeContext());
  assert.equal(terminal.result, "completed");
  assert.ok(!terminal.answer?.includes("```"));
});

test("流式闸门在围栏闭合前不放行、闭合后整段放行", () => {
  const full = rawAnswer(true);
  const splitAt = full.indexOf("A[根卡]");
  const gate = new AnswerSentenceGate(makeContext(), {
    onSentence: () => {},
    onCitation: () => {},
  });
  gate.feed(full.slice(0, splitAt));
  assert.ok(!gate.answer.includes("A[根卡]"), "围栏未闭合时不应输出图内容");
  gate.feed(full.slice(splitAt));
  gate.finish();
  assert.ok(gate.answer.includes("```mermaid"));
  assert.ok(gate.answer.includes("A[根卡] --> B[深挖卡]"));
});
