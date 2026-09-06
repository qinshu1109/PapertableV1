/**
 * TASK-PW-57：镜像金子行内格式派生（纯函数、无依赖）。
 * 真实同步文本是单行 markdown，标题记号（#/##/###）全在行内，
 * 派生前先 normalizeHeadings 把行内标题归一化为行首标题。
 */

const ATX_HEADING_RE = /^#{1,6}\s+(.*)$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const QUOTE_RE = /^>\s?/;
const LIST_RE = /^(?:[-*+]\s+|\d+[.)]\s+)/;

/** 把「空白 + 1~6 个 # + 空白」替换为「换行 + 这串 # + 单个空格」，
 *  让行内标题变成真行首标题；# 前无空白（如 C#）不匹配，不得误伤。 */
export function normalizeHeadings(text: string): string {
  return text.replace(/(^|\s)(#{1,6})\s/g, "\n$2 ");
}

/** 归一化后的 markdown 全文（供前端展开区渲染；text 原文仍原样返回，
 *  AI 装配与检索不受影响）。 */
export function goldBody(text: string): string {
  return normalizeHeadings(text);
}

/** 剥掉 markdown 排版符号：标题/引用/列表前导、粗斜体、行内代码、
 *  代码围栏行、链接留文字、图片留 alt；连续空白折叠为单个空格。 */
export function stripMd(text: string): string {
  return normalizeHeadings(text)
    .split("\n")
    .map((line) => {
      const t = line.trim();
      // 代码围栏行（``` / ~~~ 开合行）整行剥掉，围栏内内容作为正文保留
      if (FENCE_RE.test(t)) return "";
      let out = t.replace(QUOTE_RE, "");
      out = out.replace(ATX_HEADING_RE, "$1");
      out = out.replace(LIST_RE, "");
      // 图片 `![alt](url)` 留 alt；链接 `[文字](url)` 留文字
      out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
      out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      // 行内代码反引号
      out = out.replace(/`([^`]*)`/g, "$1");
      // 粗/斜体标记（先双后单，避免 `**` 被 `*` 规则吃掉一半）
      out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
      out = out.replace(/__([^_]+)__/g, "$1");
      out = out.replace(/\*([^*]+)\*/g, "$1");
      out = out.replace(/(^|[^\w])_([^_]+)_([^\w]|$)/g, "$1$2$3");
      return out;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 取第一个 ATX 标题的文本（剥 `#`）；没有标题就取第一个非空行。
 *  标题短语与正文粘连（如 `## 标题 正文…` 整条是一个标题行）时，
 *  在第一个位置 ≥4 的空白字符处切断，只留标题短语（防太短误切，如 `How to`）；
 *  超过 40 字直接切（不补省略号）。 */
export function goldTitle(text: string): string {
  const normalized = normalizeHeadings(text);
  let title = "";
  let fromHeading = false;
  for (const line of normalized.split("\n")) {
    const m = line.trim().match(ATX_HEADING_RE);
    if (m) {
      title = m[1];
      fromHeading = true;
      break;
    }
  }
  if (!fromHeading) {
    for (const line of normalized.split("\n")) {
      const t = line.trim();
      if (t) {
        title = t;
        break;
      }
    }
  } else {
    const firstSpace = title.search(/\s/);
    if (firstSpace >= 4) title = title.slice(0, firstSpace);
  }
  return stripMd(title).slice(0, 40);
}

/** 剥掉第一个 ATX 标题的标题短语部分（同 goldTitle 的切断规则）；
 *  标题行粘连的正文剩余部分保留并进摘要最前面，再与其余行一起 stripMd，
 *  取前 120 字；正文为空时返回空串。 */
export function goldSummary(text: string): string {
  const lines = normalizeHeadings(text).split("\n");
  let consumed = false;
  const rest = lines.flatMap((line) => {
    if (consumed) return [line];
    const m = line.trim().match(ATX_HEADING_RE);
    if (!m) return [line];
    consumed = true;
    const headingText = m[1];
    const firstSpace = headingText.search(/\s/);
    if (firstSpace < 4) return [];
    const remainder = headingText.slice(firstSpace).trimStart();
    return remainder ? [remainder] : [];
  });
  return stripMd(rest.join("\n")).slice(0, 120);
}
