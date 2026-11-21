import { useCallback, useEffect, useRef, useState } from 'react';

type Props = {
  token: string | null;
  pending?: boolean;
  onOpen: () => void;
};

type State = 'guest' | 'loading' | 'ready' | 'error';

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactMoney = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export default function WalletBalancePill({ token, pending = false, onOpen }: Props) {
  const [balance, setBalance] = useState<number | null>(null);
  const [state, setState] = useState<State>(() => token || pending ? 'loading' : 'guest');
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 380px)').matches);
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
    const query = window.matchMedia('(max-width: 380px)');
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

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

  const amount = balance === null ? '—' : compact && balance >= 100_000 ? compactMoney.format(balance) : money.format(balance);
  const label = state === 'ready' && balance !== null
    ? `Wallet balance ${money.format(balance)} ETB. Open wallet.`
    : state === 'loading'
      ? 'Wallet balance loading. Open wallet.'
      : state === 'error'
        ? 'Wallet balance unavailable. Open wallet.'
        : 'Sign in to view your wallet balance. Open wallet.';

  return <button type="button" className="navbar-wallet" data-state={state} onClick={onOpen} aria-label={label} title={label}>
    <WalletGlyph/>
    <span className="navbar-wallet-label">ETB</span>
    <strong className={`navbar-wallet-amount ${state === 'loading' ? 'is-loading' : ''}`}>{state === 'loading' ? '···' : amount}</strong>
    {state === 'error' && <span className="navbar-wallet-error" aria-hidden="true">!</span>}
  </button>;
}

function WalletGlyph() {
  return <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <rect x="2.2" y="4.8" width="15.6" height="11.4" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M2.4 8.1h15.2" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M12.7 11.5h3.2v2.2h-3.2a1.1 1.1 0 0 1 0-2.2Z" fill="currentColor" opacity=".9"/>
    <path d="M5.2 4.8V3.9a1.4 1.4 0 0 1 1.4-1.4h7.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>;
}
