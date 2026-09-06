/**
 * TASK-PW-76：飞书多维表格（Bitable）客户端——搜证智能体的唯一落盘出口。
 *
 * 职责：租户令牌缓存、记录 创建/更新/按字段查找、按去重键 upsert、关联字段合并，
 * 以及把一次搜证结果（速记 + 主题 + N 条证据）串行写进三张表。
 *
 * 纪律：
 * - 官方文档："建议对单个 Base 一次只执行一个写操作"。本客户端内所有写操作过同一条 promise 链，天然串行。
 * - 表 ID、字段名全部来自配置（fieldMap），代码里没有任何写死的中文列名；改表结构改配置不改代码。
 * - 任何失败抛错给调用方并带 HTTP 状态与响应摘要；本模块不吞异常（吞异常是 PW-75 第一版的坑）。
 * - 只写不读业务逻辑：读操作仅限「按键查找」与「取关联字段现值」，为 upsert 服务；表不是控制台。
 */

export type BitableTables = {
  notes: string;
  evidence: string;
  topics: string;
  /** 产出表，仅 IDE Skill 回写时使用；中继不写。 */
  outputs?: string;
};

export type BitableFieldMap = {
  notes: { text: string; time: string; queries: string; topic: string; topicKey: string; memo: string };
  evidence: {
    key: string; title: string; url: string; source: string; tier: string; publishedAt: string;
    quote: string; metrics: string; heat: string; why: string; note: string; topic: string; topicKey: string; fetchedAt: string;
  };
  topics: { key: string; status: string };
};

/**
 * 缺省列名。速记表与证据表都冗余一列文本「主题键」：IDE Skill 按主题拉包时用文本精确过滤，
 * 比对关联字段做 contains 过滤可靠得多；关联字段仍然写，供表内查找引用/rollup 用。
 */
export const DEFAULT_FIELD_MAP: BitableFieldMap = {
  notes: { text: "原文", time: "时间", queries: "查询词", topic: "主题", topicKey: "主题键", memo: "Memos" },
  evidence: {
    key: "去重键", title: "标题", url: "URL", source: "源", tier: "层级", publishedAt: "发布时间",
    quote: "摘录", metrics: "指标JSON", heat: "热度分", why: "相关性", note: "速记", topic: "主题", topicKey: "主题键", fetchedAt: "抓取时间",
  },
  topics: { key: "主题键", status: "状态" },
};

export type BitableConfig = {
  appToken: string;
  tables: BitableTables;
  /** 租户域名，用于拼可点击链接，如 https://xxx.feishu.cn */
  baseUrl?: string;
  /** 日期字段写法：多维表格「日期」类型要毫秒时间戳；若你建的是文本列则设 "text"。 */
  dateAs: "timestamp" | "text";
  fieldMap: BitableFieldMap;
};

export type BitableDeps = {
  fetch: typeof fetch;
  now: () => Date;
  log: (fields: Record<string, unknown>) => void;
  appId: string;
  appSecret: string;
  /** 开放平台域名，默认 https://open.feishu.cn */
  openBaseUrl?: string;
};

const TOKEN_URL = "/open-apis/auth/v3/tenant_access_token/internal";
const TOKEN_SAFETY_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

