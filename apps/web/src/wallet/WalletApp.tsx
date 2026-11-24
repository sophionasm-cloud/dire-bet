import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { TranslationKey } from '../i18n';

type ProviderId = 'telebirr' | 'ebirr';
type Provider = {
  provider: ProviderId; accountLabel: string; accountNumber: string; enabled: boolean;
  minimumAmount: number; maximumAmount: number; withdrawalMinimumAmount?: number; withdrawalMaximumAmount?: number;
};
type WalletRequest = { id: string; provider: ProviderId; amount: number; status: string; created_at: string; review_reason: string | null; provider_reference?: string | null; reviewed_at?: string | null };
type RequestData = { deposits: WalletRequest[]; withdrawals: WalletRequest[]; lastWithdrawalPhone?: string | null };
type Props = { t: (key: TranslationKey) => string; token: string | null; initialView?: 'deposit'; onInitialViewConsumed?: () => void; onSupport: () => void };
type View = 'main' | 'deposit' | 'withdraw' | 'submitted';

const providerLabel: Record<ProviderId, string> = { telebirr: 'Telebirr', ebirr: 'eBirr' };
const lastPhoneKey = 'dire-bet-last-withdrawal-phone';

function ProviderMark({ provider }: { provider: ProviderId }) {
  return <span className={`wallet-provider-mark ${provider}`} aria-hidden="true">{provider === 'telebirr' ? 'T' : 'e'}</span>;
}

