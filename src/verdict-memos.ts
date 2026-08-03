import { createHash } from "node:crypto";

export const VERDICT_CUBE_ID = "papertable-verdicts";
const MARKER = "papertable-verdict";
const MAX_LINE_LENGTH = 500;
const MAX_QUERY_LENGTH = 500;
// ponytail: MCP 搜索没有分页且 top_k 上限为 50；服务端提供游标后再换掉这个窗口。
const MAX_SEARCH_RESULTS = 50;
const LOCKED_FIELDS = [
  "verdict_type",
  "concepts",
  "source_kind",
  "source_id",
  "user_confirmed",
  "idempotency_key",
] as const;
const GOLD_SOURCE_FIELDS = ["source_card_id", "source_turn_id"] as const;

export type VerdictType = "tombstone" | "gold";
export type VerdictSourceKind = "edge" | "turn";

export type VerdictInput = {
  projectId: string;
  verdictType: VerdictType;
  sourceKind: VerdictSourceKind;
  sourceId: string;
  sourceCardId?: string;
  sourceTurnId?: string;
  content: string;
  concepts: string[];
};

export type RemoteVerdict = VerdictInput & {
  id: string;
  status: "confirmed";
  idempotencyKey: string;
  supersedesMemoryId: string | null;
};

export type RemoteVerdictList = {
  verdicts: RemoteVerdict[];
  history: RemoteVerdict[];
};

export type VerdictRemote = {
  health(): Promise<{ available: true; cubeId: typeof VERDICT_CUBE_ID }>;
  ensureCube(): Promise<{ cubeId: typeof VERDICT_CUBE_ID; created: boolean }>;
  list(projectId: string, concept?: string): Promise<RemoteVerdictList>;
  confirm(input: VerdictInput): Promise<{ verdict: RemoteVerdict; created: boolean }>;
  supersede(
    memoryId: string,
    input: VerdictInput,
  ): Promise<{ verdict: RemoteVerdict; created: boolean }>;
};

export class VerdictContractError extends Error {
  override name = "VerdictContractError";
}

type CallTool = (
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, name: string, max = 200): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || [...value.trim()].length > max
  ) {
    throw new Error(`${name} 格式不正确。`);
  }
  return value.trim();
}

export function normalizeVerdictInput(
  input: VerdictInput,
  supersedesMemoryId: string | null = null,
): VerdictInput & { idempotencyKey: string } {
  const projectId = text(input?.projectId, "projectId");
  const verdictType = input?.verdictType;
  if (!(["tombstone", "gold"] as const).includes(verdictType)) {
    throw new Error("verdictType 格式不正确。");
  }
  const sourceKind = input?.sourceKind;
  if (!(["edge", "turn"] as const).includes(sourceKind)) {
    throw new Error("sourceKind 格式不正确。");
  }
  const sourceId = text(input?.sourceId, "sourceId");
  const sourceCardId = input?.sourceCardId
    ? text(input.sourceCardId, "sourceCardId")
    : undefined;
  const sourceTurnId = input?.sourceTurnId
    ? text(input.sourceTurnId, "sourceTurnId")
    : undefined;
  if (Boolean(sourceCardId) !== Boolean(sourceTurnId)) {
    throw new Error("sourceCardId 和 sourceTurnId 必须同时提供。");
  }
  if (
    (verdictType === "gold" && (
      sourceKind !== "turn"
      || !sourceCardId
      || !sourceTurnId
      || sourceId !== sourceTurnId
    ))
    || (verdictType === "tombstone" && (
      sourceKind !== "edge"
      || sourceCardId
      || sourceTurnId
    ))
  ) {
    throw new Error("判决类型与来源不匹配。");
  }
  const content = text(input?.content, "content", MAX_LINE_LENGTH);
  if (/[\r\n]/u.test(content)) throw new Error("判决必须是单行。");
  const concepts = [...new Set(input?.concepts ?? [])]
    .map((value) => text(value, "concept", 80));
  if (!concepts.length || concepts.length > 16) {
    throw new Error("concepts 必须包含 1 到 16 个概念。");
  }
  const keyParts: Array<string | null> = [
    projectId,
    verdictType,
    sourceKind,
    sourceId,
    supersedesMemoryId,
  ];
  if (sourceCardId && sourceTurnId) keyParts.push(sourceCardId, sourceTurnId);
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(keyParts))
    .digest("hex");
  return {
    projectId,
    verdictType,
    sourceKind,
    sourceId,
    ...(sourceCardId && sourceTurnId ? { sourceCardId, sourceTurnId } : {}),
    content,
    concepts,
    idempotencyKey,
  };
}

