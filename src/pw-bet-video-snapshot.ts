/**
 * TASK-PW-55B：回流自动记账——在挂 B站 video 产出物的 stat 自动快照成数据文档。
 * TASK-PW-56：b23.tv 短链解析补全——短链也能解出 BV 号，不再跳过留痕。
 *
 * 设计口径：
 * - 产出物范围：pw_artifacts（detached_at IS NULL、platform='B站'、type='video'、url 非空）。
 * - BV 号解析：URL 直接含 BV 号直接取（零网络）；https?://b23.tv/ 短链经
 *   resolveShortLink 解析（缺省 defaultResolveShortLink 发一次 HTTP 跟随跳转；
 *   进程内 Map 缓存 shortUrl → bvid|null，本次进程生命周期内同一短链不重复请求）；
 *   其余 url 零网络返回 null → 跳过该行并 console.warn 留痕。
 * - stat 来源：**复用既有 B站 stat 抓取通路**——本模块不自己发任何请求（Node 进程内
 *   本来就没有 B站 fetch 客户端，抓取发生在 ego-browser 的脚本里），由触发位把
 *   「既有抓取刚产出的 stat」经 fetchStat 注入（同步闭包；返回 null 视为抓取失败）。
 * - 同值跳过：该 bet 最新一条 B站 数据文档的 metrics_json 与本次 {播放,点赞,评论}
 *   三项全同 → 不写；否则 createPwDataDoc（method 照其既有 manual 口径）+ 补一条
 *   pw_runs（createPwDataDoc 内部不落账；kind='sync'/event_type='data_doc'/actor='system'，
 *   与 syncPwBilibili 既有落账口径一致）。collected_at 由 opts.now 注入（缺省 nowIso）。
 * - 单条失败不阻断：逐条 try/catch，失败进 errors；返回 { written, skipped, errors }。
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./data.ts";
import { createPwDataDoc } from "./pw-data-docs.ts";
import { recordPwEvent } from "./pw-runs.ts";

export const BILIBILI_PLATFORM = "B站";

/** b23.tv 短链解析器：url → BV 号（解析不出返回 null）。opts 注入点（测试 mock）。 */
export type ResolveShortLink = (url: string) => Promise<string | null>;

/** 只对 https?://b23.tv/ 前缀发起网络请求；其余 url 零网络直接 null。 */
const B23_SHORT_LINK_PATTERN = /^https?:\/\/b23\.tv\//;
const BVID_PATTERN = /BV[0-9A-Za-z]{10}/;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 进程内短链解析缓存：shortUrl → bvid|null，本次进程生命周期内同一短链不重复请求网络。 */
const shortLinkCache = new Map<string, string | null>();

export type PwSnapshotOptions = {
  /**
   * 取 B站 video 最新 stat（复用既有抓取通路：触发位把刚抓到的 stat 塞进来；
   * 同步返回，返回 null 视为本次抓取失败）。禁止在模块内另起一套抓取。
   */
  fetchStat: (bvid: string) => Record<string, number> | null;
  /** 只处理 URL 能解出该 bvid 的在挂产出物（语料 done 触发位用）；缺省处理全部。 */
  bvidFilter?: string;
  /** collected_at 注入（缺省 nowIso）。 */
  now?: string;
  /** b23.tv 短链解析注入（测试 mock；缺省 defaultResolveShortLink 走真实网络）。 */
  resolveShortLink?: ResolveShortLink;
};

export type PwSnapshotError = {
  artifactId: string;
  betId: string | null;
  reason: string;
};

export type PwSnapshotResult = {
  written: number;
  skipped: number;
  errors: PwSnapshotError[];
};

