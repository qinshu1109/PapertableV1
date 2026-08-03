/**
 * run ↔ AI 轮次的前端绑定。
 *
 * 历史 bug：旧实现用 `turn.content === run.answer` 严格相等匹配。会话 assistant
 * 文本经过 sanitize 二次组装（可能多出 `---` 等差异），与 run.answer 不保证逐字
 * 相等，匹配失败导致 runId / citations / concepts / activity 全部丢失，关键词
 * 高亮整体失效。绑定只允许使用稳定标识或确定性顺序，禁止任何正文文本比较。
 *
 * 主路径：后端 cardDetail 已为每个完成轮算出 answerEntryId（基于
 * pt_runs.previous_leaf_id 的会话分支定位），前端按 entryId 精确绑定。
 * 回退：answerEntryId 缺失（旧数据）时，按 run 时序把未绑定的完成轮依次映射到
 * 尚未绑定的 AI 轮——会话分支上每个完成轮恰好贡献一条 assistant 消息（失败轮
 * 已回滚），所以顺序映射是确定性且可证明正确的。
 */

export interface BindableTurn {
  entryId?: string;
  role: 'user' | 'ai';
  runId?: string;
}

export interface BindableRun {
  id: string;
  result: string | null;
  answer: string | null;
  answerEntryId?: string | null;
}

/** 返回 runId → turn 下标的映射。纯函数、无副作用，供 selfcheck 回归。 */
export function bindRunsToTurns(
  turns: BindableTurn[],
  runs: BindableRun[],
): Map<string, number> {
  const bound = new Map<string, number>();
  const usedTurns = new Set<number>();
  const completed = runs.filter((run) => run.result === 'completed' && run.answer);

  // 第一遍：稳定 entryId 绑定。
  for (const run of completed) {
    if (!run.answerEntryId) continue;
    const index = turns.findIndex(
      (turn, i) =>
        turn.role === 'ai' &&
        turn.entryId === run.answerEntryId &&
        !usedTurns.has(i) &&
        !turn.runId,
    );
    if (index < 0) continue;
    usedTurns.add(index);
    bound.set(run.id, index);
  }

  // 第二遍：answerEntryId 缺失的完成轮做确定性顺序映射。
  // 不变式：会话分支上每个完成轮恰好贡献一条 assistant 消息（失败轮已回滚）。
  // 因此把连续未绑定 run 组与夹区间内【最后 K 条】未绑定 AI 轮按序配对——
  // 区间里多出来的更早 AI 轮属于改道继承的历史，不属于任何 run。
  const groups: BindableRun[][] = [];
  for (const run of completed) {
    if (bound.has(run.id)) continue;
    const last = groups[groups.length - 1];
    if (last) last.push(run);
    else groups.push([run]);
  }
  for (const group of groups) {
    const firstPosition = completed.indexOf(group[0]);
    let floor = -1;
    let ceiling = turns.length;
    completed.forEach((other, otherPosition) => {
      const turnIndex = bound.get(other.id);
      if (turnIndex === undefined) return;
      if (otherPosition < firstPosition) floor = Math.max(floor, turnIndex);
      else ceiling = Math.min(ceiling, turnIndex);
    });
    const candidates: number[] = [];
    for (let i = floor + 1; i < ceiling; i += 1) {
      if (turns[i].role !== 'ai' || usedTurns.has(i) || turns[i].runId) continue;
      candidates.push(i);
    }
    const picks = candidates.slice(-group.length);
    group.forEach((run, offset) => {
      const turnIndex = picks[offset];
      if (turnIndex === undefined) return;
      usedTurns.add(turnIndex);
      bound.set(run.id, turnIndex);
    });
  }

  return bound;
}
