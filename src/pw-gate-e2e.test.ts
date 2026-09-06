/**
 * PW-12 端到端阶段闸门：全程走 HTTP API 跑两圈真实闭环（一金一碑），
 * 覆盖七类事件，验证第一次的金子出现在后续押注的装配输出中。
 * 仅允许的库内预置：pt_verdicts 一条 confirmed gold（测试 setup）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type PapertableApp } from "./main.ts";

type Json = Record<string, unknown>;

async function api(
  base: string,
  method: string,
  path: string,
  body?: Json,
): Promise<{ status: number; data: Json }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, data };
}

test("PW-12 闸门：两圈闭环（一金一碑）、七类事件、金子进入下一圈装配", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pw-gate-"));
  let app: PapertableApp | undefined;
  try {
    app = await createApp(dir);
    await new Promise<void>((resolve) => {
      app!.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 测试预置：先建项目（pt_verdicts 有外键），再插一条 confirmed gold
    const project = await api(base, "POST", "/api/projects", { name: "gate" });
    assert.equal(project.status, 201, JSON.stringify(project.data));
    const projectId = String((project.data as { id?: unknown }).id
      ?? (project.data.project as Json | undefined)?.id);
    app.store.db.prepare(`
      INSERT INTO pt_verdicts(id, project_id, kind, text, status, memos_status, created_at, updated_at)
      VALUES('pt-gold-1', ?, 'gold', 'B站开头 30 秒放痛点，3 秒留存提升明显', 'confirmed', 'synced', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')
    `).run(projectId);

    // 1) 金子镜像
    const mirror = await api(base, "POST", "/api/pw/gold-sync/mirror");
    assert.equal(mirror.status, 200);
    assert.equal(mirror.data.added, 1);

    // 2) 第一圈：押注 A（引用镜像金子）→ 挂产出 → 录数据文档 → 铸金
    const betA = await api(base, "POST", "/api/pw/bets", {
      title: "直播做产品实践",
      thesis: "直播系列能成",
      metric: "三期平均播放 ≥ 5000",
      dataSourcePlan: "B站",
      checkoutDate: "2020-01-01",
      status: "pending",
      confidence: 70,
      goldRefs: ["pt-gold-1"],
    });
    assert.equal(betA.status, 201, JSON.stringify(betA.data));
    const betAId = String(betA.data.id);

    const artA = await api(base, "POST", `/api/pw/bets/${betAId}/artifacts`, {
      platform: "B站", type: "video", url: "https://b23.tv/ep3",
    });
    assert.equal(artA.status, 201, JSON.stringify(artA.data));

    const docA = await api(base, "POST", `/api/pw/bets/${betAId}/data-docs`, {
      platform: "bilibili",
      metricsJson: JSON.stringify({ play: 12403, retention3s: 0.68 }),
    });
    assert.equal(docA.status, 201, JSON.stringify(docA.data));
    const docAId = String(docA.data.id);

    const settleA = await api(base, "POST", `/api/pw/bets/${betAId}/settle`, {
      outcome: "gold",
      lesson: "开头 30 秒放痛点有效，3 秒留存显著更好",
      evidenceDocIds: [docAId],
    });
    assert.equal(settleA.status, 201, JSON.stringify(settleA.data));
    assert.equal(settleA.data.decided_by, "human");

    // 3) 第二圈：draft → confirm → 挂产出 → 录数据文档 → 立碑
    const draftB = await api(base, "POST", "/api/pw/drafts", {
      title: "无剪辑直播录屏",
      thesis: "省事直接发录屏也行",
      metric: "播放 ≥ 3000",
      dataSourcePlan: "B站",
      checkoutDate: "2020-01-01",
      source: "manual",
    });
    assert.equal(draftB.status, 201, JSON.stringify(draftB.data));
    const betBId = String(draftB.data.id);

    const confirmB = await api(base, "POST", `/api/pw/drafts/${betBId}/confirm`, { edits: {} });
    assert.equal(confirmB.status, 200, JSON.stringify(confirmB.data));
    assert.ok(confirmB.data.draft_hash);

    await api(base, "POST", `/api/pw/bets/${betBId}/artifacts`, {
      platform: "B站", type: "livestream", url: "https://b23.tv/raw-rec",
    });
    const docB = await api(base, "POST", `/api/pw/bets/${betBId}/data-docs`, {
      platform: "bilibili",
      metricsJson: JSON.stringify({ play: 757 }),
    });
    const docBId = String(docB.data.id);

    const settleB = await api(base, "POST", `/api/pw/bets/${betBId}/settle`, {
      outcome: "tomb",
      causeOfDeath: "无剪辑纯录屏没人看",
      evidenceDocIds: [docBId],
    });
    assert.equal(settleB.status, 201, JSON.stringify(settleB.data));

    // 4) 覆盖 reject：draft C 驳回
    const draftC = await api(base, "POST", "/api/pw/drafts", {
      title: "全平台日更",
      thesis: "量大出奇迹",
      source: "manual",
    });
    const draftCId = String(draftC.data.id);
    const rejectC = await api(base, "POST", `/api/pw/drafts/${draftCId}/reject`, {
      reason: "赌不起，精力不够",
    });
    assert.equal(rejectC.status, 200, JSON.stringify(rejectC.data));

    // 5) 闸门断言一：一金一碑 + 死因统计
    const golds = await api(base, "GET", "/api/pw/verdicts?outcome=gold");
    const tombs = await api(base, "GET", "/api/pw/verdicts?outcome=tomb");
    assert.equal((golds.data.verdicts as Json[]).length, 1);
    assert.equal((tombs.data.verdicts as Json[]).length, 1);
    const stats = await api(base, "GET", "/api/pw/verdicts/tombstone-stats");
    assert.equal((stats.data.causes as Json)["无剪辑纯录屏没人看"], 1);

    // 6) 闸门断言二：第一次的金子出现在后续押注的装配输出
    const ctxB = await api(base, "GET", `/api/pw/bets/${betBId}/context`);
    assert.match(String(ctxB.data.markdown), /开头 30 秒放痛点有效/);

    // 7) 闸门断言三：七类事件全部入库（跨三张卡的时间线求并集）
    const [tlA, tlB, tlC] = await Promise.all([
      api(base, "GET", `/api/pw/bets/${betAId}/timeline`),
      api(base, "GET", `/api/pw/bets/${betBId}/timeline`),
      api(base, "GET", `/api/pw/bets/${draftCId}/timeline`),
    ]);
    const eventTypes = new Set(
      [tlA, tlB, tlC].flatMap((tl) =>
        (tl.data.events as Array<{ event_type: string }>).map((event) => event.event_type)
      ),
    );
    for (const required of ["create", "attach", "data_doc", "draft", "confirm", "reject", "settle"]) {
      assert.ok(eventTypes.has(required), `缺少事件类型：${required}`);
    }

    // 8) 闸门断言四：错误路径——重复结账被拒、AI 不能结账（400 而非 500）
    const resettle = await api(base, "POST", `/api/pw/bets/${betAId}/settle`, {
      outcome: "tomb",
      causeOfDeath: "反悔",
      evidenceDocIds: [docAId],
    });
    assert.equal(resettle.status, 400);
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
