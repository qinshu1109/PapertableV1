#!/usr/bin/env node
/**
 * Paperweight P2 · 定向语料抓取器（TASK-PW-14）
 *
 * 用法：ego-browser nodejs < scripts/pw-fetch-bili-corpus.js
 *
 * 流程：GET /api/pw/corpus/pending → 逐条（≤3）打开视频公开页，
 * 浏览器上下文内 fetch 公开接口（view 元数据 + reply 评论），
 * 写 {数据目录}/corpus/{bvid}/{meta.json,comments.jsonl} 后 POST done。
 *
 * 纪律（公开数据通路，v0.3）：
 *  1. 只抓人工授权队列里的条目（授权动作在界面/对话里，本脚本不加条目）；
 *  2. 只读公开接口，不碰 cookie 本体；评论作者昵称原样存储（公开数据）；
 *  3. 低频：单次运行 ≤3 条、评论 ≤100 条/视频、翻页间隔 ≥1.5s；
 *  4. 撞登录墙/验证码/风控码（-352/-412 等）→ 置 needs_human 并整体退出，交人处理。
 */

const API = 'http://127.0.0.1:4317';
const DATA_DIR = process.env.PAPERTABLE_DATA_DIR
  || (await import('node:os')).homedir() + '/Library/Application Support/Papertable';
const MAX_PER_RUN = 3;
const MAX_COMMENTS = 100;
const PAGE_SLEEP = 1.5;

const j = async (p, init) => {
  const body = await serverFetch(API + p, init);
  return typeof body === 'string' ? JSON.parse(body) : body;
};
const post = (p, payload) =>
  j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

// 浏览器内 fetch B站公开接口并解析 JSON
// 注意 credentials:'include'：api.bilibili.com 与 www 跨域，不带凭证时评论接口只回 3 条热评
async function biliApi(url) {
  const r = await browserFetch(url, { credentials: 'include' });
  return typeof r === 'string' ? JSON.parse(r) : r;
}

function riskFail(obj) {
  // B站风控/权限错误码：-352 风控校验失败、-412 请求被拦截、-101 账号未登录
  return obj && typeof obj.code === 'number' && [-352, -412, -101].includes(obj.code);
}

const task = await useOrCreateTaskSpace('paperweight-b站语料抓取');
cliLog('task space id: ' + task.id);

const { items } = await j('/api/pw/corpus/pending');
const queue = (items || []).slice(0, MAX_PER_RUN);
if (queue.length === 0) {
  cliLog('授权队列是空的，本次不动作。');
} else {
  cliLog('待抓 ' + queue.length + ' 条（单次上限 ' + MAX_PER_RUN + '）');
  const fs = await import('node:fs/promises');
  const crypto = await import('node:crypto');

  for (const doc of queue) {
    cliLog('—— ' + doc.bvid + ' ——');
    await post('/api/pw/corpus/' + doc.id + '/fetching', {});

    await openOrReuseTab('https://www.bilibili.com/video/' + doc.bvid, { wait: true, timeout: 30 });
    await wait(3);
    const info = await pageInfo();
    if ((info.url || '').includes('passport.bilibili.com')) {
      await post('/api/pw/corpus/' + doc.id + '/fail', { status: 'needs_human', error: '登录墙（passport 重定向）' });
      cliLog('⚠ 登录墙，已置 needs_human，整体退出。');
      break;
    }

    // 元数据
    const view = await biliApi('https://api.bilibili.com/x/web-interface/view?bvid=' + doc.bvid);
    if (riskFail(view)) {
      await post('/api/pw/corpus/' + doc.id + '/fail', { status: 'needs_human', error: '风控码 ' + view.code + '（view 接口）' });
      cliLog('⚠ view 接口风控（' + view.code + '），已置 needs_human，整体退出。');
      break;
    }
    if (view.code !== 0 || !view.data) {
      await post('/api/pw/corpus/' + doc.id + '/fail', { status: 'failed', error: 'view 接口 code=' + view.code + '（视频不存在或已删除）' });
      cliLog('✗ 视频不可见（code=' + view.code + '），标 failed，继续下一条。');
      continue;
    }
    const v = view.data;
    const stat = {
      播放: v.stat?.view ?? 0,
      弹幕: v.stat?.danmaku ?? 0,
      评论: v.stat?.reply ?? 0,
      收藏: v.stat?.favorite ?? 0,
      投币: v.stat?.coin ?? 0,
      分享: v.stat?.share ?? 0,
      点赞: v.stat?.like ?? 0,
    };

    // 评论（按热度，翻页到上限）
    const comments = [];
    let page = 1;
    while (comments.length < MAX_COMMENTS) {
      await wait(PAGE_SLEEP);
      const rep = await biliApi(
        'https://api.bilibili.com/x/v2/reply?type=1&oid=' + v.aid + '&sort=2&ps=20&pn=' + page,
      );
      if (riskFail(rep)) {
        await post('/api/pw/corpus/' + doc.id + '/fail', { status: 'needs_human', error: '风控码 ' + rep.code + '（reply 接口第 ' + page + ' 页）' });
        cliLog('⚠ reply 接口风控（' + rep.code + '），已置 needs_human，整体退出。');
        break;
      }
      if (rep.code !== 0) break;
      const list = rep.data?.replies || [];
      for (const c of list) {
        comments.push({
          rpid: c.rpid,
          uname: c.member?.uname ?? '',
          message: c.content?.message ?? '',
          like: c.like ?? 0,
          ctime: c.ctime ?? 0,
          replies: c.rcount ?? 0,
        });
      }
      if (list.length < 20) break;
      page += 1;
    }
    // 风控退出时不再落盘
    const conn = await j('/api/pw/corpus');
    const self = (conn.items || []).find(x => x.id === doc.id);
    if (self && self.status === 'needs_human') break;

    // 落盘
    const dir = DATA_DIR + '/corpus/' + doc.bvid;
    await fs.mkdir(dir, { recursive: true });
    const meta = {
      bvid: doc.bvid,
      aid: v.aid,
      title: v.title,
      up_name: v.owner?.name ?? '',
      pubdate: v.pubdate ?? 0,
      stat,
      fetched_at: new Date().toISOString(),
      source: 'api.bilibili.com/x/web-interface/view',
    };
    await fs.writeFile(dir + '/meta.json', JSON.stringify(meta, null, 2));
    const jsonl = comments.map(c => JSON.stringify(c)).join('\n') + '\n';
    await fs.writeFile(dir + '/comments.jsonl', jsonl);
    const sha = crypto.createHash('sha256').update(jsonl).digest('hex');

    await post('/api/pw/corpus/' + doc.id + '/done', {
      title: v.title,
      upName: meta.up_name,
      path: 'corpus/' + doc.bvid,
      sha256: sha,
      videoStat: stat,
      commentCount: comments.length,
      comments,
    });
    cliLog('✓ ' + v.title.slice(0, 30) + ' · 评论 ' + comments.length + ' 条落盘 + FTS 已建');
  }
}