/** 把 unknown 配置对象读成 BitableConfig；缺关键项抛人话错误。 */
export function readBitableConfig(value: unknown): BitableConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bitable 配置必须是对象");
  const record = value as Record<string, unknown>;
  const appToken = str(record.appToken);
  if (!appToken) throw new Error("bitable.appToken 缺失");
  const tables = record.tables && typeof record.tables === "object" ? (record.tables as Record<string, unknown>) : {};
  const notes = str(tables.notes);
  const evidence = str(tables.evidence);
  const topics = str(tables.topics);
  if (!notes || !evidence || !topics) throw new Error("bitable.tables 需要 notes / evidence / topics 三个表 ID");
  const outputs = str(tables.outputs) || undefined;
  const dateAs = record.dateAs === "text" ? "text" : "timestamp";
  const fieldMap = mergeFieldMap(record.fieldMap);
  return {
    appToken,
    tables: { notes, evidence, topics, outputs },
    baseUrl: str(record.baseUrl).replace(/\/+$/u, "") || undefined,
    dateAs,
    fieldMap,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function mergeFieldMap(value: unknown): BitableFieldMap {
  const base: BitableFieldMap = JSON.parse(JSON.stringify(DEFAULT_FIELD_MAP));
  if (!value || typeof value !== "object") return base;
  const record = value as Record<string, Record<string, unknown>>;
  for (const table of ["notes", "evidence", "topics"] as const) {
    const overrides = record[table];
    if (!overrides || typeof overrides !== "object") continue;
    const target = base[table] as Record<string, string>;
    for (const [key, name] of Object.entries(overrides)) {
      if (typeof name === "string" && name.trim() && key in target) target[key] = name.trim();
    }
  }
  return base;
}

export type BitableRecord = { record_id: string; fields: Record<string, unknown> };

export class BitableClient {
  private readonly config: BitableConfig;
  private readonly deps: BitableDeps;
  private token: { value: string; expiresAt: number } | undefined;
  /** 串行写链：所有写操作挂在这条链上。 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(config: BitableConfig, deps: BitableDeps) {
    this.config = config;
    this.deps = deps;
  }

  get tables(): BitableTables {
    return this.config.tables;
  }

  get fieldMap(): BitableFieldMap {
    return this.config.fieldMap;
  }

  /** 表格可点击链接（有 baseUrl 才给）。 */
  tableUrl(tableId: string): string | undefined {
    return this.config.baseUrl
      ? `${this.config.baseUrl}/base/${this.config.appToken}?table=${tableId}`
      : undefined;
  }

  /** 日期值：按配置写毫秒时间戳或 ISO 文本；无法解析的返回 undefined（不写该字段）。 */
  dateValue(iso: string | undefined): number | string | undefined {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return this.config.dateAs === "text" ? iso : undefined;
    return this.config.dateAs === "text" ? new Date(ms).toISOString() : ms;
  }

  /** 串行执行：保证同一 Base 同一时刻只有一个写操作在飞。 */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async tenantToken(): Promise<string> {
    const now = this.deps.now().getTime();
    if (this.token && this.token.expiresAt - TOKEN_SAFETY_MS > now) return this.token.value;
    const response = await this.deps.fetch(`${this.openBase()}${TOKEN_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: this.deps.appId, app_secret: this.deps.appSecret }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const value = typeof parsed.tenant_access_token === "string" ? parsed.tenant_access_token : "";
    if (!response.ok || !value) {
      throw new Error(`租户令牌获取失败 ${response.status}：${String(parsed.msg ?? "").slice(0, 120)}`);
    }
    const ttlSeconds = typeof parsed.expire === "number" ? parsed.expire : 7200;
    this.token = { value, expiresAt: now + ttlSeconds * 1000 };
    return value;
  }

  private openBase(): string {
    return (this.deps.openBaseUrl ?? "https://open.feishu.cn").replace(/\/+$/u, "");
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = await this.tenantToken();
    const response = await this.deps.fetch(`${this.openBase()}/open-apis/bitable/v1/apps/${this.config.appToken}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof parsed.code === "number" ? parsed.code : 0;
    if (!response.ok || code !== 0) {
      throw new Error(`Bitable ${method} ${path} 失败 ${response.status}/${code}：${String(parsed.msg ?? "").slice(0, 160)}`);
    }
    return (parsed.data && typeof parsed.data === "object" ? parsed.data : {}) as Record<string, unknown>;
  }

  /** 按某字段精确值查一条记录（用于 upsert）。 */
  async findByField(tableId: string, fieldName: string, value: string): Promise<BitableRecord | undefined> {
    const data = await this.call("POST", `/tables/${tableId}/records/search`, {
      filter: { conjunction: "and", conditions: [{ field_name: fieldName, operator: "is", value: [value] }] },
      page_size: 1,
    });
    const items = Array.isArray(data.items) ? data.items : [];
    const first = items[0] as Record<string, unknown> | undefined;
    if (!first || typeof first.record_id !== "string") return undefined;
    return { record_id: first.record_id, fields: (first.fields ?? {}) as Record<string, unknown> };
  }

  createRecord(tableId: string, fields: Record<string, unknown>): Promise<string> {
    return this.serial(async () => {
      const data = await this.call("POST", `/tables/${tableId}/records`, { fields: stripUndefined(fields) });
      const record = data.record as Record<string, unknown> | undefined;
      if (!record || typeof record.record_id !== "string") throw new Error("Bitable 创建记录未返回 record_id");
      return record.record_id;
    });
  }

  updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      await this.call("PUT", `/tables/${tableId}/records/${recordId}`, { fields: stripUndefined(fields) });
    });
  }

  /**
   * 按键 upsert：存在则更新（并把 linkFields 里的关联 id 并进现值），不存在则创建。
   * 返回 record_id 与 created 标记。
   */
  async upsertByKey(
    tableId: string,
    keyField: string,
    keyValue: string,
    fields: Record<string, unknown>,
    linkFields: Record<string, string[]> = {},
  ): Promise<{ recordId: string; created: boolean }> {
    const existing = await this.findByField(tableId, keyField, keyValue);
    if (!existing) {
      const recordId = await this.createRecord(tableId, { ...fields, [keyField]: keyValue, ...linkFields });
      return { recordId, created: true };
    }
    const merged: Record<string, unknown> = { ...fields };
    for (const [field, ids] of Object.entries(linkFields)) {
      const current = mergeLinkIds(existing.fields[field], []);
      const next = mergeLinkIds(existing.fields[field], ids);
      if (next.length !== current.length) merged[field] = next;
    }
    // 没有任何字段需要变更（例如主题表只有键）就不发 PUT，省一次串行写
    if (Object.keys(stripUndefined(merged)).length) {
      await this.updateRecord(tableId, existing.record_id, merged);
    }
    return { recordId: existing.record_id, created: false };
  }
}

