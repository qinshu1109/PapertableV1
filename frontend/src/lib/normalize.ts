/**
 * 模型输出的预规范化与引用标记提取。
 * 纯函数、无副作用，方便单测。
 */

/**
 * 把正文里的 [[source:chunkId]] 标记替换为行内角标 §N，并返回出现顺序。
 * （原 CardStage.extractCitations，行为不变）
 */
export function extractCitations(content: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const text = content.replace(/\s*\[\[source:([^\]]+)\]\]/g, (_m, id: string) => {
    let index = ids.indexOf(id);
    if (index < 0) {
      ids.push(id);
      index = ids.length - 1;
    }
    return ` §${index + 1}`;
  });
  return { text, ids };
}

/**
 * 把正文里的 [[verdict:id]] 判决标注替换为行内小标记 ✦。
 * 复用详情由 RunFooter 的 verdictUse 行展示，正文只留位置记号。
 */
export function extractVerdictMarks(content: string): string {
  return content.replace(/\s*\[\[verdict:[^\]]+\]\]/g, ' ✦');
}

/**
 * 修模型输出的两个常见习惯：
 * 1) `## 标题` 直接接在正文后面（不在行首）——GFM 也要求标题在行首，补空行；
 * 2) 表格行紧跟普通段落——补空行，保证 GFM 表格被识别。
 * 3) 清掉装饰性分隔线：独立成行的 `---`/`--`/`* * *`/`___`（否则会变成 hr
 *    或把上一行变成 setext 标题，与标题样式叠加出多条横线），以及段尾黏连的
 *    孤立 `---`（如 `。---`）。表格分隔行（含 `|`）与代码围栏内部不动。
 */
export function normalizeModelMarkdown(content: string): string {
  // 模型偶尔把 Mermaid 围栏黏在上一句末尾；GFM 只认行首围栏。
  const lines = content
    .replace(/([^\n])(```mermaid[ \t]*\n)/gi, '$1\n\n$2')
    .split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (!inFence) {
      const trimmed = line.trim();

      // 独立成行的装饰性分隔线：整条丢弃（含不合法但会被当成文本显示的 `--`）
      if (/^-{2,}$/.test(trimmed) || /^(\*\s*){3,}$/.test(trimmed) || /^(_\s*){3,}$/.test(trimmed)) {
        continue;
      }

      // 段尾黏连的孤立 ---（含表格行在内的含 `|` 行不动，避免破坏表格分隔行）
      if (!trimmed.includes('|')) {
        line = line.replace(/\s*-{2,}\s*$/, '');
      }

      // 非行首的 ##~###### 标题标记前补空行（单个 # 不动，避免误伤 C#、#1 等）
      line = line.replace(/(\S)(#{2,6})\s+/g, (_m, prev: string, hashes: string) => {
        return `${prev}\n\n${hashes} `;
      });

      // 表格起始行紧跟非空、非表格行时补空行
      const prev = out[out.length - 1];
      if (
        line.trimStart().startsWith('|') &&
        prev !== undefined &&
        prev.trim() !== '' &&
        !prev.trimStart().startsWith('|')
      ) {
        out.push('');
      }
    }

    out.push(line);
  }

  return out.join('\n');
}
