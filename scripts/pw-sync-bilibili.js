#!/usr/bin/env node
/**
 * Paperweight P1 · B站数据源低频同步（TASK-PW-13）
 *
 * 用法：ego-browser nodejs < scripts/pw-sync-bilibili.js
 * （或 ego-browser nodejs scripts/pw-sync-bilibili.js，视 CLI 版本）
 *
 * 纪律（五条军规）：
 *  1. 不读取、不存储任何 cookie 本体——登录态由 ego-browser 任务空间继承；
 *  2. 只读操作：只打开页面、读 DOM，不点击投稿/编辑/删除等任何写按钮；
 *  3. 遇到登录墙/验证码/滑块 → 置连接为 needs_human 并立即退出，交人处理；
 *  4. 仅自己账号的稿件：数据只从创作中心读，不匹配到的产出物一律 skipped；
 *  5. 低频定向：每天最多 1 次（同日已同步则跳过，FORCE=true 可强制）。
 *
 * 已知限制（2026-08-04 实测）：账号当前 0 稿件时走「0 匹配」空路径；
 * 稿件列表与稿件分析的 DOM 选择器按当日创作中心结构编写，
 * 用户发布首期真实视频后需复核 extractList/extractMetrics 两个函数。
 */

const API = 'http://127.0.0.1:4317';
const FORCE = false;

const j = async (p, init) => {
  const body = await serverFetch(API + p, init);
  return typeof body === 'string' ? JSON.parse(body) : body;
};

// ---------- 创作中心取数（按 2026-08-04 实测；首期真实视频后复核 extractMetrics） ----------

// 自有稿件列表：创作中心同源 JSON 接口（用户登录态内的只读低频请求，比 DOM 扫描可靠）
async function extractOwnVideos() {
  const r = await browserFetch('https://member.bilibili.com/x/web/archives?status=pubed&pn=1&ps=50');
  const obj = typeof r === 'string' ? JSON.parse(r) : r;
  if (!obj || obj.code !== 0 || !obj.data) {
    throw new Error('archives 接口异常: ' + JSON.stringify(obj).slice(0, 200));
  }
  return (obj.data.archives || []).map(a => ({ bvid: a.bvid, title: a.title }));
}

// 数据中心稿件分析：读单稿件核心指标（播放/点赞/评论/弹幕/收藏/投币/分享）
async function extractMetrics() {
  return await js(String.raw`(() => {
    const KEYS = ['播放量', '点赞', '评论', '弹幕', '收藏', '投币', '分享'];
    const lines = document.body.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    const num = s => {
      const m = s.replace(/,/g, '').match(/^(\d+(\.\d+)?)(万)?$/);
      if (!m) return null;
      let n = parseFloat(m[1]);
      if (m[3] === '万') n = Math.round(n * 10000);
      return n;
    };
    const out = {};
    for (let i = 0; i < lines.length; i++) {
      const label = lines[i].replace(/[:\s]/g, '');
      for (const k of KEYS) {
        if (label === k && out[k] === undefined) {
          const v = i + 1 < lines.length ? num(lines[i + 1]) : null;
          if (v !== null) out[k === '播放量' ? '播放' : k] = v;
        }
      }
    }
    return out;
  })()`);
}

// 登录墙/验证码检测：命中即视为需要人工接手
async function detectHumanWall() {
  const info = await pageInfo();
  if ((info.url || '').includes('passport.bilibili.com')) return '登录墙（passport 重定向）';
  return await js(String.raw`(() => {
    const t = document.body ? document.body.innerText : '';
    if (/滑块|安全验证|拖动下方滑块|人机验证/.test(t)) return '出现人机验证';
    if (/扫码登录|密码登录/.test(t) && !/创作中心/.test(t)) return '登录态失效';
    return null;
  })()`);
}

// 从产出物 URL 解析 BV 号；支持 b23.tv 短链（读跳转后页面 HTML 里的 bvid）
async function resolveBvid(url) {
  const direct = (url || '').match(/BV[0-9A-Za-z]{10}/);
  if (direct) return direct[0];
  if (url && url.includes('b23.tv')) {
    try {
      const body = await serverFetch(url);
      const html = typeof body === 'string' ? body : String(body);
      const m = html.match(/BV[0-9A-Za-z]{10}/);
      if (m) return m[0];
    } catch { /* 短链解析失败按 skipped 处理 */ }
  }
  return null;
}

