import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

type ProviderId = 'telebirr' | 'ebirr';
type PaymentProvider = { provider: ProviderId; accountLabel: string; accountNumber: string; enabled: boolean; minimumAmount: number; maximumAmount: number; withdrawalMinimumAmount?: number; withdrawalMaximumAmount?: number };
type PaymentRequest = {
  id: string; user_id: number; player: string; provider: ProviderId; amount: number; balance?: number; status: string; created_at: string;
  review_reason: string | null; simulationOnly?: boolean; provider_reference?: string | null; proof_method?: 'receipt' | 'sms';
  confirmationSms?: string; confirmationSmsPreview?: string; senderPhone?: string; destinationPhone?: string; accountHolderName?: string;
  has_receipt?: number; has_sms?: number; receiptData?: string; flags?: string[];
};
type ActivationStatus = { active: boolean; simulationEnabled?: boolean; configured: boolean; record: { minimum_age: number; approved_at: string } | null };
type WalletSummary = { pendingDeposits: number; pendingWithdrawals: number; approvedWithdrawals: number; completedWithdrawals: number; totalWithdrawalAmount: number; simulationOnly?: boolean };
type Props = { token: string | null };
type ErrorBody = { error?: string };

async function readJson<T>(response: Response): Promise<T & ErrorBody> {
  return await response.json() as T & ErrorBody;
}

function stateLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function playNotificationTone() {
  try {
    const audio = new AudioContext(); const oscillator = audio.createOscillator(); const gain = audio.createGain();
    oscillator.frequency.value = 880; gain.gain.value = 0.035; oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.start(); oscillator.stop(audio.currentTime + 0.12); oscillator.onended = () => void audio.close();
  } catch { /* Browser audio can be unavailable until the admin enables it. */ }
}

