/**
 * run ↔ 会话 assistant 条目的稳定绑定。
 *
 * 背景：pt_runs.answer 经过证据闸门二次组装，与会话里 sanitize 后的 assistant
 * 文本不保证逐字相等（历史上多出的 `---` 曾导致严格相等匹配失败，concepts /
 * citations 全部丢失）。因此绑定不允许再比较正文文本。
 *
 * 稳定标识：每个 run 启动时把当时的会话 leaf 冻结在 pt_runs.previous_leaf_id。
 * 会话分支上每个完成轮恰好贡献一条 assistant 消息（失败轮会回滚到
 * previous_leaf_id，修复轮会重写为单条干净消息），所以：
 *   run 的回答 = 分支上 (previous_leaf_id, 下一个 run 的 previous_leaf_id]
 *   区间内最后一条 assistant 消息。
 * previous_leaf_id 缺失（如概念提升轮 NULL leaf）时退化为确定性顺序映射：
 * 按 run 时序依次分配该区间内尚未绑定的第一条 assistant 消息。
 */

export interface AnswerBindingEntry {
  id: string;
  type: string;
  message?: { role?: string };
}

export interface AnswerBindingRun {
  id: string;
  result?: string | null;
  answer?: string | null;
  previous_leaf_id?: string | null;
}

/**
 * 返回 runId → assistant 条目 id 的映射。纯函数、无副作用，供 selfcheck 回归。
 * @param entries 会话分支条目（根 → 叶顺序）
 * @param runs    按 created_at 升序的 run 行
 */
export function bindAnswerEntries(
  entries: AnswerBindingEntry[],
  runs: AnswerBindingRun[],
): Map<string, string> {
  const position = new Map<string, number>();
  const assistantIndexes: number[] = [];
  entries.forEach((entry, index) => {
    position.set(entry.id, index);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      assistantIndexes.push(index);
    }
  });

  const completed = runs.filter((run) => run.result === "completed" && run.answer);
  const anchored = completed
    .map((run) => position.get(run.previous_leaf_id ?? ""))
    .filter((index): index is number => index !== undefined);

  const bound = new Map<string, string>();
  const boundIndex = new Map<string, number>();
  const used = new Set<number>();
  let floor = -1;

  // 第一遍：有稳定 leaf 锚点的 run，取区间内最后一条 assistant（最终答案）。
  for (const run of completed) {
    const leafIndex = position.get(run.previous_leaf_id ?? "");
    if (leafIndex === undefined) continue;
    const start = Math.max(leafIndex, floor);
    const nextAnchor = anchored.reduce<number>((min, index) => {
      return index > start && index < min ? index : min;
    }, entries.length);
    const candidates = assistantIndexes.filter(
      (index) => index > start && index <= nextAnchor && !used.has(index),
    );
    if (!candidates.length) continue;
    const pick = candidates[candidates.length - 1];
    used.add(pick);
    floor = pick;
    bound.set(run.id, entries[pick].id);
    boundIndex.set(run.id, pick);
  }

  // 第二遍：无锚点 run（如概念提升轮的 NULL leaf）做确定性顺序映射。
  // 不变式：分支上每个完成轮恰好贡献一条 assistant 消息，所以把连续无锚点
  // run 组与区间内【最后 K 条】未绑定 assistant 按序配对，多出的更早消息
  // 属于继承历史，不属于任何 run。
  const groups: AnswerBindingRun[][] = [];
  for (const run of completed) {
    if (bound.has(run.id)) continue;
    const last = groups[groups.length - 1];
    if (last) last.push(run);
    else groups.push([run]);
  }
  for (const group of groups) {
    // 区间下沿只看排在组之前的 run（它们的 leaf 或已绑定条目），
    // 不能被组之后已绑定的 run 提前推进。
    const firstPosition = completed.indexOf(group[0]);
    let start = -1;
    completed.forEach((other, otherPosition) => {
      if (otherPosition >= firstPosition) return;
      const otherBound = boundIndex.get(other.id);
      if (otherBound !== undefined) start = Math.max(start, otherBound);
      const otherLeaf = position.get(other.previous_leaf_id ?? "");
      if (otherLeaf !== undefined) start = Math.max(start, otherLeaf);
    });
    const nextAnchor = anchored.reduce<number>((min, index) => {
      return index > start && index < min ? index : min;
    }, entries.length);
    const candidates = assistantIndexes.filter(
      (index) => index > start && index <= nextAnchor && !used.has(index),
    );
    const picks = candidates.slice(-group.length);
    group.forEach((run, offset) => {
      const pick = picks[offset];
      if (pick === undefined) return;
      used.add(pick);
      bound.set(run.id, entries[pick].id);
      boundIndex.set(run.id, pick);
    });
  }
  return bound;
}