function memoryView(record: unknown): RemoteVerdict | null {
  const value = object(record);
  const view = object(value?.memory_view);
  const attributes = object(view?.attributes);
  const metadata = object(value?.metadata);
  const info = object(metadata?.info);
  const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];
  const sourceCardId = typeof attributes?.source_card_id === "string"
    ? attributes.source_card_id
    : undefined;
  const sourceTurnId = typeof attributes?.source_turn_id === "string"
    ? attributes.source_turn_id
    : undefined;
  const verdictType = attributes?.verdict_type;
  const sourceKind = attributes?.source_kind;
  const sourceId = attributes?.source_id;
  if (
    typeof value?.memory_id !== "string"
    || view?.semantic_type !== "decision"
    || typeof view?.subject_id !== "string"
    || view?.client_id !== "papertable"
    || view?.subject_type !== "other"
    || view?.status !== "activated"
    || attributes?.user_confirmed !== true
    || (verdictType !== "tombstone" && verdictType !== "gold")
    || !Array.isArray(attributes?.concepts)
    || typeof sourceKind !== "string"
    || typeof sourceId !== "string"
    || typeof attributes?.idempotency_key !== "string"
    || !Array.isArray(view?.locked_fields)
    || !LOCKED_FIELDS.every((field) => view.locked_fields.includes(field))
    || Boolean(sourceCardId) !== Boolean(sourceTurnId)
    || (verdictType === "gold" && (
      sourceKind !== "turn"
      || !sourceCardId
      || !sourceTurnId
      || sourceId !== sourceTurnId
    ))
    || (verdictType === "tombstone" && (
      sourceKind !== "edge"
      || sourceCardId
      || sourceTurnId
    ))
    || (sourceCardId && !GOLD_SOURCE_FIELDS.every((field) =>
      view.locked_fields!.includes(field)))
    || info?.hot_policy !== "exclude"
    || !tags.includes("brain:ignore")
  ) {
    return null;
  }
  const concepts = attributes.concepts.filter(
    (item): item is string => typeof item === "string",
  );
  const raw = typeof value.memory === "string" ? value.memory : "";
  const legacyPrefix = `${MARKER}:${attributes.idempotency_key} `;
  const prefix = `${legacyPrefix}${concepts.join(" ")} | `;
  const content = raw.startsWith(prefix)
    ? raw.slice(prefix.length)
    : raw.startsWith(legacyPrefix)
      ? raw.slice(legacyPrefix.length)
      : null;
  if (
    !content
    || /[\r\n]/u.test(content)
    || [...content].length > MAX_LINE_LENGTH
  ) {
    return null;
  }
  return {
    id: value.memory_id,
    projectId: view.subject_id,
    verdictType,
    concepts,
    sourceKind: sourceKind as VerdictSourceKind,
    sourceId,
    ...(sourceCardId && sourceTurnId ? { sourceCardId, sourceTurnId } : {}),
    content,
    status: "confirmed",
    idempotencyKey: attributes.idempotency_key,
    supersedesMemoryId: typeof info?.supersedes_memory_id === "string"
      ? info.supersedes_memory_id
      : null,
  };
}

