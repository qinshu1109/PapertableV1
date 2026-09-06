// 共享工具：读中继配置、取租户令牌、按文本字段查全表、建/改记录、字段值拍平。
// 独立于仓库 src/，Node >= 20 即可运行；密钥只在本进程内存里，不打印。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPEN = "https://open.feishu.cn";
const TIMEOUT = 15_000;

export const DEFAULT_FIELDS = {
  notes: { text: "原文", time: "时间", queries: "查询词", topic: "主题", topicKey: "主题键", memo: "Memos" },
  evidence: {
    key: "去重键", title: "标题", url: "URL", source: "源", tier: "层级", publishedAt: "发布时间",
    quote: "摘录", metrics: "指标JSON", heat: "热度分", why: "相关性", note: "速记", topic: "主题", topicKey: "主题键", fetchedAt: "抓取时间",
  },
  topics: { key: "主题键", status: "状态" },
  outputs: {
    title: "标题", body: "正文", platform: "平台", topicKey: "主题键", evidence: "引用证据", notes: "引用速记",
    model: "模型", time: "时间", url: "发布链接",
  },
};

export function loadConfig() {
  const path = process.env.FEISHU_RELAY_CONFIG?.trim()
    || join(homedir(), "Library", "Application Support", "Papertable", "feishu-relay.json");
  const root = JSON.parse(readFileSync(path, "utf8"));
  const ev = root.evidence ?? {};
  const bitable = ev.bitable;
  if (!root.appId || !root.appSecret) throw new Error(`缺 appId/appSecret：${path}`);
  if (!bitable?.appToken || !bitable?.tables) throw new Error(`缺 evidence.bitable.appToken / tables：${path}`);
  const fields = JSON.parse(JSON.stringify(DEFAULT_FIELDS));
  for (const table of Object.keys(fields)) {
    for (const [k, v] of Object.entries(bitable.fieldMap?.[table] ?? {})) {
      if (typeof v === "string" && v.trim() && k in fields[table]) fields[table][k] = v.trim();
    }
  }
  return {
    appId: root.appId,
    appSecret: root.appSecret,
    appToken: bitable.appToken,
    tables: bitable.tables,
    baseUrl: typeof bitable.baseUrl === "string" ? bitable.baseUrl.replace(/\/+$/u, "") : undefined,
    dateAs: bitable.dateAs === "text" ? "text" : "timestamp",
    fields,
  };
}

async function req(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (typeof data.code === "number" && data.code !== 0)) {
    throw new Error(`飞书 ${init?.method ?? "GET"} ${url.replace(OPEN, "")} → ${res.status}/${data.code ?? "?"} ${data.msg ?? ""}`);
  }
  return data.data ?? data;
}

export async function tenantToken(cfg) {
  const data = await req(`${OPEN}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  });
  if (!data.tenant_access_token) throw new Error("租户令牌为空");
  return data.tenant_access_token;
}

/** 按文本字段精确值查全部记录（自动翻页，最多 500 条）。 */
export async function searchAll(cfg, token, tableId, fieldName, value) {
  const items = [];
  let pageToken;
  do {
    const data = await req(`${OPEN}/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records/search${pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filter: { conjunction: "and", conditions: [{ field_name: fieldName, operator: "is", value: [value] }] },
        page_size: 100,
      }),
    });
    for (const item of data.items ?? []) items.push(item);
    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken && items.length < 500);
  return items;
}

export async function createRecord(cfg, token, tableId, fields) {
  const data = await req(`${OPEN}/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: strip(fields) }),
  });
  return data.record?.record_id;
}

export async function updateRecord(cfg, token, tableId, recordId, fields) {
  await req(`${OPEN}/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: strip(fields) }),
  });
}

function strip(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
}

/** 多维表格读出来的字段值拍平：文本段数组 → 字符串；关联 → id 数组；其余原样。 */
export function plain(value) {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return value;
    if (value.every((v) => v && typeof v === "object" && ("text" in v))) return value.map((v) => v.text).join("");
    if (value.every((v) => v && typeof v === "object" && ("record_id" in v || "id" in v))) return value.map((v) => v.record_id ?? v.id);
    if (value.length && value[0] && typeof value[0] === "object" && Array.isArray(value[0].record_ids)) return value.flatMap((v) => v.record_ids);
  }
  if (value && typeof value === "object" && Array.isArray(value.link_record_ids)) return value.link_record_ids;
  if (value && typeof value === "object" && typeof value.link === "string") return value.link;
  return value;
}

export function dateOut(cfg, ms) {
  return cfg.dateAs === "text" ? new Date(ms).toISOString() : ms;
}

export function dateIn(value) {
  if (typeof value === "number") return new Date(value).toISOString().slice(0, 10);
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? "" : new Date(ms).toISOString().slice(0, 10);
  }
  return "";
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
