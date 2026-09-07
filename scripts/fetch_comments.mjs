import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const bvid = process.argv[2] || 'BV1VB3v6WEfw';
const outDir = path.resolve('materials', bvid);
const meta = JSON.parse(readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
const aid = String(meta.aid);

const allReplies = [];
let nextCursor = 0;

for (let page = 1; page <= 8; page++) {
  const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&next=${nextCursor}&ps=20`;
  const res = spawnSync('curl', ['-s', '-A', 'Mozilla/5.0', url], { encoding: 'utf8' });
  try {
    const json = JSON.parse(res.stdout);
    if (json.code === 0 && json.data?.replies) {
      for (const rep of json.data.replies) {
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
      nextCursor = json.data.cursor?.next;
      console.log(`Page ${page}: got ${json.data.replies.length} replies, total so far: ${allReplies.length}`);
      if (json.data.cursor?.is_end || !nextCursor) break;
    } else {
      console.log(`Page ${page} returned code:`, json.code);
      break;
    }
  } catch (e) {
    console.error(`Page ${page} parse error:`, e.message);
    break;
  }
}

writeFileSync(path.join(outDir, 'comments.json'), JSON.stringify(allReplies, null, 2));
writeFileSync(path.join(outDir, 'comments.jsonl'), allReplies.map(c => JSON.stringify(c)).join('\n') + '\n');
console.log(`Successfully saved ${allReplies.length} comments to ${outDir}`);