/** 关联字段现值可能是 ["rec…"] 或 [{record_ids:[…]}] / [{id:…}]；统一并成去重后的 id 数组。 */
export function mergeLinkIds(current: unknown, additions: string[]): string[] {
  const ids = new Set<string>();
  if (Array.isArray(current)) {
    for (const item of current) {
      if (typeof item === "string") ids.add(item);
      else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (typeof record.record_id === "string") ids.add(record.record_id);
        if (typeof record.id === "string") ids.add(record.id);
        if (Array.isArray(record.record_ids)) for (const id of record.record_ids) if (typeof id === "string") ids.add(id);
      }
    }
  } else if (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.link_record_ids)) for (const id of record.link_record_ids) if (typeof id === "string") ids.add(id);
  }
  for (const id of additions) if (id) ids.add(id);
  return [...ids];
}

function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out;
}

// ---------------------------------------------------------------------------
// 搜证结果落盘
// ---------------------------------------------------------------------------

export type EvidenceRow = {
  key: string;
  title: string;
  url: string;
  source: string;
  tier: "T0" | "T1" | "T2";
  publishedAt?: string;
  quote: string;
  metrics: Record<string, unknown>;
  heat: number;
  why: string;
};

export type EvidenceBundle = {
  topicKey: string;
  note: { text: string; memo: string; at: string; queries: string[] };
  evidence: EvidenceRow[];
};

export type WriteBundleResult = {
  topicId: string;
  noteId: string;
  evidenceIds: string[];
  created: number;
  updated: number;
  tableUrl?: string;
};

/**
 * 一次搜证 → 三张表。顺序：主题 upsert → 速记 create → 证据逐条 upsert（并把速记/主题 id 并进关联）。
 * 任何一步失败直接抛出，调用方决定怎么回执；不做"写一半算成功"。
 */
export async function writeEvidenceBundle(client: BitableClient, bundle: EvidenceBundle): Promise<WriteBundleResult> {
  const { tables, fieldMap } = client;

  const topic = await client.upsertByKey(tables.topics, fieldMap.topics.key, bundle.topicKey, {});
  const topicId = topic.recordId;

  const noteFields: Record<string, unknown> = {
    [fieldMap.notes.text]: bundle.note.text,
    [fieldMap.notes.time]: client.dateValue(bundle.note.at),
    [fieldMap.notes.queries]: bundle.note.queries.join(", "),
    [fieldMap.notes.memo]: bundle.note.memo || undefined,
    [fieldMap.notes.topic]: [topicId],
    [fieldMap.notes.topicKey]: bundle.topicKey,
  };
  const noteId = await client.createRecord(tables.notes, noteFields);

  const evidenceIds: string[] = [];
  let created = 0;
  let updated = 0;
  for (const row of bundle.evidence) {
    const fields: Record<string, unknown> = {
      [fieldMap.evidence.title]: row.title,
      [fieldMap.evidence.url]: row.url,
      [fieldMap.evidence.source]: row.source,
      [fieldMap.evidence.tier]: row.tier,
      [fieldMap.evidence.publishedAt]: client.dateValue(row.publishedAt),
      [fieldMap.evidence.quote]: row.quote || undefined,
      [fieldMap.evidence.metrics]: JSON.stringify(row.metrics),
      [fieldMap.evidence.heat]: row.heat,
      [fieldMap.evidence.why]: row.why || undefined,
      [fieldMap.evidence.topicKey]: bundle.topicKey,
      [fieldMap.evidence.fetchedAt]: client.dateValue(bundle.note.at),
    };
    const result = await client.upsertByKey(tables.evidence, fieldMap.evidence.key, row.key, fields, {
      [fieldMap.evidence.note]: [noteId],
      [fieldMap.evidence.topic]: [topicId],
    });
    evidenceIds.push(result.recordId);
    if (result.created) created += 1;
    else updated += 1;
  }

  return { topicId, noteId, evidenceIds, created, updated, tableUrl: client.tableUrl(tables.evidence) };
}
