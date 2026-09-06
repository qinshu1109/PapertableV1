import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  authorizePwCorpus,
  donePwCorpus,
  ensurePwCorpusTables,
  failPwCorpus,
  listPwCorpus,
  listPwCorpusPending,
  markPwCorpusFetching,
  searchPwCorpus,
} from "./pw-corpus.ts";
import { ensurePwRunTables } from "./pw-runs.ts";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // TASK-PW-23：写动作模块内记账，测试库需有 pw_runs 账本
  ensurePwRunTables(db);
  ensurePwCorpusTables(db);
  return db;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === "object" && error !== null && "status" in error
    && (error as { status: unknown }).status === status;
}

const BV1 = "BV1NprhBPEtR";
const BV2 = "BV1xx411c7mD";

test("授权幂等：重复登记返回既有不重复建行，force=1 重置回 pending 并清 error", () => {
  const db = database();
  try {
    const first = authorizePwCorpus(db, { bvid: BV1 });
    assert.equal(first.existed, false);
    assert.equal(first.doc.status, "pending");
    assert.equal(first.doc.kinds, "video,comments");
    assert.equal(first.doc.authorized_by, "human");
    assert.equal(first.doc.error, null);
    assert.ok(first.doc.created_at);

    const again = authorizePwCorpus(db, { bvid: BV1 });
    assert.equal(again.existed, true);
    assert.equal(again.doc.id, first.doc.id);
    assert.equal(listPwCorpus(db).length, 1);

    // fetching 中登记（含 force）仍幂等返回既有，不重置
    markPwCorpusFetching(db, first.doc.id);
    const during = authorizePwCorpus(db, { bvid: BV1, force: 1 });
    assert.equal(during.existed, true);
    assert.equal(during.doc.status, "fetching");

    // failed 后：不带 force 返回既有状态；force=1 重置 pending、error 清空
    failPwCorpus(db, first.doc.id, { status: "failed", error: "网络错" });
    const kept = authorizePwCorpus(db, { bvid: BV1 });
    assert.equal(kept.existed, true);
    assert.equal(kept.doc.status, "failed");
    assert.equal(kept.doc.error, "网络错");
    const reset = authorizePwCorpus(db, { bvid: BV1, force: 1 });
    assert.equal(reset.existed, true);
    assert.equal(reset.doc.status, "pending");
    assert.equal(reset.doc.error, null);
  } finally {
    db.close();
  }
});

test("非法 bvid 拒绝 400，不落行", () => {
  const db = database();
  try {
    for (const bad of ["", "  ", "bv1nprhbpetr", "BV123", "av170001", null, 123]) {
      assert.throws(() => authorizePwCorpus(db, { bvid: bad }), (error: unknown) =>
        hasStatus(error, 400));
    }
    assert.equal(listPwCorpus(db).length, 0);
  } finally {
    db.close();
  }
});

test("队列与列表排序：pending 按 created_at 正序，全量按 created_at 倒序", () => {
  const db = database();
  try {
    const a = authorizePwCorpus(db, { bvid: BV1 }).doc;
    const b = authorizePwCorpus(db, { bvid: BV2 }).doc;
    // created_at 可能同毫秒，直接改库保证可判序
    db.prepare("UPDATE pw_corpus_docs SET created_at = ? WHERE id = ?")
      .run("2026-08-01T00:00:00.000Z", a.id);
    db.prepare("UPDATE pw_corpus_docs SET created_at = ? WHERE id = ?")
      .run("2026-08-02T00:00:00.000Z", b.id);
    assert.deepEqual(listPwCorpusPending(db).map((doc) => doc.id), [a.id, b.id]);
    assert.deepEqual(listPwCorpus(db).map((doc) => doc.id), [b.id, a.id]);
  } finally {
    db.close();
  }
});

test("状态机：pending → fetching → done 出队；fail 仅允许 needs_human / failed；缺失 id 404", () => {
  const db = database();
  try {
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    assert.deepEqual(listPwCorpusPending(db).map((d) => d.id), [doc.id]);

    const fetching = markPwCorpusFetching(db, doc.id);
    assert.equal(fetching.status, "fetching");
    assert.equal(listPwCorpusPending(db).length, 0);

    const done = donePwCorpus(db, doc.id, {
      title: "成片标题",
      upName: "某UP主",
      path: "corpus/BV1NprhBPEtR",
      sha256: "deadbeef",
      videoStat: { view: 100, reply: 3 },
      commentCount: 2,
      comments: [
        { uname: "甲", message: "这个实验设计得真巧妙", like: 12 },
        { uname: "乙", message: "学会了", like: 0 },
      ],
    });
    assert.equal(done.status, "done");
    assert.equal(done.title, "成片标题");
    assert.equal(done.up_name, "某UP主");
    assert.equal(done.path, "corpus/BV1NprhBPEtR");
    assert.equal(done.sha256, "deadbeef");
    assert.equal(done.comment_count, 2);
    assert.ok(done.fetched_at);
    assert.ok(done.video_stat_json);
    assert.equal((JSON.parse(done.video_stat_json) as { view: number }).view, 100);

    assert.throws(() => failPwCorpus(db, doc.id, { status: "done" }), /非法 status/);
    assert.throws(() => failPwCorpus(db, doc.id, { status: "pending" }), /非法 status/);
    const warned = failPwCorpus(db, doc.id, { status: "needs_human", error: "出现滑块验证" });
    assert.equal(warned.status, "needs_human");
    assert.equal(warned.error, "出现滑块验证");

    for (const run of [
      () => markPwCorpusFetching(db, "missing"),
      () => donePwCorpus(db, "missing", {}),
      () => failPwCorpus(db, "missing", { status: "failed" }),
    ]) {
      assert.throws(run, (error: unknown) => hasStatus(error, 404));
    }
  } finally {
    db.close();
  }
});