export default function PaymentManagement({ token }: Props) {
  const [section, setSection] = useState<'deposits' | 'withdrawals' | 'settings'>('deposits');
  const [deposits, setDeposits] = useState<PaymentRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<PaymentRequest[]>([]);
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [activation, setActivation] = useState<ActivationStatus>({ active: false, configured: false, record: null });
  const [summary, setSummary] = useState<WalletSummary>({ pendingDeposits: 0, pendingWithdrawals: 0, approvedWithdrawals: 0, completedWithdrawals: 0, totalWithdrawalAmount: 0 });
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('dire-wallet-notification-sound') === 'true');
  const [detail, setDetail] = useState<PaymentRequest | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const seenPending = useRef<Set<string> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!token) { setError('Sign in with the Super Admin Telegram account.'); setLoading(false); return; }
    if (!silent) setLoading(true); setError('');
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [depositResponse, withdrawalResponse, settingsResponse, activationResponse, summaryResponse] = await Promise.all([
        fetch('/api/admin/wallet/deposits', { headers }),
        fetch('/api/admin/wallet/withdrawals', { headers }),
        fetch('/api/admin/wallet/settings', { headers }),
        fetch('/api/admin/activation', { headers }),
        fetch('/api/admin/wallet/summary', { headers }),
      ]);
      const [depositData, withdrawalData, settingsData, activationData, summaryData] = await Promise.all([
        readJson<{ requests: PaymentRequest[] }>(depositResponse),
        readJson<{ requests: PaymentRequest[] }>(withdrawalResponse),
        readJson<{ providers: PaymentProvider[]; simulationEnabled?: boolean }>(settingsResponse),
        readJson<ActivationStatus>(activationResponse),
        readJson<WalletSummary>(summaryResponse),
      ]);
      if (!depositResponse.ok || !withdrawalResponse.ok || !settingsResponse.ok || !activationResponse.ok || !summaryResponse.ok) throw new Error(depositData.error || withdrawalData.error || settingsData.error || activationData.error || summaryData.error || 'Payment records could not be loaded.');
      setDeposits(depositData.requests || []); setWithdrawals(withdrawalData.requests || []); setProviders(settingsData.providers || []);
      const nextPending = new Set([...(depositData.requests || []).filter((row) => ['pending', 'needs_info'].includes(row.status)).map((row) => `deposit:${row.id}`), ...(withdrawalData.requests || []).filter((row) => ['pending', 'reviewing'].includes(row.status)).map((row) => `withdrawal:${row.id}`)]);
      if (seenPending.current && [...nextPending].some((id) => !seenPending.current!.has(id))) {
        setNotice('New wallet request received.'); if (soundEnabled) playNotificationTone();
      }
      seenPending.current = nextPending;
      setActivation({ ...activationData, simulationEnabled: settingsData.simulationEnabled ?? activationData.simulationEnabled }); setSummary(summaryData);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment records could not be loaded.'); }
    finally { if (!silent) setLoading(false); }
  }, [token, soundEnabled]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(true), 15000); return () => window.clearInterval(timer); }, [load]);

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
    const paymentReference = status === 'paid' ? window.prompt('Telebirr/eBirr payout transfer reference')?.trim() || '' : '';
    if (status === 'paid' && paymentReference.length < 3) return;
    const reason = status === 'rejected' || status === 'needs_info'
      ? window.prompt(status === 'rejected' ? 'Reason for rejection' : 'What information is needed?')?.trim() || ''
      : '';
    if ((status === 'rejected' || status === 'needs_info') && reason.length < 3) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/wallet/${kind}/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status, reason, paymentReference }),
      });
      const result = await readJson<{ ok?: boolean }>(response);
      if (!response.ok) throw new Error(result.error || 'The request could not be reviewed.');
      setNotice(kind === 'deposits' && status === 'approved' ? 'Deposit approved; the Birr wallet was credited.' : kind === 'withdrawals' && status === 'rejected' ? 'Withdrawal rejected; the reserved Birr was returned to the wallet.' : kind === 'withdrawals' && status === 'paid' ? 'Withdrawal marked complete with its transfer reference.' : kind === 'withdrawals' && status === 'approved' ? 'Withdrawal approved. Send the transfer, then mark it complete with its reference.' : `${kind === 'deposits' ? 'Deposit' : 'Withdrawal'} marked ${stateLabel(status)}.`);
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
      setProviders(result.providers); setNotice(activation.active ? 'Payment accounts saved.' : 'Payment accounts saved. No payment will be processed until the authorization gate is active.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment settings could not be saved.'); }
    finally { setBusy(false); }
  };

  const saveActivationEvidence = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const value = (name: string) => String(form.get(name) || '').trim();
    const licenseReferences = value('licenseReferences').split('\n').map((item) => item.trim()).filter(Boolean);
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/activation', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
        counselApproval: value('counselApproval'), licenseReview: value('licenseReview'), licenseReferences,
        providerApprovals: { telebirr: value('telebirrApproval'), ebirr: value('ebirrApproval') },
        telegramApproval: value('telegramApproval'), nationalBankReview: value('nationalBankReview'),
        ageVerificationMethod: value('ageVerificationMethod'), responsiblePlayPolicy: value('responsiblePlayPolicy'),
        privacyReview: value('privacyReview'), minimumAge: Number(value('minimumAge')), ownerSignedAt: value('ownerSignedAt'),
      }) });
      const data = await readJson<{ recorded?: boolean }>(response);
      if (!response.ok || !data.recorded) throw new Error(data.error || 'Approval evidence could not be recorded.');
      setNotice('Approval evidence recorded. Live money remains locked until approved production settings are enabled.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval evidence could not be recorded.'); }
    finally { setBusy(false); }
  };

  const rawRows = section === 'deposits' ? deposits : withdrawals;
  const query = search.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!query) return rawRows;
    return rawRows.filter((row) => [row.id, row.player, String(row.user_id), row.provider, row.status, row.senderPhone, row.destinationPhone, row.provider_reference, row.accountHolderName, row.review_reason, ...(row.flags || [])].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [rawRows, query]);
  const counts = { deposits: deposits.filter((item) => ['pending', 'needs_info'].includes(item.status)).length, withdrawals: withdrawals.filter((item) => ['pending', 'reviewing'].includes(item.status)).length };
  const toggleSound = () => setSoundEnabled((enabled) => { localStorage.setItem('dire-wallet-notification-sound', String(!enabled)); return !enabled; });

  return <section className="payment-management">
    <div className="payment-tab-row" role="tablist" aria-label="Payment administration">
      {(['deposits', 'withdrawals', 'settings'] as const).map((item) => <button key={item} role="tab" aria-selected={section === item} className={section === item ? 'selected' : ''} onClick={() => { setSection(item); setDetail(null); setError(''); setNotice(''); }}>
        {item === 'deposits' ? 'Deposit requests' : item === 'withdrawals' ? 'Withdrawal requests' : 'Payment settings'}{item === 'deposits' && counts.deposits > 0 && <b>{counts.deposits}</b>}{item === 'withdrawals' && counts.withdrawals > 0 && <b>{counts.withdrawals}</b>}
      </button>)}
    </div>
    <div className="payment-safety-note"><strong>{activation.active ? 'Live wallet active' : 'Wallet gate locked'}</strong><span>{activation.active ? 'Verified deposits credit the Birr wallet. Approved withdrawals are sent manually and then marked complete.' : 'Deposits, withdrawals and paid rooms remain unavailable until required legal and provider approvals are recorded and production settings are enabled.'}</span></div>
    {section !== 'settings' && <div className="payment-summary-grid" aria-label="Wallet request totals"><article><span>Pending Deposits</span><strong>{summary.pendingDeposits}</strong></article><article><span>Pending Withdrawals</span><strong>{summary.pendingWithdrawals}</strong></article><article><span>Approved Withdrawals</span><strong>{summary.approvedWithdrawals}</strong></article><article><span>Completed Withdrawals</span><strong>{summary.completedWithdrawals}</strong></article><article><span>Total Withdrawal Amount</span><strong>{summary.totalWithdrawalAmount.toLocaleString()} Birr</strong></article></div>}
    {section !== 'settings' && <div className="payment-notification-control"><span>New requests refresh automatically every 15 seconds.</span><button type="button" className="staff-link-button" aria-pressed={soundEnabled} onClick={toggleSound}>Sound {soundEnabled ? 'on' : 'off'}</button></div>}
    {error && <p className="room-admin-error" role="alert">{error}</p>}{notice && <p className="room-admin-notice" role="status">{notice}</p>}
    {loading ? <div className="room-admin-state">Loading payment records…</div> : section === 'settings' ? <>
      <form className="payment-settings-grid" onSubmit={(event) => void saveSettings(event)}>
      {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
        const item = providers.find((entry) => entry.provider === id);
        if (!item) return null;
        return <fieldset key={id} className="payment-provider-setting"><legend>{id === 'telebirr' ? 'Telebirr' : 'eBirr'}</legend>
          <label>Receiving account label<input maxLength={100} value={item.accountLabel} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountLabel: event.target.value } : entry))} placeholder="Leave blank until confirmed"/></label>
          <label>Receiving phone number<input type="tel" inputMode="tel" value={item.accountNumber} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountNumber: event.target.value } : entry))}/></label>
          <label className="payment-enabled-toggle"><input type="checkbox" checked={item.enabled} disabled={!activation.active && !activation.simulationEnabled} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, enabled: event.target.checked } : entry))}/> Make this method available to users</label>
          <small>Minimum request: {item.minimumAmount} Birr · Maximum request: {item.maximumAmount} Birr</small>
        </fieldset>;
      })}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save payment settings'}</button>
      </form>
      <div className="payment-safety-note"><strong>{activation.active ? 'Production status' : 'Wallet settings'}</strong><span>{activation.active ? 'Live payment settings are active.' : 'Runtime flags still keep real money disabled.'} {activation.configured ? 'Production flags are configured.' : 'Live money remains disabled.'} {activation.record ? `Recorded minimum age: ${activation.record.minimum_age}+.` : 'No approval evidence record is on file.'}</span></div>
      <form className="payment-settings-grid" onSubmit={(event) => void saveActivationEvidence(event)}><fieldset className="payment-provider-setting"><legend>Required approval evidence</legend>
        <label>Legal counsel approval reference<input name="counselApproval" required minLength={3}/></label>
        <label>License review reference<input name="licenseReview" required minLength={3}/></label>
        <label>Related license references (one per line)<textarea name="licenseReferences" rows={3}/></label>
        <label>Telebirr merchant approval reference<input name="telebirrApproval" required minLength={3}/></label>
        <label>eBirr merchant approval reference<input name="ebirrApproval" required minLength={3}/></label>
        <label>Telegram approval reference<input name="telegramApproval" required minLength={3}/></label>
        <label>National Bank review reference<input name="nationalBankReview" required minLength={3}/></label>
        <label>Age verification method reference<input name="ageVerificationMethod" required minLength={3}/></label>
        <label>Responsible play policy reference<input name="responsiblePlayPolicy" required minLength={3}/></label>
        <label>Privacy review reference<input name="privacyReview" required minLength={3}/></label>
        <label>Minimum age<input name="minimumAge" type="number" min={18} max={120} defaultValue={18} required/></label>
        <label>Owner approval date<input name="ownerSignedAt" type="date" max={new Date().toISOString().slice(0, 10)} required/></label>
      </fieldset><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record approval evidence'}</button></form>
    </> : <>
      <div className="payment-list-heading"><div><span className="staff-label">{section === 'deposits' ? 'DEPOSIT REQUESTS' : 'WITHDRAWAL REQUESTS'}</span><p>{rows.length} requests · newest first</p></div><div className="payment-list-controls"><input className="payment-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search user, ID, phone, reference" aria-label="Search payment requests"/><button className="staff-link-button" onClick={() => void load()}>Refresh</button></div></div>
      {rows.length === 0 ? <div className="room-admin-state">No matching {section === 'deposits' ? 'deposit' : 'withdrawal'} requests.</div> : <div className="payment-request-list">{rows.map((row) => <article key={row.id} className="payment-request-card">
        <div className="payment-request-main"><div><small>{row.id} · {new Date(row.created_at).toLocaleString()}</small><h3>{row.amount.toLocaleString()} Birr</h3><span>{row.player || 'User'} · User ID {row.user_id ?? '—'} · {row.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</span></div><span className={`room-admin-status ${row.status || 'pending'}`}>{stateLabel(row.status || 'pending')}</span></div>
        <div className="payment-request-meta">
          {section === 'deposits' ? <span>Sender: {row.senderPhone || 'Not provided'}</span> : <span>Recipient: {row.destinationPhone || 'Not provided'}</span>}
          {section === 'withdrawals' && <span>Current balance: {(row.balance || 0).toLocaleString()} Birr</span>}
          {row.provider_reference && <span>Reference: {row.provider_reference}</span>}
          {section === 'deposits' && row.confirmationSmsPreview && <span className="payment-sms-preview">SMS: {row.confirmationSmsPreview}</span>}
        </div>
        {row.flags && row.flags.length > 0 && <div className="payment-flags">{row.flags.map((flag) => <span key={flag} className={`payment-flag payment-flag-${flag}`}>{flag.replaceAll('_', ' ')}</span>)}</div>}
        <button className="room-admin-view" onClick={() => void openDetail(row, section)}>View request</button>
      </article>)}</div>}
    </>}
    {detail && <div className="room-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}><aside className="room-detail-panel payment-detail-panel" role="dialog" aria-modal="true" aria-label="Payment request details">
      <header><div><span className="staff-label">REQUEST DETAILS</span><h3>{detail.id}</h3></div><button className="staff-link-button" onClick={() => setDetail(null)}>Close</button></header>
      <dl className="payment-detail-grid">
        <div><dt>Player</dt><dd>{detail.player || 'User'}</dd></div>
        <div><dt>User ID</dt><dd>{detail.user_id ?? '—'}</dd></div>
        <div><dt>Method</dt><dd>{detail.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</dd></div>
        <div><dt>Amount</dt><dd>{detail.amount} Birr</dd></div>
        {detail.balance !== undefined && <div><dt>Current wallet balance</dt><dd>{detail.balance} Birr</dd></div>}
        <div><dt>Status</dt><dd>{stateLabel(detail.status || 'pending')}</dd></div>
        <div><dt>{section === 'deposits' ? 'Sender phone' : 'Recipient phone'}</dt><dd>{(section === 'deposits' ? detail.senderPhone : detail.destinationPhone) || 'Not provided'}</dd></div>
        {detail.accountHolderName && <div><dt>Account holder</dt><dd>{detail.accountHolderName}</dd></div>}
        <div><dt>Transaction reference</dt><dd>{detail.provider_reference || 'Not found'}</dd></div>
        <div><dt>Submitted</dt><dd>{detail.created_at ? new Date(detail.created_at).toLocaleString() : '—'}</dd></div>
      </dl>
      {detail.flags && detail.flags.length > 0 && <div className="payment-flags payment-flags-detail">{detail.flags.map((flag) => <span key={flag} className={`payment-flag payment-flag-${flag}`}>{flag.replaceAll('_', ' ')}</span>)}</div>}
      {detail.receiptData && <figure className="payment-receipt"><img src={detail.receiptData} alt="Uploaded payment receipt"/><figcaption>Payment receipt</figcaption></figure>}
      {detail.confirmationSms && <div className="payment-safety-note payment-sms-full"><strong>Payment SMS</strong><pre>{detail.confirmationSms}</pre></div>}
      {detail.review_reason && <p className="payment-safety-note"><strong>Review note</strong><span>{detail.review_reason}</span></p>}
      {section === 'withdrawals' && detail.status === 'approved' ? <div className="payment-review-actions"><button className="primary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'paid')}>Mark payout complete</button></div> : detail.status === 'pending' || detail.status === 'needs_info' || detail.status === 'reviewing' ? <div className="payment-review-actions">
        {section === 'deposits' ? <><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'needs_info')}>Request more info</button><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'rejected')}>Reject</button><button className="primary-button" disabled={busy || (!detail.confirmationSms && !detail.receiptData && !detail.has_sms && !detail.has_receipt)} onClick={() => void review('deposits', detail, 'approved')}>Verify &amp; approve</button></> : <><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'reviewing')}>Mark reviewing</button><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'rejected')}>Reject and return funds</button><button className="primary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'approved')}>Approve payout</button></>}
      </div> : <p className="payment-safety-note"><strong>{detail.status === 'paid' ? 'Completed' : 'Already reviewed'}</strong><span>{detail.status === 'paid' ? 'The administrator recorded the manual payout transfer reference.' : detail.status === 'approved' && section === 'withdrawals' ? 'The payout is approved and awaiting the manual transfer.' : detail.status === 'approved' ? 'The payment was verified and the wallet credited.' : 'Review actions are locked after this final decision.'}</span></p>}
    </aside></div>}
  </section>;
}