// ---------- 主流程 ----------

const task = await useOrCreateTaskSpace('paperweight-b站同步');
cliLog('task space id: ' + task.id);

const { connections } = await j('/api/pw/connections');
const conn = (connections || []).find(c => c.platform === 'B站');
if (!conn) {
  cliLog('未登记 B站连接：先在「数据源」屏点「连接账号」。本次不动作。');
} else if (conn.status === 'paused') {
  cliLog('连接已暂停，本次不动作。');
} else {
  const today = new Date().toLocaleDateString('sv');
  const lastDay = (conn.last_sync_at || '').slice(0, 10);
  if (!FORCE && lastDay === today) {
    cliLog('今天已同步过（' + conn.last_sync_at + '），低频纪律跳过。FORCE=true 可强制。');
  } else {
    // 收集已挂载的 B站产出物
    const { bets } = await j('/api/pw/bets');
    const artifacts = [];
    for (const b of (bets || []).filter(x => x.status !== 'draft' && x.status !== 'void')) {
      const r = await j('/api/pw/bets/' + b.id + '/artifacts');
      for (const a of r.artifacts || []) {
        if (a.platform === 'B站' && !a.detached_at && a.url) artifacts.push(a);
      }
    }
    cliLog('已挂载 B站产出物 ' + artifacts.length + ' 个');

    // 打开创作中心，先过登录墙/验证码检测
    await openOrReuseTab('https://member.bilibili.com/platform/upload-manager/article', { wait: true, timeout: 30 });
    await wait(3);
    const wall = await detectHumanWall();
    if (wall) {
      await j('/api/pw/connections/' + conn.id + '/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'needs_human', reason: wall }),
      });
      cliLog('⚠ ' + wall + '：已置 needs_human，请在 ego lite 浏览器接手处理后在数据源屏恢复。');
    } else {
      const own = await extractOwnVideos();
      cliLog('创作中心自有稿件 ' + own.length + ' 个');
      const ownBv = new Set(own.map(v => v.bvid));

      const items = [];
      const skipped = [];
      for (const a of artifacts) {
        const bvid = await resolveBvid(a.url);
        if (!bvid) { skipped.push({ artifact: a.title || a.url, reason: 'URL 无法解析 BV 号' }); continue; }
        if (!ownBv.has(bvid)) { skipped.push({ artifact: a.title || bvid, reason: '不在自己账号稿件列表中' }); continue; }
        // 数据中心稿件分析视图（bvid 参数直达；若结构变化，取数函数需复核）
        await gotoAndWait('https://member.bilibili.com/york/data-center-web?bvid=' + bvid, { timeout: 30 });
        await wait(3);
        const wall2 = await detectHumanWall();
        if (wall2) {
          await j('/api/pw/connections/' + conn.id + '/status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'needs_human', reason: wall2 }),
          });
          cliLog('⚠ ' + wall2 + '：已置 needs_human，中断本次同步。');
          items.length = 0;
          break;
        }
        const metrics = await extractMetrics();
        if (Object.keys(metrics).length === 0) {
          skipped.push({ artifact: a.title || bvid, reason: '稿件分析页未读到指标（选择器待复核）' });
          continue;
        }
        items.push({ artifactId: a.id, metrics, rawRef: '创作中心·稿件分析 ' + bvid });
      }

      if (items.length > 0 || skipped.length >= 0) {
        if (items.length > 0) {
          const r = await j('/api/pw/sync/bilibili', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items }),
          });
          cliLog('同步完成：created=' + r.created + (r.errors && r.errors.length ? ' errors=' + JSON.stringify(r.errors) : ''));
        } else {
          // 0 匹配也更新 last_sync_at：走一条空 items 提交（后端仍刷新同步时间）
          await j('/api/pw/sync/bilibili', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: [] }),
          });
          cliLog('同步完成：0 条（账号暂无匹配稿件），last_sync_at 已刷新');
        }
        for (const s of skipped) cliLog('skipped: ' + s.artifact + ' — ' + s.reason);
      }
    }
  }
}
