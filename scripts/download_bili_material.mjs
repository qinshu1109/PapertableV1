import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const bvid = process.argv[2] || 'BV1jv3c6tEbJ';
const outDir = path.resolve('materials', bvid);
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log(`[1/5] 获取视频基本信息 ${bvid}...`);
const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com'
  }
});
const viewJson = await viewRes.json();
if (viewJson.code !== 0) {
  console.error('获取视频信息失败:', viewJson);
  process.exit(1);
}
const data = viewJson.data;
const aid = data.aid;
const cid = data.cid;
console.log(`  标题: ${data.title}`);
console.log(`  UP主: ${data.owner?.name} (UID: ${data.owner?.mid})`);
console.log(`  时长: ${data.duration}s, 播放: ${data.stat?.view}, 点赞: ${data.stat?.like}`);

// 写入 meta.json
const meta = {
  bvid: data.bvid,
  aid: data.aid,
  cid: data.cid,
  title: data.title,
  desc: data.desc,
  owner: data.owner,
  stat: data.stat,
  duration: data.duration,
  pubdate: data.pubdate,
  fetchedAt: new Date().toISOString()
};
writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`[2/5] 获取播放地址 (720P mp4)...`);
const playRes = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=0`, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com'
  }
});
const playJson = await playRes.json();
const videoUrl = playJson.data?.durl?.[0]?.url;
if (!videoUrl) {
  console.error('获取视频下载地址失败:', playJson);
  process.exit(1);
}

const videoPath = path.join(outDir, 'video.mp4');
console.log(`[3/5] 开始下载视频到 ${videoPath}...`);
const curlResult = spawnSync('curl', [
  '-s',
  '-L',
  '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  '-e', 'https://www.bilibili.com',
  '-o', videoPath,
  videoUrl
], { stdio: 'inherit' });

if (curlResult.status !== 0) {
  console.error('下载视频失败');
} else {
  console.log(`  视频下载完成！`);
}

console.log(`[4/5] 抓取评论列表...`);
const allReplies = [];
let nextCursor = 0;
// 抓取前 5 页 (约 100 条热门及最新评论)
for (let page = 1; page <= 5; page++) {
  const replyUrl = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=${nextCursor}&ps=20`;
  try {
    const rRes = await fetch(replyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Referer': `https://www.bilibili.com/video/${bvid}`
      }
    });
    const rJson = await rRes.json();
    if (rJson.code === 0 && rJson.data?.replies) {
      for (const rep of rJson.data.replies) {
        allReplies.push({
          rpid: rep.rpid,
          mid: rep.member?.mid,
          uname: rep.member?.uname,
          avatar: rep.member?.avatar,
          message: rep.content?.message,
          ctime: new Date(rep.ctime * 1000).toISOString(),
          like: rep.like,
          rcount: rep.rcount,
          subReplies: (rep.replies || []).map(sub => ({
            rpid: sub.rpid,
            root: sub.root,
            parent: sub.parent,
            mid: sub.member?.mid,
            uname: sub.member?.uname,
            message: sub.content?.message,
            ctime: new Date(sub.ctime * 1000).toISOString(),
            like: sub.like
          }))
        });
      }
      nextCursor = rJson.data.cursor?.next || 0;
      if (rJson.data.cursor?.is_end || !nextCursor) break;
    } else {
      break;
    }
  } catch (e) {
    console.error('抓取评论页出错:', e.message);
    break;
  }
}

console.log(`  已抓取 ${allReplies.length} 条评论`);
writeFileSync(path.join(outDir, 'comments.json'), JSON.stringify(allReplies, null, 2));
writeFileSync(path.join(outDir, 'comments.jsonl'), allReplies.map(c => JSON.stringify(c)).join('\n') + '\n');

console.log(`[5/5] 生成材料 README.md...`);
const readmeContent = `# Bilibili 视频素材：${data.title}

- **BVID**: [${data.bvid}](https://www.bilibili.com/video/${data.bvid})
- **UP 主**: ${data.owner?.name} (UID: ${data.owner?.mid})
- **发布时间**: ${new Date(data.pubdate * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
- **抓取时间**: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
- **播放数据**: 播放量 ${data.stat?.view} · 点赞 ${data.stat?.like} · 投币 ${data.stat?.coin} · 收藏 ${data.stat?.favorite} · 评论 ${data.stat?.reply}
- **视频文件**: \`video.mp4\`
- **评论数据**: \`comments.json\` / \`comments.jsonl\` (${allReplies.length} 条)

## 简介
${data.desc || '（无简介）'}

## 评论亮点与共鸣精选
${allReplies.slice(0, 10).map((c, i) => `${i + 1}. **${c.uname}** (赞 ${c.like}): ${c.message}`).join('\n\n')}
`;
writeFileSync(path.join(outDir, 'README.md'), readmeContent);

console.log(`全部完成！保存目录: ${outDir}`);
