/**
 * 镇纸区共享小组件：弹层、金子印章、石碑图、状态徽章。
 */
import { useEffect, type ReactNode } from 'react';
import type { PwBetStatus, PwOutcome } from '../lib/api';

export function PwModal({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="pw-modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="pw-modal" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {sub && <div className="pw-modal-sub">{sub}</div>}
        {children}
      </div>
    </div>
  );
}

export function GoldSeal() {
  return (
    <span className="pw-seal" aria-hidden="true">
      金子
    </span>
  );
}

export function TombFig({ size = 44 }: { size?: number }) {
  return (
    <svg
      className="pw-tomb-fig"
      width={size}
      height={Math.round((size * 52) / 44)}
      viewBox="0 0 44 52"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 6 50 L 6 20 C 6 9, 14 3, 22 3 C 30 3, 38 9, 38 20 L 38 50 Z"
        fill="#99948b"
        opacity="0.28"
      />
      <path
        d="M 6 50 L 6 20 C 6 9, 14 3, 22 3 C 30 3, 38 9, 38 20 L 38 50"
        stroke="#99948b"
        strokeWidth="1.4"
      />
      <path d="M 2 50 L 42 50" stroke="#99948b" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M 15 20 L 29 20 M 18 27 L 26 27"
        stroke="#99948b"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const OUTCOME_META: Record<PwOutcome, { label: string; verb: string }> = {
  gold: { label: '金子', verb: '铸金' },
  tomb: { label: '墓碑', verb: '立碑' },
  void: { label: '作废', verb: '作废' },
};

/** 押注状态徽章；verdictOutcome 用于已结账的卡细分金/碑 */
export function StatusPill({
  status,
  due,
  verdictOutcome,
}: {
  status: PwBetStatus;
  due?: boolean;
  verdictOutcome?: PwOutcome | null;
}) {
  if (status === 'pending') {
    return due ? (
      <span className="pw-st due">
        <i />
        到期未结账
      </span>
    ) : (
      <span className="pw-st live">
        <i />
        验证中
      </span>
    );
  }
  if (status === 'settled' && verdictOutcome === 'gold') {
    return (
      <span className="pw-st gold">
        <i />
        已结账 · 金子
      </span>
    );
  }
  if (status === 'settled' && verdictOutcome === 'tomb') {
    return (
      <span className="pw-st tomb">
        <i />
        已结账 · 墓碑
      </span>
    );
  }
  if (status === 'settled') {
    return (
      <span className="pw-st gold">
        <i />
        已结账
      </span>
    );
  }
  if (status === 'void') {
    return (
      <span className="pw-st void">
        <i />
        已作废
      </span>
    );
  }
  return (
    <span className="pw-st">
      <i />
      草稿
    </span>
  );
}