test("done 写 FTS：search 命中且 snippet 带 <b> 高亮，重抓按 bvid 重建不残留", () => {
  const db = database();
  try {
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    donePwCorpus(db, doc.id, {
      title: "科普视频",
      comments: [
        { uname: "观察者甲", message: "这个实验设计得真巧妙，尤其是对照组", like: 45 },
        { uname: "路人乙", message: "实验设计的变量控制有点问题吧", like: 3 },
        { uname: "丙", message: "完全不相关的一句话评论", like: 1 },
        { message: "缺昵称的一楼提到实验设计" },
        { uname: "脏行" },
      ],
    });

    const hits = searchPwCorpus(db, "实验设计");
    assert.equal(hits.length, 3);
    assert.ok(hits.every((hit) => hit.bvid === BV1));
    for (const hit of hits) {
      assert.ok(hit.snippet.includes("<b>"));
      assert.ok(hit.snippet.includes("</b>"));
    }
    assert.deepEqual(
      hits.map((hit) => hit.uname).sort(),
      ["观察者甲", "路人乙", null].sort(),
    );
    const likeByUname = new Map(hits.map((hit) => [hit.uname, hit.like]));
    assert.equal(likeByUname.get("观察者甲"), 45);
    assert.equal(likeByUname.get("路人乙"), 3);
    assert.equal(likeByUname.get(null), null);

    // 未命中返回空
    assert.equal(searchPwCorpus(db, "量子力学").length, 0);

    // force 重抓：FTS 按 bvid 重建，旧评论不残留
    authorizePwCorpus(db, { bvid: BV1, force: 1 });
    markPwCorpusFetching(db, doc.id);
    donePwCorpus(db, doc.id, {
      title: "科普视频",
      comments: [{ uname: "新人", message: "实验设计新版评论", like: 7 }],
    });
    const rebuilt = searchPwCorpus(db, "实验设计");
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].uname, "新人");
    assert.equal(rebuilt[0].like, 7);
  } finally {
    db.close();
  }
});

test("空 q 返回空数组", () => {
  const db = database();
  try {
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    donePwCorpus(db, doc.id, {
      comments: [{ uname: "甲", message: "这个实验设计得真巧妙", like: 1 }],
    });
    assert.deepEqual(searchPwCorpus(db, ""), []);
    assert.deepEqual(searchPwCorpus(db, "   "), []);
    assert.deepEqual(searchPwCorpus(db, null), []);
    assert.deepEqual(searchPwCorpus(db, undefined), []);
  } finally {
    db.close();
  }
});

test("短词（<3 字）退化为 LIKE 检索：命中且带高亮，like 降序", () => {
  const db = database();
  try {
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    donePwCorpus(db, doc.id, {
      comments: [
        { uname: "甲", message: "手绘分镜这一步最花时间", like: 2 },
        { uname: "乙", message: "完全不相关的评论", like: 99 },
        { uname: "丙", message: "分镜脚本模板分享一下？", like: 50 },
      ],
    });
    const hits = searchPwCorpus(db, "分镜");
    assert.equal(hits.length, 2);
    assert.equal(hits[0].uname, "丙");
    assert.equal(hits[1].uname, "甲");
    for (const hit of hits) {
      assert.ok(hit.snippet.includes("<b>分镜</b>"));
    }
    // LIKE 通配符按字面处理，不当成模式
    assert.equal(searchPwCorpus(db, "%").length, 0);
  } finally {
    db.close();
  }
});

test("多词分隔查询（模型常用「a/b/c」形态）拆词 OR 命中", () => {
  const db = database();
  try {
    const { doc } = authorizePwCorpus(db, { bvid: BV1 });
    donePwCorpus(db, doc.id, {
      comments: [
        { uname: "甲", message: "全流程干货满满，尤其是分镜环节", like: 9 },
        { uname: "乙", message: "这个工作流太复杂了", like: 1 },
      ],
    });
    const hits = searchPwCorpus(db, "干货/过程/步骤");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].uname, "甲");
    assert.ok(hits[0].snippet.includes("<b>干货</b>"));
    // 全部分隔符无有效词时按原短语处理，不报错
    assert.deepEqual(searchPwCorpus(db, "///"), []);
  } finally {
    db.close();
  }
});
