import { useEffect, useState } from 'react';
import { Check, FileJson, FileText, FolderTree, Package, Upload, X } from 'lucide-react';
import { api, type ProviderSettings } from '../lib/api';
import { useStore } from '../store';

const IMPORT_FORMATS = [
  { id: 'md-file', icon: FileText, name: '单个 Markdown 文件', desc: '把一篇笔记作为根卡片导入，标题取自一级标题。' },
  { id: 'md-dir', icon: FolderTree, name: 'Markdown 文件夹', desc: '按目录层级建立卡片关系，双链解析为深挖边。' },
  { id: 'canvas', icon: FileJson, name: 'JSON Canvas', desc: '读取节点与连线，映射为卡片与三种关系边。' },
  { id: 'bundle', icon: Package, name: '本项目的无损项目包', desc: '包含卡片、关系边、引用锚点与阅读位置的完整快照。' },
];

const EXPORT_FORMATS = [
  { id: 'md-dir', icon: FolderTree, name: 'Markdown 文件夹', desc: '每张卡片一个 .md 文件，关系写入 frontmatter。' },
  { id: 'canvas', icon: FileJson, name: 'JSON Canvas + Markdown', desc: '结构写入 .canvas，正文保留为独立 Markdown。' },
  { id: 'bundle', icon: Package, name: '无损项目包', desc: '保留全部字段，可在本工具之间完整往返。' },
];

function Shell({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="overlay" onClick={onClose} role="presentation">
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          {icon}
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body scroll-y">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}

export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (label: string) => void }) {
  const [sel, setSel] = useState('md-dir');
  const chosen = IMPORT_FORMATS.find((f) => f.id === sel)!;
  return (
    <Shell
      title="导入笔记"
      icon={<Upload size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onDone(chosen.name);
              onClose();
            }}
          >
            选择来源并导入
          </button>
        </>
      }
    >
      {IMPORT_FORMATS.map((f) => (
        <button key={f.id} className={`fmt-option${sel === f.id ? ' sel' : ''}`} onClick={() => setSel(f.id)}>
          <span className="fmt-icon">
            <f.icon size={15} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="fmt-name">{f.name}</span>
            <span className="fmt-desc">{f.desc}</span>
          </span>
          {sel === f.id && <Check size={15} color="var(--accent)" style={{ marginTop: 6 }} />}
        </button>
      ))}
      <p className="note-line">
        全部为开放格式，兼容 Obsidian 等使用 Markdown 或 JSON Canvas 的笔记工具。原型中只表现流程与状态，不解析真实文件。
      </p>
    </Shell>
  );
}

export function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: (label: string) => void }) {
  const [sel, setSel] = useState('canvas');
  const [inclRefs, setInclRefs] = useState(true);
  const chosen = EXPORT_FORMATS.find((f) => f.id === sel)!;
  return (
    <Shell
      title="导出项目"
      icon={<Package size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onDone(chosen.name);
              onClose();
            }}
          >
            导出
          </button>
        </>
      }
    >
      {EXPORT_FORMATS.map((f) => (
        <button key={f.id} className={`fmt-option${sel === f.id ? ' sel' : ''}`} onClick={() => setSel(f.id)}>
          <span className="fmt-icon">
            <f.icon size={15} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="fmt-name">{f.name}</span>
            <span className="fmt-desc">{f.desc}</span>
          </span>
          {sel === f.id && <Check size={15} color="var(--accent)" style={{ marginTop: 6 }} />}
        </button>
      ))}
      <label
        style={{
          display: 'flex',
          gap: 9,
          alignItems: 'center',
          fontSize: 12.5,
          color: 'var(--ink-2)',
          marginTop: 4,
          cursor: 'pointer',
        }}
      >
        <input type="checkbox" checked={inclRefs} onChange={(e) => setInclRefs(e.target.checked)} />
        同时导出引用锚点（选区偏移与来源轮次）
      </label>
      <p className="note-line">导出结果为纯文本与目录结构，不依赖本工具即可阅读。原型中不生成真实文件。</p>
    </Shell>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { library, bindLibrary, reindexLibrary } = useStore();
  const [libPath, setLibPath] = useState(library?.path ?? '');
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api.providerSettings()
      .then((settings) => {
        if (!alive) return;
        setProvider(settings);
        setBaseUrl(settings.baseUrl);
        setModel(settings.model);
      })
      .catch((loadError: unknown) => {
        if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.saveProviderSettings({
        protocol: 'anthropic-messages',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell
      title="设置"
      icon={<Check size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={saving || !provider || !baseUrl.trim() || !model.trim()}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存设置'}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
        <div className="fmt-name" style={{ marginBottom: 8 }}>
          云端模型
        </div>
        <label className="settings-field">
          <span>协议</span>
          <input className="tombstone-input" value="Anthropic Messages（原生）" disabled />
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            className="tombstone-input"
            placeholder="https://api.anthropic.com 或兼容网关地址"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>模型 ID</span>
          <input
            className="tombstone-input"
            placeholder="例如 claude-opus-5"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>密钥</span>
          <input
            className="tombstone-input"
            type="password"
            autoComplete="off"
            placeholder={provider?.hasApiKey ? '已保存；留空保持不变' : '输入 API 密钥'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <p className="note-line" style={{ marginBottom: 16 }}>
          密钥只保存在本机后端配置文件中，页面不会读取明文。只使用 Anthropic Messages 原生协议，不回退到 OpenAI 协议。
        </p>
        {error && (
          <p className="note-line settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="fmt-name" style={{ marginBottom: 8 }}>
          只读资料库（当前项目）
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input
            className="tombstone-input"
            placeholder="本地笔记库绝对路径，如 /Users/qinshu/主知识库_AI"
            value={libPath}
            onChange={(e) => setLibPath(e.target.value)}
          />
          <button
            className="btn"
            disabled={!libPath.trim()}
            onClick={() => void bindLibrary(libPath.trim())}
          >
            绑定
          </button>
          <button className="btn" onClick={() => void reindexLibrary()}>
            重建索引
          </button>
        </div>
        <p className="note-line" style={{ marginBottom: 16 }}>
          {library
            ? `已绑定：${library.path} · ${library.documents} 个文档 / ${library.chunks} 个片段${library.indexedAt ? '' : '（尚未索引，请重建索引）'}`
            : '未绑定：回答将因无证据而拒答（sources-only）。绑定后模型只能检索、引用该库。'}
        </p>
      </div>
    </Shell>
  );
}
