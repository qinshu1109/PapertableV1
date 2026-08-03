import { useEffect, useId, useRef, useState } from 'react';
import { Code2, Copy, Check, X, Plus, Minus } from 'lucide-react';

type MermaidApi = typeof import('mermaid')['default'];

/** 动态加载并初始化一次 mermaid；严格安全级别，禁 HTML 标签 */
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          background: '#fbf8f2',
          primaryColor: '#f1e9dd',
          primaryTextColor: '#342b26',
          primaryBorderColor: '#c9bcab',
          lineColor: '#8a7a6a',
          secondaryColor: '#ece5da',
          tertiaryColor: '#fbf8f2',
          noteBkgColor: '#f7e3d8',
          noteTextColor: '#342b26',
        },
        fontFamily: 'inherit',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Mermaid 图块：渲染成功显示 SVG，失败回退为源码块 + 错误提示。
 * 单个块的失败不影响同条回答的其他内容。
 */
export function MermaidBlock({ code }: { code: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const boxRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const svgTextRef = useRef<string>('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    loadMermaid()
      .then((mermaid) => mermaid.render(`mmd-${rawId}`, code))
      .then(({ svg }) => {
        if (cancelled) return;
        // mermaid 的样式按 svg id 作用域（#mmd-x .node{...}），把 id 改写成唯一值，
        // 既保住样式匹配，又让 finally 的临时节点清理不会误删已挂载的 SVG
        const scoped = svg.split(`mmd-${rawId}`).join(`mmdv-${rawId}`);
        svgTextRef.current = scoped;
        // Mermaid 的 SVG 会在 foreignObject 中生成 HTML（例如 <br>）；
        // 用 XML 解析会把合法的 HTML void element 误判为未闭合标签。
        const doc = new DOMParser().parseFromString(scoped, 'text/html');
        const el = doc.querySelector('svg');
        if (!el || !boxRef.current) {
          setStatus('error');
          return;
        }
        el.setAttribute('style', 'max-width:100%;height:auto;display:block;margin:0 auto;');
        el.removeAttribute('width');
        boxRef.current.replaceChildren();
        boxRef.current.appendChild(document.importNode(el, true));
        setStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      })
      .finally(() => {
        // mermaid.render 失败时可能残留临时节点
        document.getElementById(`dmmd-${rawId}`)?.remove();
        document.getElementById(`mmd-${rawId}`)?.remove();
      });
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  const copySource = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const sourceBlock = (
    <pre className="md-pre mermaid-source">
      <code>{code}</code>
    </pre>
  );

  return (
    <div className="mermaid-block">
      <div className="mermaid-actions">
        {status === 'ok' && (
          <button
            className="mermaid-btn"
            onClick={() => setShowSource((v) => !v)}
            title={showSource ? '查看图形' : '查看源码'}
          >
            <Code2 size={13} />
            {showSource ? '图形' : '源码'}
          </button>
        )}
        <button className="mermaid-btn" onClick={copySource} title="复制 Mermaid 源码">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          复制
        </button>
      </div>

      {status === 'error' && (
        <>
          <div className="mermaid-error">图形渲染失败，已保留源码</div>
          {sourceBlock}
        </>
      )}
      {status === 'loading' && <div className="mermaid-loading">正在绘制图形…</div>}
      {status === 'ok' && showSource && sourceBlock}
      <div
        ref={boxRef}
        className="mermaid-canvas"
        style={{ display: status === 'ok' && !showSource ? 'block' : 'none' }}
        onClick={() => status === 'ok' && setZoomOpen(true)}
        role="button"
        tabIndex={0}
        aria-label="放大查看图形"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && status === 'ok') setZoomOpen(true);
        }}
      />

      {zoomOpen && <MermaidZoom svg={svgTextRef.current} onClose={() => setZoomOpen(false)} />}
    </div>
  );
}

/** 放大查看：平移 + 缩放，Esc / 点遮罩关闭 */
function MermaidZoom({ svg, onClose }: { svg: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (!stageRef.current) return;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const el = doc.documentElement;
    if (doc.querySelector('parsererror')) return;
    el.setAttribute('style', 'display:block;');
    stageRef.current.replaceChildren();
    stageRef.current.appendChild(document.importNode(el, true));
  }, [svg]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mermaid-zoom-mask" onClick={onClose}>
      <div className="mermaid-zoom" onClick={(e) => e.stopPropagation()}>
        <div className="mermaid-zoom-tools">
          <button className="icon-btn" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} title="缩小">
            <Minus size={14} />
          </button>
          <button className="icon-btn" onClick={() => setZoom((z) => Math.min(3, z + 0.2))} title="放大">
            <Plus size={14} />
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
        <div
          className="mermaid-zoom-viewport"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            setPan({
              x: drag.current.px + (e.clientX - drag.current.x),
              y: drag.current.py + (e.clientY - drag.current.y),
            });
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <div
            ref={stageRef}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' }}
          />
        </div>
      </div>
    </div>
  );
}
