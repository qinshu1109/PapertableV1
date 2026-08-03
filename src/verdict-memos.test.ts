import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerdictRemote,
  VerdictContractError,
  VERDICT_CUBE_ID,
  type VerdictInput,
} from "./verdict-memos.ts";

function fakeMemos() {
  const records: Array<Record<string, unknown>> = [];
  const addCalls: Array<Record<string, unknown>> = [];
  let cube = false;
  return {
    records,
    addCalls,
    async call(name: string, args: Record<string, unknown>) {
      if (name === "health") return { status: "ok" };
      if (name === "list_cubes") {
        return { cubes: cube ? [{ cube_id: VERDICT_CUBE_ID }] : [] };
      }
      if (name === "create_cube") {
        assert.equal(args.name, "Papertable 判决簿");
        assert.equal(args.max_memories, 2000);
        cube = true;
        return { created: true };
      }
      if (name === "search_memories") {
        assert.equal(args.search_mode, "fts");
        assert.equal(args.rerank, "off");
        return {
          results: records.filter((record) => {
            const view = record.memory_view as Record<string, unknown>;
            return view.subject_id === (args.subject_ids as string[])[0];
          }),
        };
      }
      if (name === "add_memory") {
        addCalls.push(args);
        const memoryId = `memory-${records.length + 1}`;
        records.push({
          cube_id: VERDICT_CUBE_ID,
          memory_id: memoryId,
          memory: args.content,
          metadata: {
            tags: args.tags,
            info: {
              hot_policy: args.hot_policy,
              supersedes_memory_id: args.supersedes_memory_id,
            },
          },
          memory_view: {
            semantic_type: args.semantic_type,
            subject_type: args.subject_type,
            subject_id: args.subject_id,
            client_id: args.client_id,
            status: "activated",
            attributes: args.attributes,
            locked_fields: args.locked_fields,
          },
        });
        return { memory_id: memoryId };
      }
      if (name === "get_memory") {
        return records.find((record) => record.memory_id === args.memory_id) ?? {};
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

const input: VerdictInput = {
  projectId: "project-a",
  verdictType: "tombstone",
  sourceKind: "edge",
  sourceId: "edge-1",
  content: "用户否决了自动写笔记，因为内容会被活埋。",
  concepts: ["自动写笔记"],
};

test("MemOS contract is idempotent, project-scoped and uses the live schema", async () => {
  const memos = fakeMemos();
  const remote = createVerdictRemote(memos.call);
  const [first, duplicate] = await Promise.all([
    remote.confirm(input),
    remote.confirm(input),
  ]);
  assert.equal(first.verdict.id, duplicate.verdict.id);
  assert.equal(memos.records.length, 1);
  assert.equal(memos.addCalls[0].content?.toString().includes("papertable-verdict:"), true);
  assert.equal("memory" in memos.addCalls[0], false);
  assert.equal("metadata" in memos.addCalls[0], false);
  assert.deepEqual(memos.addCalls[0].tags, [
    "brain:ignore",
    "papertable-verdict",
    "hot_policy=exclude",
    "semantic_type=decision",
  ]);
  assert.equal(memos.addCalls[0].hot_policy, "exclude");
  assert.equal(memos.addCalls[0].semantic_type, "decision");
  assert.equal((await remote.list("project-a", "为什么自动写笔记会失败")).verdicts.length, 1);
  await remote.confirm({ ...input, projectId: "project-b" });
  assert.equal((await remote.list("project-a")).history.length, 1);
  assert.equal((await remote.list("project-b")).history.length, 1);
});

test("supersede retains history and only returns the chain tail", async () => {
  const memos = fakeMemos();
  const remote = createVerdictRemote(memos.call);
  const first = await remote.confirm(input);
  const replacement = await remote.supersede(first.verdict.id, {
    ...input,
    content: "用户否决了无确认的生成流程，因为它会制造不可读存量。",
    concepts: ["不可读存量"],
  });
  const listed = await remote.list("project-a");
  assert.equal(listed.history.length, 2);
  assert.deepEqual(listed.verdicts.map((item) => item.id), [replacement.verdict.id]);
  assert.equal(replacement.verdict.supersedesMemoryId, first.verdict.id);
  assert.equal(memos.addCalls[1].supersedes_memory_id, first.verdict.id);
});

test("gold locks its card and turn source fields", async () => {
  const memos = fakeMemos();
  const remote = createVerdictRemote(memos.call);
  await remote.confirm({
    projectId: "project-a",
    verdictType: "gold",
    sourceKind: "turn",
    sourceId: "run-1",
    sourceCardId: "card-1",
    sourceTurnId: "run-1",
    content: "用户确认的一行结论。",
    concepts: ["证据纪律"],
  });
  assert.deepEqual(
    (memos.addCalls[0].locked_fields as string[]).slice(-2),
    ["source_card_id", "source_turn_id"],
  );
});

test("malformed remote verdicts fail loudly instead of disappearing", async () => {
  const memos = fakeMemos();
  const remote = createVerdictRemote(memos.call);
  await remote.confirm(input);
  const view = memos.records[0].memory_view as Record<string, unknown>;
  view.locked_fields = [];
  await assert.rejects(
    () => remote.list("project-a"),
    VerdictContractError,
  );
});