export async function snapshotPwBetVideoStats(
  db: DatabaseSync,
  options: PwSnapshotOptions,
): Promise<PwSnapshotResult> {
  const bvidFilter = typeof options.bvidFilter === "string" && options.bvidFilter.trim()
    ? options.bvidFilter.trim()
    : undefined;
  const now = options.now ?? nowIso();
  const resolveShortLink = options.resolveShortLink ?? defaultResolveShortLink;

  // 在挂 B站 video 产出物（detached_at IS NULL 已在此滤除，摘除的产出物不进处理范围）
  const artifacts = db.prepare(`
    SELECT id, bet_id, url
    FROM pw_artifacts
    WHERE detached_at IS NULL
      AND platform = ?
      AND type = 'video'
      AND url IS NOT NULL
      AND url != ''
    ORDER BY created_at, id
  `).all(BILIBILI_PLATFORM) as Array<{ id: string; bet_id: string; url: string }>;

  const result: PwSnapshotResult = { written: 0, skipped: 0, errors: [] };

  for (const artifact of artifacts) {
    try {
      const bvid = await resolveBvid(artifact.url, resolveShortLink);
      if (!bvid) {
        result.skipped += 1;
        console.warn(
          `[PW-55B] 产出物 ${artifact.id}（${artifact.url}）无法解析 BV 号，跳过自动记账`,
        );
        continue;
      }
      if (bvidFilter !== undefined && bvid !== bvidFilter) continue;
      const stat = options.fetchStat(bvid);
      if (!stat) {
        result.errors.push({
          artifactId: artifact.id,
          betId: artifact.bet_id,
          reason: `fetchStat 未返回有效 stat（bvid=${bvid}）`,
        });
        continue;
      }
      const metrics = pickVideoMetrics(stat);
      if (sameAsLatestBetDoc(db, artifact.bet_id, metrics)) {
        result.skipped += 1;
        continue;
      }
      const doc = createPwDataDoc(db, {
        betId: artifact.bet_id,
        artifactId: artifact.id,
        platform: BILIBILI_PLATFORM,
        collectedAt: now,
        metricsJson: JSON.stringify(metrics),
        rawRef: `B站 stat 自动回流 ${bvid}`,
      });
      // createPwDataDoc 内部不落 pw_runs，此处补一条（kind='sync'、data_doc、system，照 syncPwBilibili 口径）
      recordPwEvent(db, {
        kind: "sync",
        eventType: "data_doc",
        actor: "system",
        payloadJson: JSON.stringify({ artifactId: artifact.id, bvid, metrics }),
        relatedIds: [doc.id, artifact.id],
        betId: artifact.bet_id,
      });
      result.written += 1;
    } catch (error) {
      // 单条失败不阻断其余产出物
      result.errors.push({
        artifactId: artifact.id,
        betId: artifact.bet_id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * 解析产出物 URL 的 BV 号：直接含 BV 直接取（零网络）；b23.tv 短链走 resolveShortLink
 * 解析（进程内 Map 缓存：同一短链本次进程内不重复请求）；其余 url 零网络返回 null。
 */
async function resolveBvid(
  url: string,
  resolveShortLink: ResolveShortLink,
): Promise<string | null> {
  const direct = url.match(BVID_PATTERN);
  if (direct) return direct[0];
  if (!B23_SHORT_LINK_PATTERN.test(url)) return null;
  const cached = shortLinkCache.get(url);
  if (cached !== undefined) return cached;
  const bvid = await resolveShortLink(url);
  shortLinkCache.set(url, bvid);
  return bvid;
}

/**
 * 缺省 b23.tv 短链解析：fetch 跟随跳转（redirect:'follow'、10s 超时、UA 头）→
 * 先看 response.url 是否含 BV[0-9A-Za-z]{10} → 没有再读 body 前 5000 字符找 BV →
 * 都没有返回 null。只对 https?://b23.tv/ 前缀发起请求，其余 url 零网络直接 null。
 */
export async function defaultResolveShortLink(url: string): Promise<string | null> {
  if (!B23_SHORT_LINK_PATTERN.test(url)) return null;
  const bvidOf = (text: string): string | null => {
    const match = text.match(BVID_PATTERN);
    return match ? match[0] : null;
  };
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": USER_AGENT },
  });
  const fromUrl = bvidOf(response.url);
  if (fromUrl) return fromUrl;
  const body = await response.text();
  return bvidOf(body.slice(0, 5_000));
}

/** 数据文档口径：只保留同值判断用的 播放/点赞/评论 三项（缺省 0，非法值截断为整数）。 */
function pickVideoMetrics(stat: Record<string, number>): Record<string, number> {
  const pick = (key: string): number => {
    const value = stat[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  };
  return { 播放: pick("播放"), 点赞: pick("点赞"), 评论: pick("评论") };
}

/** 该 bet 最新一条 B站 数据文档与本次三项全同 → true（不写、不灌水）。 */
function sameAsLatestBetDoc(
  db: DatabaseSync,
  betId: string,
  metrics: Record<string, number>,
): boolean {
  const row = db.prepare(`
    SELECT metrics_json
    FROM pw_data_docs
    WHERE bet_id = ? AND platform = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(betId, BILIBILI_PLATFORM) as { metrics_json: string } | undefined;
  if (!row) return false;
  let latest: unknown;
  try {
    latest = JSON.parse(row.metrics_json);
  } catch {
    return false;
  }
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return false;
  const doc = latest as Record<string, unknown>;
  return doc["播放"] === metrics["播放"]
    && doc["点赞"] === metrics["点赞"]
    && doc["评论"] === metrics["评论"];
}
