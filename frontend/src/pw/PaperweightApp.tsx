/**
 * 镇纸 Paperweight 区域壳：顶部导航（首页 / 押注台 / 金子墓碑库 / 协作台 /
 * 观众声音 / 数据源 / 大盘 / 笔记）+ 八屏切换。
 * TASK-PW-41：第七屏「笔记」开通（Memos 只读：热力图/列表/标签树/相关旧笔记）。
 * TASK-PW-47：第八屏「观众声音」开通（声音列表提请候选 + 语料评论只读分区一键收录）。
 */
import { useCallback, useState } from 'react';
import { pwApi } from '../lib/api';
import { useAsync } from './hooks';
import { Home } from './Home';
import { Workbench } from './Workbench';
import { Vault } from './Vault';
import { Collab } from './Collab';
import { Dashboard } from './Dashboard';
import { Sources } from './Sources';
import { Notes } from './Notes';
import { Voice } from './Voice';
import { Ops } from './Ops';
import './pw.css';

export type PwScreen = 'home' | 'workbench' | 'vault' | 'collab' | 'voice' | 'sources' | 'dashboard' | 'notes' | 'ops';

const NAV: Array<{ id: PwScreen; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'workbench', label: '押注台' },
  { id: 'vault', label: '金子墓碑库' },
  { id: 'collab', label: '协作台' },
  { id: 'voice', label: '观众声音' },
  { id: 'ops', label: '运维' },
];

export function PaperweightApp({ onGoExplore }: { onGoExplore: () => void }) {
  const [screen, setScreen] = useState<PwScreen>('home');
  // epoch：任一屏发生写操作后递增，顶栏徽章与其它屏随之重取
  const [epoch, setEpoch] = useState(0);
  const changed = useCallback(() => setEpoch((e) => e + 1), []);

  const betsState = useAsync(() => pwApi.listBets(), [epoch]);
  const dueState = useAsync(() => pwApi.dueBets(), [epoch]);
  const liveCount = (betsState.data?.bets ?? []).filter((b) => b.status === 'pending').length;
  const dueCount = dueState.data?.bets.length ?? 0;

  return (
    <div className="pw">
      <header className="pw-topbar">
        <div className="pw-brand">
          <span className="pw-brand-mark" aria-hidden="true" />
          镇纸 Paperweight
        </div>
        <nav className="pw-nav" aria-label="镇纸导航">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={screen === n.id ? 'on' : ''}
              aria-current={screen === n.id ? 'page' : undefined}
              onClick={() => setScreen(n.id)}
            >
              {n.label}
            </button>
          ))}
          <button
            type="button"
            className={screen === 'sources' ? 'on' : ''}
            aria-current={screen === 'sources' ? 'page' : undefined}
            onClick={() => setScreen('sources')}
          >
            数据源
          </button>
          <button
            type="button"
            className={screen === 'dashboard' ? 'on' : ''}
            aria-current={screen === 'dashboard' ? 'page' : undefined}
            onClick={() => setScreen('dashboard')}
          >
            大盘
          </button>
          <button
            type="button"
            className={screen === 'notes' ? 'on' : ''}
            aria-current={screen === 'notes' ? 'page' : undefined}
            onClick={() => setScreen('notes')}
          >
            笔记
          </button>
        </nav>
        <span className="pw-top-badge">
          <span className={`dot${dueCount > 0 ? ' due' : ''}`} aria-hidden="true" />
          押注中 {liveCount} 注{dueCount > 0 ? ` · ${dueCount} 注到期` : ''}
        </span>
      </header>
      {screen === 'home' && <Home epoch={epoch} onNav={(s) => setScreen(s)} />}
      {screen === 'workbench' && (
        <Workbench epoch={epoch} onChanged={changed} onGoExplore={onGoExplore} onNav={(s) => setScreen(s)} />
      )}
      {screen === 'vault' && <Vault epoch={epoch} onChanged={changed} />}
      {screen === 'collab' && <Collab epoch={epoch} onChanged={changed} onNav={(s) => setScreen(s)} />}
      {screen === 'voice' && <Voice epoch={epoch} onChanged={changed} />}
      {screen === 'sources' && (
        <Sources epoch={epoch} onChanged={changed} onNav={(s) => setScreen(s)} />
      )}
      {screen === 'dashboard' && <Dashboard epoch={epoch} />}
      {screen === 'notes' && <Notes epoch={epoch} />}
      {screen === 'ops' && <Ops epoch={epoch} onChanged={changed} />}
    </div>
  );
}
