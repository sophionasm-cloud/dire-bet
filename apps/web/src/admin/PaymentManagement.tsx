import { useCallback, useEffect, useState, type FormEvent } from 'react';

type ProviderId = 'telebirr' | 'ebirr';
type PaymentProvider = { provider: ProviderId; accountLabel: string; accountNumber: string; enabled: boolean; minimumAmount: number; maximumAmount: number };
type PaymentRequest = { id: string; player: string; provider: ProviderId; amount: number; status: string; created_at: string; review_reason: string | null; provider_reference?: string | null; senderPhone?: string; destinationPhone?: string; accountHolderName?: string; has_receipt?: number; receiptData?: string };
type Props = { token: string | null };
type ErrorBody = { error?: string };

async function readJson<T>(response: Response): Promise<T & ErrorBody> {
  return await response.json() as T & ErrorBody;
}

function stateLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

export default function PaymentManagement({ token }: Props) {
  const [section, setSection] = useState<'deposits' | 'withdrawals' | 'settings'>('deposits');
  const [deposits, setDeposits] = useState<PaymentRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<PaymentRequest[]>([]);
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [detail, setDetail] = useState<PaymentRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!token) { setError('Sign in with the Super Admin Telegram account.'); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [depositResponse, withdrawalResponse, settingsResponse] = await Promise.all([
        fetch('/api/admin/wallet/deposits', { headers }),
        fetch('/api/admin/wallet/withdrawals', { headers }),
        fetch('/api/admin/wallet/settings', { headers }),
      ]);
      const [depositData, withdrawalData, settingsData] = await Promise.all([
        readJson<{ requests: PaymentRequest[] }>(depositResponse),
        readJson<{ requests: PaymentRequest[] }>(withdrawalResponse),
        readJson<{ providers: PaymentProvider[] }>(settingsResponse),
      ]);
      if (!depositResponse.ok || !withdrawalResponse.ok || !settingsResponse.ok) throw new Error(depositData.error || withdrawalData.error || settingsData.error || 'Payment records could not be loaded.');
      setDeposits(depositData.requests || []); setWithdrawals(withdrawalData.requests || []); setProviders(settingsData.providers || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment records could not be loaded.'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = async (row: PaymentRequest, kind: 'deposits' | 'withdrawals') => {
    if (!token) return;
    setError(''); setDetail({ ...row });
    try {
      const response = await fetch(`/api/admin/wallet/${kind}/${encodeURIComponent(row.id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await readJson<{ request: PaymentRequest }>(response);
      if (!response.ok || !data.request) throw new Error(data.error || 'Request details could not be loaded.');
      setDetail(data.request);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request details could not be loaded.'); }
  };

  const review = async (kind: 'deposits' | 'withdrawals', row: PaymentRequest, status: string) => {
    if (!token) return;
    const reason = status === 'rejected' || status === 'needs_info'
      ? window.prompt(status === 'rejected' ? 'Reason for rejection' : 'What information is needed?')?.trim() || ''
      : '';
    if ((status === 'rejected' || status === 'needs_info') && reason.length < 3) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/wallet/${kind}/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status, reason }),
      });
      const result = await readJson<{ ok?: boolean; balanceChanged?: boolean }>(response);
      if (!response.ok) throw new Error(result.error || 'The request could not be reviewed.');
      setNotice(`${kind === 'deposits' ? 'Deposit' : 'Withdrawal'} marked ${stateLabel(status)}. No balance or cash was changed.`);
      setDetail(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The request could not be reviewed.'); }
    finally { setBusy(false); }
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || providers.length !== 2) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/wallet/settings', {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ providers: providers.map(({ provider, accountLabel, accountNumber, enabled }) => ({ provider, accountLabel, accountNumber, enabled })) }),
      });
      const result = await readJson<{ providers: PaymentProvider[] }>(response);
      if (!response.ok || !result.providers) throw new Error(result.error || 'Payment settings could not be saved.');
      setProviders(result.providers); setNotice('Payment preview settings saved and recorded in the audit log.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment settings could not be saved.'); }
    finally { setBusy(false); }
  };

  const rows = section === 'deposits' ? deposits : withdrawals;
  const counts = { deposits: deposits.filter((item) => ['pending', 'needs_info'].includes(item.status)).length, withdrawals: withdrawals.filter((item) => ['pending', 'reviewing'].includes(item.status)).length };

  return <section className="payment-management">
    <div className="payment-tab-row" role="tablist" aria-label="Payment requests">
      {(['deposits', 'withdrawals', 'settings'] as const).map((item) => <button key={item} role="tab" aria-selected={section === item} className={section === item ? 'selected' : ''} onClick={() => { setSection(item); setDetail(null); setError(''); setNotice(''); }}>
        {item === 'deposits' ? 'Deposit requests' : item === 'withdrawals' ? 'Withdrawal requests' : 'Payment settings'}{item !== 'settings' && counts[item] > 0 && <b>{counts[item]}</b>}
      </button>)}
    </div>
    <div className="payment-safety-note"><strong>Test Mode</strong><span>Approving requests never adds a balance. Withdrawals are requests only; there are no payouts.</span></div>
    {error && <p className="room-admin-error" role="alert">{error}</p>}{notice && <p className="room-admin-notice" role="status">{notice}</p>}
    {loading ? <div className="room-admin-state">Loading payment records…</div> : section === 'settings' ? <form className="payment-settings-grid" onSubmit={(event) => void saveSettings(event)}>
      {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
        const item = providers.find((entry) => entry.provider === id);
        if (!item) return null;
        return <fieldset key={id} className="payment-provider-setting"><legend>{id === 'telebirr' ? 'Telebirr' : 'eBirr'} · preview display</legend>
          <label>Receiving account label<input maxLength={100} value={item.accountLabel} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountLabel: event.target.value } : entry))} placeholder="Leave blank until confirmed"/></label>
          <label>Receiving phone number<input type="tel" inputMode="tel" value={item.accountNumber} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountNumber: event.target.value } : entry))}/></label>
          <label className="payment-enabled-toggle"><input type="checkbox" checked={item.enabled} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, enabled: event.target.checked } : entry))}/> Show this method in the preview</label>
          <small>Minimum request: {item.minimumAmount} ETB · Maximum request: {item.maximumAmount} ETB</small>
        </fieldset>;
      })}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save payment settings'}</button>
    </form> : <>
      <div className="payment-list-heading"><div><span className="staff-label">{section === 'deposits' ? 'DEPOSIT REQUESTS' : 'WITHDRAWAL REQUESTS'}</span><p>{rows.length} requests · newest first</p></div><button className="staff-link-button" onClick={() => void load()}>Refresh</button></div>
      {rows.length === 0 ? <div className="room-admin-state">No {section === 'deposits' ? 'deposit' : 'withdrawal'} requests yet.</div> : <div className="payment-request-list">{rows.map((row) => <article key={row.id} className="payment-request-card">
        <div className="payment-request-main"><div><small>{row.id} · {row.created_at}</small><h3>{row.amount.toLocaleString()} ETB</h3><span>{row.player} · {row.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</span></div><span className={`room-admin-status ${row.status}`}>{stateLabel(row.status)}</span></div>
        <div className="payment-request-meta"><span>{section === 'deposits' ? 'Sender' : 'Destination'}: {section === 'deposits' ? row.senderPhone || 'Open details' : row.destinationPhone || 'Open details'}</span>{row.provider_reference && <span>Reference: {row.provider_reference}</span>}</div>
        <button className="room-admin-view" onClick={() => void openDetail(row, section)}>View request</button>
      </article>)}</div>}
    </>}
    {detail && <div className="room-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}><aside className="room-detail-panel payment-detail-panel" role="dialog" aria-modal="true" aria-label="Payment request details">
      <header><div><span className="staff-label">REQUEST DETAILS</span><h3>{detail.id}</h3></div><button className="staff-link-button" onClick={() => setDetail(null)}>Close</button></header>
      <dl className="payment-detail-grid"><div><dt>Player</dt><dd>{detail.player}</dd></div><div><dt>Method</dt><dd>{detail.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</dd></div><div><dt>Amount</dt><dd>{detail.amount} ETB · preview</dd></div><div><dt>Status</dt><dd>{stateLabel(detail.status)}</dd></div><div><dt>{detail.senderPhone !== undefined ? 'Sender phone' : 'Destination phone'}</dt><dd>{detail.senderPhone ?? detail.destinationPhone ?? 'Not available'}</dd></div>{detail.accountHolderName && <div><dt>Account holder</dt><dd>{detail.accountHolderName}</dd></div>}{detail.provider_reference && <div><dt>Transaction reference</dt><dd>{detail.provider_reference}</dd></div>}<div><dt>Submitted</dt><dd>{detail.created_at}</dd></div></dl>
      {detail.receiptData && <figure className="payment-receipt"><img src={detail.receiptData} alt="Uploaded payment receipt"/><figcaption>Receipt supplied for visual review · preview only</figcaption></figure>}
      {detail.review_reason && <p className="payment-safety-note"><strong>Review note</strong><span>{detail.review_reason}</span></p>}
      {detail.status === 'pending' || detail.status === 'needs_info' || detail.status === 'reviewing' ? <div className="payment-review-actions">
        {section === 'deposits' ? <><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'needs_info')}>Request more info</button><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'rejected')}>Reject</button><button className="primary-button" disabled={busy} onClick={() => void review('deposits', detail, 'approved')}>Approve preview</button></> : <><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'reviewing')}>Mark reviewing</button><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'rejected')}>Reject</button><button className="primary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'approved')}>Approve request</button></>}
      </div> : <p className="payment-safety-note"><strong>Already reviewed</strong><span>Review actions are locked after a final decision. No balance or payout was changed.</span></p>}
    </aside></div>}
  </section>;
}