function WalletIcon({ name }: { name: 'wallet' | 'deposit' | 'withdraw' | 'copy' | 'back' }) {
  const common = { width: 23, height: 23, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths = {
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h2"/><path d="M6 5V3h12v2"/></>,
    deposit: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M5 14v5h14v-5"/></>,
    withdraw: <><path d="M12 8v12m0 0 5-5m-5 5-5-5"/><path d="M5 10V5h14v5"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    back: <><path d="m14 5-7 7 7 7M7 12h13"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function normalizeEthiopianPhone(value: string): string | null {
  const digits = value.trim().replace(/[^\d+]/g, '');
  if (/^\+251[79]\d{8}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^251[79]\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^0[79]\d{8}$/.test(digits)) return digits;
  return null;
}

function readSavedPhone(): string {
  try { return localStorage.getItem(lastPhoneKey) || ''; } catch { return ''; }
}

function savePhone(value: string) {
  try { localStorage.setItem(lastPhoneKey, value); } catch { /* The next request can still use the typed number. */ }
}

export default function WalletApp({ t, token, initialView, onInitialViewConsumed, onSupport }: Props) {
  const [view, setView] = useState<View>('main');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [requests, setRequests] = useState<RequestData>({ deposits: [], withdrawals: [] });
  const [balance, setBalance] = useState<number | null>(null);
  const [moneyEnabled, setMoneyEnabled] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [depositSms, setDepositSms] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawPhone, setWithdrawPhone] = useState('');
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoMessage, setPromoMessage] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const copyTimer = useRef<number | null>(null);
  const initialViewHandled = useRef(false);

  const selectedProvider = providers.find((item) => item.provider === provider && item.enabled) || null;
  const depositMinimum = selectedProvider?.minimumAmount ?? 50;
  const depositMaximum = selectedProvider?.maximumAmount ?? 10_000;
  const withdrawalMinimum = selectedProvider?.withdrawalMinimumAmount ?? 100;
  const withdrawalMaximum = selectedProvider?.withdrawalMaximumAmount ?? 10_000;
  const depositAmountNumber = Number(depositAmount);
  const withdrawAmountNumber = Number(withdrawAmount);
  const depositAmountValid = depositAmount !== '' && Number.isSafeInteger(depositAmountNumber) && depositAmountNumber >= depositMinimum && depositAmountNumber <= depositMaximum;
  const withdrawAmountValid = withdrawAmount !== '' && Number.isSafeInteger(withdrawAmountNumber) && withdrawAmountNumber >= withdrawalMinimum && withdrawAmountNumber <= withdrawalMaximum && (balance === null || withdrawAmountNumber <= balance);
  const normalizedPhone = normalizeEthiopianPhone(withdrawPhone);
  const depositValid = Boolean(token && selectedProvider?.accountNumber && depositAmountValid && depositSms.trim().length >= 8);
  const withdrawValid = Boolean(token && selectedProvider && withdrawAmountValid && normalizedPhone);

  const refresh = useCallback(async () => {
    const settingResponse = await fetch('/api/wallet/settings').catch(() => null);
    if (settingResponse?.ok) {
      const data = await settingResponse.json() as { providers?: Provider[] };
      setProviders(data.providers || []);
    }
    if (!token) { setRequests({ deposits: [], withdrawals: [] }); setBalance(null); setWalletError(t('walletSignInHistory')); return; }
    const [requestResponse, balanceResponse] = await Promise.all([
      fetch('/api/wallet/requests', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
      fetch('/api/wallet/balance', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
    ]);
    if (requestResponse?.ok) setRequests(await requestResponse.json() as RequestData);
    const data = balanceResponse ? await balanceResponse.json().catch(() => ({})) as { balance?: number; enabled?: boolean; error?: string } : {};
    setMoneyEnabled(data.enabled === true);
    setWalletError(balanceResponse?.ok ? '' : data.error || t('walletRequestFailed'));
    const nextBalance = balanceResponse?.ok && Number.isFinite(data.balance) ? data.balance as number : null;
    setBalance(nextBalance);
    window.dispatchEvent(new CustomEvent('direbet:wallet-changed', { detail: { balance: nextBalance } }));
  }, [token, t]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (view !== 'submitted') return;
    const timer = window.setTimeout(() => { setView('main'); void refresh(); }, 2400);
    return () => window.clearTimeout(timer);
  }, [view, refresh]);

  useEffect(() => () => { if (copyTimer.current) window.clearTimeout(copyTimer.current); }, []);

  const firstEnabledProvider = (): ProviderId => providers.find((item) => item.provider === 'telebirr' && item.enabled)?.provider || providers.find((item) => item.enabled)?.provider || 'telebirr';

  const openDeposit = () => {
    if (!token || !moneyEnabled) { setMessage(walletError || t('walletRequestFailed')); return; }
    setView('deposit'); setMessage(''); setProvider(firstEnabledProvider()); setDepositAmount(''); setDepositSms('');
  };

  useEffect(() => {
    if (initialView !== 'deposit' || initialViewHandled.current || view !== 'main' || !token || !moneyEnabled) return;
    initialViewHandled.current = true;
    setView('deposit'); setMessage('');
    setProvider(providers.find((item) => item.provider === 'telebirr' && item.enabled)?.provider || providers.find((item) => item.enabled)?.provider || 'telebirr');
    setDepositAmount(''); setDepositSms('');
    onInitialViewConsumed?.();
  }, [initialView, view, token, moneyEnabled, providers, onInitialViewConsumed]);

  const openWithdrawal = () => {
    if (!token || !moneyEnabled) { setMessage(walletError || t('walletRequestFailed')); return; }
    setView('withdraw'); setMessage(''); setProvider(firstEnabledProvider()); setWithdrawAmount('');
    setWithdrawPhone(requests.lastWithdrawalPhone || readSavedPhone());
  };

  const backToMain = () => { setView('main'); setMessage(''); void refresh(); };

  const copyAccount = async () => {
    if (!selectedProvider?.accountNumber) return;
    try {
      await navigator.clipboard.writeText(selectedProvider.accountNumber);
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch { setMessage(t('walletCopyFailed')); }
  };

  const submitDeposit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!token || !selectedProvider || !depositValid) { setMessage(t('walletRequestFailed')); return; }
    submitting.current = true; setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/wallet/deposits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider.provider,
          amount: depositAmountNumber,
          confirmationSms: depositSms.trim(),
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const data = await response.json().catch(() => ({})) as { requestId?: string; error?: string };
      if (!response.ok || !data.requestId) {
        if (response.status === 409) throw new Error(/sms/i.test(data.error || '') ? t('walletDuplicateSms') : t('walletDuplicateReference'));
        throw new Error(data.error || t('walletRequestFailed'));
      }
      idempotencyKey.current = crypto.randomUUID();
      setView('submitted');
      setDepositAmount(''); setDepositSms('');
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('walletRequestFailed')); }
    finally { submitting.current = false; setBusy(false); }
  };

  const submitWithdrawal = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!token || !selectedProvider || !withdrawValid || !normalizedPhone) { setMessage(t('walletInvalidPhone')); return; }
    submitting.current = true; setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/wallet/withdrawals', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider.provider,
          amount: withdrawAmountNumber,
          destinationPhone: normalizedPhone,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const data = await response.json().catch(() => ({})) as { requestId?: string; error?: string };
      if (!response.ok || !data.requestId) throw new Error(data.error || t('walletRequestFailed'));
      idempotencyKey.current = crypto.randomUUID();
      savePhone(normalizedPhone);
      setView('submitted');
      setWithdrawAmount('');
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('walletRequestFailed')); }
    finally { submitting.current = false; setBusy(false); }
  };

  const applyPromoCode = async (event: FormEvent) => {
    event.preventDefault(); setPromoMessage('');
    if (!token) { setPromoMessage(t('walletPromoSignIn')); return; }
    try {
      const response = await fetch('/api/referrals/claim', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: promoCode }) });
      const data = await response.json() as { error?: string; bonusStatus?: 'credited' | 'pending_age' | 'withheld'; walletEnabled?: boolean };
      if (!response.ok) throw new Error(data.error || 'That promo code could not be applied.');
      setPromoMessage(data.bonusStatus === 'credited' ? data.walletEnabled ? t('walletPromoCredited') : t('walletPromoRecorded') : data.bonusStatus === 'withheld' ? t('walletPromoWithheld') : t('walletPromoPending')); setPromoCode('');
      if (data.bonusStatus === 'credited') void refresh();
    } catch (cause) { setPromoMessage(cause instanceof Error ? cause.message : 'That promo code could not be applied.'); }
  };

  const statusCopy = (status: string): string => {
    if (status === 'pending') return t('walletStatusPending');
    if (status === 'needs_info') return t('walletStatusNeedsInfo');
    if (status === 'approved') return t('walletStatusApproved');
    if (status === 'rejected') return t('walletStatusRejected');
    if (status === 'reviewing') return t('walletStatusReviewing');
    if (status === 'paid') return t('walletStatusPaid');
    return status;
  };

  if (view === 'submitted') return <section className="screen wallet-screen wallet-flow-screen wallet-success-screen">
    <div className="wallet-success-mark" aria-hidden="true">{'\u2713'}</div>
    <h1>{t('walletSubmittedTitle')}</h1>
    <p className="wallet-success-copy">{t('walletSubmittedBody')}</p>
    <button className="primary-button wide" onClick={backToMain}>{t('walletBackToWallet')}<span aria-hidden="true">{'\u2192'}</span></button>
  </section>;

  if (view === 'main') return <section className="screen wallet-screen wallet-redesign">
    <span className="eyebrow">{t('wallet')}</span><h1>{t('wallet')}</h1>
    <div className="wallet-hero-card"><div className="wallet-card-top"><div><span>{t('walletTitle')}</span><small>{t('demoCredits')}</small></div><span className="wallet-hero-icon"><WalletIcon name="wallet"/></span></div><strong>{balance === null ? t('unavailable') : balance.toLocaleString()}</strong><span className="wallet-credit-unit">{t('etb')}</span><span className="wallet-practice-badge">{moneyEnabled ? t('walletAvailable') : t('walletLocked')}</span></div>
    <div className="wallet-action-grid"><button className="wallet-action-card primary" disabled={!token || !moneyEnabled} onClick={openDeposit}><WalletIcon name="deposit"/><strong>{t('deposit')}</strong></button><button className="wallet-action-card" disabled={!token || !moneyEnabled} onClick={openWithdrawal}><WalletIcon name="withdraw"/><strong>{t('withdraw')}</strong></button></div>
    {!moneyEnabled && <div className="wallet-preview-warning"><span>!</span><p><strong>{t('walletMoneyLockedTitle')}</strong> {t('walletMoneyLockedBody')}</p></div>}
    <form className="wallet-promo-inline" onSubmit={(event) => void applyPromoCode(event)}><label htmlFor="wallet-promo-code">{t('walletPromoLabel')}</label><div><input id="wallet-promo-code" autoCapitalize="characters" maxLength={16} value={promoCode} onChange={(event) => setPromoCode(event.target.value.toUpperCase())} placeholder={t('walletPromoPlaceholder')}/><button type="submit" disabled={!promoCode.trim()}>{t('walletApply')}</button></div>{promoMessage && <small role="status">{promoMessage}</small>}</form>
    <div className="wallet-request-history"><div className="wallet-section-heading"><div><span className="eyebrow">{t('walletActivity')}</span><h2>{t('walletYourRequests')}</h2></div><button className="text-button" onClick={() => void refresh()}>{t('walletRefresh')} {'\u21BB'}</button></div>
      {!token ? <p className="wallet-history-empty">{t('walletSignInHistory')}</p> : [...requests.deposits, ...requests.withdrawals].sort((a, b) => b.created_at.localeCompare(a.created_at)).length ? [...requests.deposits.map((item) => ({ ...item, kind: 'deposit' as const })), ...requests.withdrawals.map((item) => ({ ...item, kind: 'withdrawal' as const }))].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((item) => <article className="wallet-history-row" key={item.id}><span className={`wallet-history-icon ${item.kind}`}><WalletIcon name={item.kind === 'deposit' ? 'deposit' : 'withdraw'}/></span><div><strong>{item.kind === 'deposit' ? t('walletDepositKind') : t('walletWithdrawalKind')} {'\u00B7'} {providerLabel[item.provider]}</strong><small>{item.id} {'\u00B7'} {new Date(item.created_at).toLocaleDateString()}</small>{item.review_reason && <small className="wallet-review-note">{item.review_reason}</small>}</div><div className="wallet-history-side"><strong>{item.amount} {t('etb')}</strong><span className={`demo-request-status ${item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'declined' : 'pending'}`}>{statusCopy(item.status)}</span></div></article>) : <p className="wallet-history-empty">{t('walletNoRequests')}</p>}
    </div><button className="text-button wallet-help" onClick={onSupport}>{t('support')}<span>{'\u203A'}</span></button>
  </section>;

  if (view === 'deposit') return <section className="screen wallet-screen wallet-flow-screen">
    <div className="wallet-flow-header"><button className="wallet-back" onClick={backToMain} aria-label={t('back')}><WalletIcon name="back"/></button><h1>{t('deposit')}</h1><span className="wallet-home-mark" aria-hidden="true">{'\u2302'}</span></div>
    <form className="wallet-simple-card" onSubmit={(event) => void submitDeposit(event)}>
      <div className="wallet-provider-switch" role="group" aria-label={t('walletPaymentMethod')}>
        {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
          const item = providers.find((entry) => entry.provider === id);
          const enabled = item?.enabled === true;
          return <button type="button" key={id} className={provider === id ? 'selected' : ''} aria-pressed={provider === id} disabled={!enabled} onClick={() => { setProvider(id); setMessage(''); }}>
            <ProviderMark provider={id}/><span>{providerLabel[id]}</span>
          </button>;
        })}
      </div>
      <div className="wallet-receiving-row">
        <div><span>{t('walletReceivingAccount')}</span><strong>{selectedProvider?.accountNumber || t('unavailable')}</strong>{selectedProvider?.accountLabel && <small>{selectedProvider.accountLabel}</small>}</div>
        <button type="button" className="wallet-copy-button" onClick={() => void copyAccount()} disabled={!selectedProvider?.accountNumber}><WalletIcon name="copy"/>{copied ? t('walletCopied') : t('walletCopyNumber')}</button>
      </div>
      <label className="wallet-simple-field">{t('walletAmountLabel')}
        <input type="number" inputMode="numeric" min={depositMinimum} max={depositMaximum} step="1" value={depositAmount} onChange={(event) => { setDepositAmount(event.target.value); setMessage(''); }} placeholder={`${t('walletMinimumAmount')} ${depositMinimum} ${t('etb')}`} aria-invalid={depositAmount !== '' && !depositAmountValid}/>
        {depositAmount !== '' && !depositAmountValid && <small className="wallet-field-error" role="alert">{t('walletAmountError')}</small>}
      </label>
      <label className="wallet-simple-field">{t('walletSmsLabel')}
        <textarea rows={4} maxLength={1000} value={depositSms} onChange={(event) => { setDepositSms(event.target.value); setMessage(''); }} placeholder={t('walletSmsPlaceholder')} aria-invalid={depositSms !== '' && depositSms.trim().length < 8}/>
        {depositSms !== '' && depositSms.trim().length < 8 && <small className="wallet-field-error" role="alert">{t('walletSmsRequired')}</small>}
      </label>
      {message && <p className="wallet-form-message" role="alert">{message}</p>}
      <button className="primary-button wide wallet-submit-button" type="submit" disabled={busy || !depositValid}>{busy ? t('walletSubmitting') : t('walletSubmit')}<span aria-hidden="true">{'\u2192'}</span></button>
    </form>
  </section>;

  return <section className="screen wallet-screen wallet-flow-screen">
    <div className="wallet-flow-header"><button className="wallet-back" onClick={backToMain} aria-label={t('back')}><WalletIcon name="back"/></button><h1>{t('withdraw')}</h1><span className="wallet-home-mark" aria-hidden="true">{'\u2302'}</span></div>
    <form className="wallet-simple-card" onSubmit={(event) => void submitWithdrawal(event)}>
      <div className="wallet-provider-switch" role="group" aria-label={t('walletPaymentMethod')}>
        {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
          const item = providers.find((entry) => entry.provider === id);
          const enabled = item?.enabled === true;
          return <button type="button" key={id} className={provider === id ? 'selected' : ''} aria-pressed={provider === id} disabled={!enabled} onClick={() => { setProvider(id); setMessage(''); }}>
            <ProviderMark provider={id}/><span>{providerLabel[id]}</span>
          </button>;
        })}
      </div>
      <div className="wallet-balance-strip"><span>{t('availableBalance')}</span><strong>{balance === null ? t('unavailable') : `${balance.toLocaleString()} ${t('etb')}`}</strong></div>
      <label className="wallet-simple-field">{t('walletWithdrawPhoneLabel')}
        <input type="tel" inputMode="tel" autoComplete="tel" maxLength={20} value={withdrawPhone} onChange={(event) => { setWithdrawPhone(event.target.value); setMessage(''); }} placeholder={t('walletWithdrawPhonePlaceholder')} aria-invalid={withdrawPhone !== '' && !normalizedPhone}/>
        {withdrawPhone !== '' && !normalizedPhone && <small className="wallet-field-error" role="alert">{t('walletInvalidPhone')}</small>}
      </label>
      <label className="wallet-simple-field">{t('walletAmountLabel')}
        <input type="number" inputMode="numeric" min={withdrawalMinimum} max={withdrawalMaximum} step="1" value={withdrawAmount} onChange={(event) => { setWithdrawAmount(event.target.value); setMessage(''); }} placeholder={`${t('walletMinimumAmount')} ${withdrawalMinimum} ${t('etb')}`} aria-invalid={withdrawAmount !== '' && !withdrawAmountValid}/>
        {withdrawAmount !== '' && !withdrawAmountValid && <small className="wallet-field-error" role="alert">{balance !== null && withdrawAmountNumber > balance ? t('walletInsufficientBalance') : t('walletAmountError')}</small>}
      </label>
      {message && <p className="wallet-form-message" role="alert">{message}</p>}
      <button className="primary-button wide wallet-submit-button" type="submit" disabled={busy || !withdrawValid}>{busy ? t('walletRequesting') : t('walletRequestWithdrawal')}<span aria-hidden="true">{'\u2192'}</span></button>
      <p className="wallet-simple-note">{t('walletWithdrawNote')}</p>
    </form>
  </section>;
}
