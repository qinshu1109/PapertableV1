import { useEffect, useState } from 'react';
import { Check, FileJson, FileText, FolderTree, Package, Trash2, Upload, X } from 'lucide-react';
import { api, type ProviderId, type ProviderSettings } from '../lib/api';
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

export function TrashDialog({ onClose }: { onClose: () => void }) {
  const { cards, restoreCards, purgeCards, showToast } = useStore();
  const trashed = cards.filter((c) => c.trashed);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doPurge = async (ids: string[]) => {
    setBusy(true);
    try {
      await purgeCards(ids);
    } catch (error) {
      showToast({ text: `彻底删除失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  return (
    <Shell
      title={`回收站 · ${trashed.length} 张卡片`}
      icon={<Trash2 size={16} color="var(--ink-2)" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="btn"
            disabled={!trashed.length || busy}
            onClick={() => restoreCards(trashed.map((c) => c.id))}
          >
            全部还原
          </button>
          {confirming === '__all__' ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void doPurge(trashed.map((c) => c.id))}
            >
              确认彻底删除全部？不可恢复
            </button>
          ) : (
            <button
              className="btn"
              disabled={!trashed.length || busy}
              onClick={() => setConfirming('__all__')}
            >
              清空回收站
            </button>
          )}
        </>
      }
    >
      {trashed.length === 0 && (
        <p className="note-line">
          回收站是空的。卡片菜单里的「移入回收站」只是本地隐藏，随时可以从这里还原。
        </p>
      )}
      {trashed.map((card) => (
        <div
          key={card.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 0',
            borderBottom: '1px solid var(--line, rgba(0,0,0,0.06))',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {card.title}
          </span>
          <button className="btn" disabled={busy} onClick={() => restoreCards([card.id])}>
            还原
          </button>
          {confirming === card.id ? (
            <button className="btn primary" disabled={busy} onClick={() => void doPurge([card.id])}>
              确认删除？
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setConfirming(card.id)}>
              彻底删除
            </button>
          )}
        </div>
      ))}
      {trashed.length > 0 && (
        <p className="note-line">
          还原只取消本地隐藏；彻底删除会物理删除卡片及其回答与关系，且不可恢复。被金子或墓碑引用的卡片不能彻底删除。
        </p>
      )}
    </Shell>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { library, bindLibrary, reindexLibrary } = useStore();
  const [libPath, setLibPath] = useState(library?.path ?? '');
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>('claude');
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
        const active = settings.providers.find((item) => item.id === settings.activeProviderId)!;
        setProvider(settings);
        setSelectedProviderId(active.id);
        setBaseUrl(active.baseUrl);
        setModel(active.model);
      })
      .catch((loadError: unknown) => {
        if (alive) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => {
      alive = false;
    };
  }, []);

  const selectedProvider = provider?.providers.find((item) => item.id === selectedProviderId);
  const selectProvider = (id: ProviderId) => {
    const selected = provider?.providers.find((item) => item.id === id);
    if (!selected) return;
    setSelectedProviderId(id);
    setBaseUrl(selected.baseUrl);
    setModel(selected.model);
    setApiKey('');
    setError('');
  };

  const save = async () => {
    if (!selectedProvider) return;
    setSaving(true);
    setError('');
    try {
      await api.saveProviderSettings({
        providerId: selectedProviderId,
        protocol: selectedProvider.protocol,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      window.dispatchEvent(new Event('papertable-provider-changed'));
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
            disabled={
              saving
              || !selectedProvider
              || !baseUrl.trim()
              || !model.trim()
              || (!selectedProvider.hasApiKey && !apiKey.trim())
            }
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存并使用'}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
        <div className="fmt-name" style={{ marginBottom: 8 }}>
          云端模型
        </div>
        <label className="settings-field">
          <span>供应商</span>
          <select
            className="tombstone-input"
            value={selectedProviderId}
            onChange={(event) => selectProvider(event.target.value as ProviderId)}
          >
            {provider?.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}{item.id === provider.activeProviderId ? '（当前）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>协议</span>
          <input
            className="tombstone-input"
            value={selectedProvider?.protocol === 'openai-completions'
              ? 'OpenAI Chat Completions'
              : 'Anthropic Messages（原生）'}
            disabled
          />
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
            placeholder={selectedProvider?.hasApiKey ? '已保存；留空保持不变' : '输入该供应商的 API 密钥'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <p className="note-line" style={{ marginBottom: 16 }}>
          三个供应商和密钥独立保留；选择后“保存并使用”才会切换。密钥只保存在本机后端配置文件中，页面不会读取明文。
        </p>
        {error && (
          <p className="note-line settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="fmt-name" style={{ marginBottom: 8 }}>
          长期资料库（新项目默认继承）
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
            ? `已绑定并作为新项目默认库：${library.path} · ${library.documents} 个文档 / ${library.chunks} 个片段${library.indexedAt ? '' : '（尚未索引，请重建索引）'}`
            : '尚无默认资料库：回答将因无证据而拒答（sources-only）。首次绑定并索引后，新项目会自动继承；临时材料不会跨项目。'}
        </p>
      </div>
    </Shell>
  );
}