export function createVerdictRemote(callTool: CallTool): VerdictRemote {
  const pending = new Map<string, Promise<{ verdict: RemoteVerdict; created: boolean }>>();
  const call = (name: string, args: Record<string, unknown>, timeoutMs?: number) =>
    callTool(name, args, timeoutMs);

  async function ensureCube() {
    const listed = await call("list_cubes", {});
    const cubes = Array.isArray(listed.cubes) ? listed.cubes : [];
    if (cubes.some((cube) => object(cube)?.cube_id === VERDICT_CUBE_ID)) {
      return { cubeId: VERDICT_CUBE_ID, created: false } as const;
    }
    try {
      await call("create_cube", {
        cube_id: VERDICT_CUBE_ID,
        name: "Papertable 判决簿",
        description:
          "仅保存 Papertable 用户确认的项目判决；按项目隔离，排除 Brain 与热记忆，只允许 supersede。",
        max_memories: 2000,
      });
      return { cubeId: VERDICT_CUBE_ID, created: true } as const;
    } catch (error) {
      const retried = await call("list_cubes", {});
      const retryCubes = Array.isArray(retried.cubes) ? retried.cubes : [];
      if (retryCubes.some((cube) => object(cube)?.cube_id === VERDICT_CUBE_ID)) {
        return { cubeId: VERDICT_CUBE_ID, created: false } as const;
      }
      throw error;
    }
  }

  async function searchRaw(projectId: string, query = MARKER): Promise<RemoteVerdict[]> {
    const result = await call("search_memories", {
      query,
      cube_ids: [VERDICT_CUBE_ID],
      top_k: MAX_SEARCH_RESULTS,
      rerank: "off",
      search_mode: "fts",
      semantic_types: ["decision"],
      subject_types: ["other"],
      subject_ids: [projectId],
      statuses: ["activated"],
    });
    if (!Array.isArray(result.results)) {
      throw new VerdictContractError("MemOS 判决检索结果缺少 results 数组");
    }
    const parsed = result.results.map(memoryView);
    if (parsed.some((item) => item === null)) {
      throw new VerdictContractError("MemOS 返回了格式不正确的判决记录");
    }
    return parsed.filter(
      (item): item is RemoteVerdict => item !== null && item.projectId === projectId,
    );
  }

  async function findByKey(input: { projectId: string; idempotencyKey: string }) {
    const found = await searchRaw(input.projectId, input.idempotencyKey);
    return found.find((item) => item.idempotencyKey === input.idempotencyKey);
  }

  async function add(
    input: ReturnType<typeof normalizeVerdictInput>,
    supersedesMemoryId: string | null = null,
  ) {
    const existing = await findByKey(input);
    if (existing) return { verdict: existing, created: false };
    const lockedFields = input.sourceCardId && input.sourceTurnId
      ? [...LOCKED_FIELDS, ...GOLD_SOURCE_FIELDS]
      : [...LOCKED_FIELDS];
    const result = await call("add_memory", {
      cube_id: VERDICT_CUBE_ID,
      content: `${MARKER}:${input.idempotencyKey} ${input.concepts.join(" ")} | ${input.content}`,
      tags: [
        "brain:ignore",
        "papertable-verdict",
        "hot_policy=exclude",
        "semantic_type=decision",
      ],
      source: `papertable:${input.sourceKind}:${input.sourceId}`,
      hot_policy: "exclude",
      semantic_type: "decision",
      subject_type: "other",
      subject_id: input.projectId,
      asserted_by: "user",
      client_id: "papertable",
      attributes: {
        verdict_type: input.verdictType,
        concepts: input.concepts,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        ...(input.sourceCardId && input.sourceTurnId
          ? {
              source_card_id: input.sourceCardId,
              source_turn_id: input.sourceTurnId,
            }
          : {}),
        user_confirmed: true,
        idempotency_key: input.idempotencyKey,
      },
      locked_fields: lockedFields,
      ...(supersedesMemoryId ? { supersedes_memory_id: supersedesMemoryId } : {}),
    });
    if (typeof result.memory_id !== "string") throw new Error("MemOS 未返回 memory_id");
    const record = await call("get_memory", {
      cube_id: VERDICT_CUBE_ID,
      memory_id: result.memory_id,
    });
    const verdict = memoryView(record);
    if (!verdict) throw new Error("MemOS 写入后校验失败");
    return { verdict, created: true };
  }

  async function serial(
    key: string,
    operation: () => Promise<{ verdict: RemoteVerdict; created: boolean }>,
  ) {
    const current = pending.get(key);
    if (current) return current;
    const promise = operation().finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  return {
    async health() {
      const result = await call("health", {});
      if (result.status !== "ok") throw new Error("MemOS 状态异常");
      return { available: true, cubeId: VERDICT_CUBE_ID };
    },
    ensureCube,
    async list(projectId, concept) {
      projectId = text(projectId, "projectId");
      const found = await searchRaw(projectId);
      const superseded = new Set(
        found.map((item) => item.supersedesMemoryId).filter(Boolean),
      );
      const needle = concept
        ? text(concept, "concept", MAX_QUERY_LENGTH).toLocaleLowerCase()
        : null;
      const matches = (item: RemoteVerdict) =>
        !needle
        || item.content.toLocaleLowerCase().includes(needle)
        || item.concepts.some((value) => {
          const conceptValue = value.toLocaleLowerCase();
          return conceptValue.includes(needle) || needle.includes(conceptValue);
        });
      return {
        verdicts: found.filter((item) => !superseded.has(item.id) && matches(item)),
        history: found.filter(matches),
      };
    },
    async confirm(raw) {
      const input = normalizeVerdictInput(raw);
      await ensureCube();
      return serial(input.idempotencyKey, () => add(input));
    },
    async supersede(memoryId, raw) {
      memoryId = text(memoryId, "memoryId");
      const original = memoryView(await call("get_memory", {
        cube_id: VERDICT_CUBE_ID,
        memory_id: memoryId,
      }));
      if (!original) throw new Error("原判决不存在或格式不正确。");
      const input = normalizeVerdictInput(raw, memoryId);
      if (
        original.projectId !== input.projectId
        || original.verdictType !== input.verdictType
        || original.sourceKind !== input.sourceKind
        || original.sourceId !== input.sourceId
        || original.sourceCardId !== input.sourceCardId
        || original.sourceTurnId !== input.sourceTurnId
      ) {
        throw new Error("修订必须保持项目、判决类型和来源。");
      }
      return serial(input.idempotencyKey, () => add(input, memoryId));
    },
  };
}
