import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationKey } from './i18n';

type Props = {
  token: string | null;
  pending?: boolean;
  t: (key: TranslationKey) => string;
  onOpen: () => void;
};

type State = 'guest' | 'loading' | 'ready' | 'error';

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DashboardWalletCard({ token, pending = false, t, onOpen }: Props) {
  const [balance, setBalance] = useState<number | null>(null);
  const [state, setState] = useState<State>(() => token || pending ? 'loading' : 'guest');
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!token) return;
    const id = ++request.current;
    try {
      const response = await fetch('/api/wallet/balance', { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json().catch(() => ({})) as { balance?: number | null };
      if (id !== request.current) return;
      if (response.ok && typeof data.balance === 'number' && Number.isFinite(data.balance)) {
        setBalance(data.balance);
        setState('ready');
      } else {
        setBalance(null);
        setState('error');
      }
    } catch {
      if (id === request.current) {
        setBalance(null);
        setState('error');
      }
    }
  }, [token]);

  useEffect(() => {
    request.current++;
    if (!token) {
      setBalance(null);
      setState(pending ? 'loading' : 'guest');
      return;
    }
    setState('loading');
    void load();
  }, [token, pending, load]);

  useEffect(() => {
    if (!token) return;
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ balance?: number | null }>).detail;
      if (detail && typeof detail.balance === 'number' && Number.isFinite(detail.balance)) {
        setBalance(detail.balance);
        setState('ready');
      } else {
        void load();
      }
    };
    const refresh = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('direbet:wallet-changed', onChange);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener('direbet:wallet-changed', onChange);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(timer);
    };
  }, [token, load]);

  const amount = state === 'loading' ? '···' : balance === null ? '—' : money.format(balance);
  const label = state === 'ready' && balance !== null
    ? `${t('availableBalance')} ${money.format(balance)} ETB`
    : t('availableBalance');

  return <section className="dash-wallet" data-state={state} aria-label={t('wallet')}>
    <span className="dash-wallet-glow" aria-hidden="true" />
    <div className="dash-wallet-head">
      <span className="dash-wallet-glyph" aria-hidden="true"><WalletGlyph /></span>
      <div className="dash-wallet-meta">
        <span className="dash-wallet-label">{t('availableBalance')}</span>
        <strong className="dash-wallet-amount" aria-label={label} aria-live="polite">{amount}<small>ETB</small></strong>
      </div>
      <span className="dash-wallet-brand" aria-hidden="true">DIRE BET</span>
    </div>
    {state === 'guest' && <p className="dash-wallet-hint">{t('signInToViewBalance')}</p>}
    {state === 'error' && <p className="dash-wallet-hint">{t('balanceUnavailable')}</p>}
    <div className="dash-wallet-actions">
      <button type="button" className="dash-wallet-action deposit" onClick={onOpen}>
        <DepositGlyph />
        <span>{t('depositAction')}</span>
      </button>
      <button type="button" className="dash-wallet-action withdraw" onClick={onOpen}>
        <WithdrawGlyph />
        <span>{t('withdraw')}</span>
      </button>
    </div>
  </section>;
}

function WalletGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path d="M3.2 8.1A2.9 2.9 0 0 1 6.1 5.2h11.4a3.1 3.1 0 0 1 3.1 3.1v8.4a3.1 3.1 0 0 1-3.1 3.1H6.3a3.1 3.1 0 0 1-3.1-3.1V8.1Z" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M3.2 8.6h16.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M15.4 12.7h3.9v2.7h-3.9a1.35 1.35 0 0 1 0-2.7Z" fill="currentColor" opacity=".9"/>
    <path d="M6.1 5.2V4a1.7 1.7 0 0 1 1.7-1.7h8.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>;
}

function DepositGlyph() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
    <path d="M10 2.8v9.1m0 0 3.2-3.2M10 11.9 6.8 8.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3.3 13.2v2.2a1.8 1.8 0 0 0 1.8 1.8h9.8a1.8 1.8 0 0 0 1.8-1.8v-2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>;
}

function WithdrawGlyph() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
    <path d="M10 17.2V8.1m0 0 3.2 3.2M10 8.1 6.8 11.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3.3 6.8V4.6a1.8 1.8 0 0 1 1.8-1.8h9.8a1.8 1.8 0 0 1 1.8 1.8v2.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
  </svg>;
}
