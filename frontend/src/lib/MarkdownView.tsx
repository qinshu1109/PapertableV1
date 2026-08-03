import React, { memo, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { extractCitations, extractVerdictMarks, normalizeModelMarkdown } from './normalize';
import { MermaidBlock } from './MermaidBlock';

interface Props {
  content: string;
  concepts?: string[];
  /** 已打开临时卡的词：实心高亮；未打开的词只显示底部虚线 */
  activeConcepts?: string[];
  onConcept?: (term: string, blockText: string, el: HTMLElement) => void;
  /** 点击行内引用角标 §N */
  onCite?: (n: number) => void;
}

/** 递归把字符串子节点拍平成纯文本（onConcept 的 blockText 用） */
function flattenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((c) => {
      if (typeof c === 'string') return c;
      if (React.isValidElement(c)) return flattenText((c.props as { children?: React.ReactNode }).children);
      return '';
    })
    .join('');
}

export const MarkdownView = memo(function MarkdownView({ content, concepts = [], activeConcepts = [], onConcept, onCite }: Props) {
  const md = useMemo(() => {
    const cited = extractCitations(content);
    return normalizeModelMarkdown(extractVerdictMarks(cited.text));
  }, [content]);

  const conceptRe = useMemo(() => {
    if (!concepts.length || !onConcept) return null;
    const escaped = concepts
      .filter(Boolean)
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    return new RegExp(`(${escaped.join('|')})`, 'g');
  }, [concepts, onConcept]);

  /** 字符串 → 引用角标 / 概念词 / 普通文本 混合节点 */
  const renderString = (text: string, blockText: string, keyPrefix: string): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    // 先切引用角标 §N
    text.split(/(§\d+)/g).forEach((seg, i) => {
      if (!seg) return;
      const citeMatch = seg.match(/^§(\d+)$/);
      if (citeMatch) {
        const n = Number(citeMatch[1]);
        out.push(
          <button
            type="button"
            key={`${keyPrefix}-s${i}`}
            className="cite-ref"
            aria-label={`引用 ${n}，查看来源内容`}
            onClick={() => onCite?.(n)}
          >
            {n}
          </button>,
        );
        return;
      }
      if (!conceptRe) {
        out.push(<React.Fragment key={`${keyPrefix}-t${i}`}>{seg}</React.Fragment>);
        return;
      }
      // 再切概念词
      seg.split(conceptRe).forEach((p, j) => {
        if (!p) return;
        if (concepts.includes(p)) {
          out.push(
            <button
              type="button"
              className={`concept-term${activeConcepts.includes(p) ? ' is-open' : ''}`}
              key={`${keyPrefix}-k${i}-${j}`}
              onClick={(e) => onConcept!(p, blockText, e.currentTarget)}
              title={`查看「${p}」的概念解释`}
            >
              {p}
            </button>,
          );
        } else {
          out.push(<React.Fragment key={`${keyPrefix}-p${i}-${j}`}>{p}</React.Fragment>);
        }
      });
    });
    return out;
  };

  /** 递归处理子节点：字符串做角标/概念替换，行内 code 原样跳过 */
  const renderInline = (children: React.ReactNode, keyPrefix: string, blockText: string): React.ReactNode =>
    React.Children.map(children, (child, i) => {
      const key = `${keyPrefix}-${i}`;
      if (typeof child === 'string') return renderString(child, blockText, key);
      if (React.isValidElement(child)) {
        const props = child.props as { children?: React.ReactNode; className?: string };
        // 行内代码不处理概念词/角标（保持旧解析器行为）
        if (child.type === 'code' || (typeof props.className === 'string' && props.className.includes('language-'))) {
          return child;
        }
        return React.cloneElement(child, { key: child.key ?? key } as object, renderInline(props.children, key, blockText));
      }
      return child;
    });

  const components = useMemo(
    () => ({
      h1: ({ children }: { children?: React.ReactNode }) => (
        <h2 className="md-h2">{renderInline(children, 'h1', flattenText(children))}</h2>
      ),
      h2: ({ children }: { children?: React.ReactNode }) => (
        <h2 className="md-h2">{renderInline(children, 'h2', flattenText(children))}</h2>
      ),
      h3: ({ children }: { children?: React.ReactNode }) => (
        <h3 className="md-h3">{renderInline(children, 'h3', flattenText(children))}</h3>
      ),
      h4: ({ children }: { children?: React.ReactNode }) => (
        <h4 className="md-h4">{renderInline(children, 'h4', flattenText(children))}</h4>
      ),
      h5: ({ children }: { children?: React.ReactNode }) => (
        <h4 className="md-h4">{renderInline(children, 'h5', flattenText(children))}</h4>
      ),
      h6: ({ children }: { children?: React.ReactNode }) => (
        <h4 className="md-h4">{renderInline(children, 'h6', flattenText(children))}</h4>
      ),
      p: ({ children }: { children?: React.ReactNode }) => (
        <p className="md-p">{renderInline(children, 'p', flattenText(children))}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{renderInline(children, 'li', flattenText(children))}</li>
      ),
      blockquote: ({ children }: { children?: React.ReactNode }) => (
        <blockquote className="md-quote">{renderInline(children, 'q', flattenText(children))}</blockquote>
      ),
      ul: ({ children }: { children?: React.ReactNode }) => <ul className="md-ul">{children}</ul>,
      ol: ({ children }: { children?: React.ReactNode }) => <ol className="md-ol">{children}</ol>,
      td: ({ children }: { children?: React.ReactNode }) => (
        <td>{renderInline(children, 'td', flattenText(children))}</td>
      ),
      th: ({ children }: { children?: React.ReactNode }) => (
        <th>{renderInline(children, 'th', flattenText(children))}</th>
      ),
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
        <a className="md-link" href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ),
      pre: ({ children }: { children?: React.ReactNode }) => {
        const child = React.Children.toArray(children)[0];
        const className = React.isValidElement(child) ? (child.props as { className?: string }).className : undefined;
        return className === 'language-mermaid' ? children : <pre className="md-pre">{children}</pre>;
      },
      code: (props: { className?: string; children?: React.ReactNode; node?: { position?: { start: { offset?: number }; end: { offset?: number } } } }) => {
        const { className, children, node } = props;
        if (className === 'language-mermaid') {
          // 围栏未闭合（流式中间态）时按普通代码块展示
          const pos = node?.position;
          const raw =
            pos?.start.offset !== undefined && pos?.end.offset !== undefined
              ? md.slice(pos.start.offset, pos.end.offset)
              : '';
          const closed = raw
            .split('\n')
            .slice(1)
            .some((l) => l.trimStart().startsWith('```'));
          if (closed) return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
          return <code className="md-code-block">{children}</code>;
        }
        if (className?.startsWith('language-')) return <code>{children}</code>;
        return <code className="md-code">{children}</code>;
      },
      table: (props: { children?: React.ReactNode; node?: { position?: { start: { offset?: number }; end: { offset?: number } } } }) => {
        const { children, node } = props;
        const pos = node?.position;
        const source =
          pos?.start.offset !== undefined && pos?.end.offset !== undefined
            ? md.slice(pos.start.offset, pos.end.offset)
            : '';
        return <TableShell source={source}>{children}</TableShell>;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [md, conceptRe, activeConcepts, onCite, onConcept],
  );

  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{md}</ReactMarkdown>;
});

/** 表格外壳：卡片内横滑 + 限高纵滚 + 复制 Markdown 源码 */
function TableShell({ source, children }: { source: string; children?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };
  return (
    <div className="md-table-wrap">
      <button className="md-table-copy" onClick={copy} title="复制表格 Markdown 源码">
        {copied ? <Check size={12} /> : <Copy size={12} />}
        复制
      </button>
      <table className="md-table">{children}</table>
    </div>
  );
}
