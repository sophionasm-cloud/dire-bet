import { useCallback, useEffect, useState, type FormEvent } from 'react';

type ProviderId = 'telebirr' | 'ebirr';
type PaymentProvider = { provider: ProviderId; accountLabel: string; accountNumber: string; enabled: boolean; minimumAmount: number; maximumAmount: number };
type PaymentRequest = { id: string; player: string; provider: ProviderId; amount: number; status: string; created_at: string; review_reason: string | null; provider_reference?: string | null; senderPhone?: string; destinationPhone?: string; accountHolderName?: string; has_receipt?: number; receiptData?: string };
type AgeRequest = { userId: number; player: string; verificationReference: string; submittedAt: string };
type ActivationStatus = { active: boolean; configured: boolean; record: { minimum_age: number; approved_at: string } | null };
type Props = { token: string | null };
type ErrorBody = { error?: string };

async function readJson<T>(response: Response): Promise<T & ErrorBody> {
  return await response.json() as T & ErrorBody;
}

function stateLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

export default function PaymentManagement({ token }: Props) {
  const [section, setSection] = useState<'deposits' | 'withdrawals' | 'age' | 'settings'>('deposits');
  const [deposits, setDeposits] = useState<PaymentRequest[]>([]);
  const [withdrawals, setWithdrawals] = useState<PaymentRequest[]>([]);
  const [providers, setProviders] = useState<PaymentProvider[]>([]);
  const [ageRequests, setAgeRequests] = useState<AgeRequest[]>([]);
  const [activation, setActivation] = useState<ActivationStatus>({ active: false, configured: false, record: null });
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
      const [depositResponse, withdrawalResponse, settingsResponse, activationResponse, ageResponse] = await Promise.all([
        fetch('/api/admin/wallet/deposits', { headers }),
        fetch('/api/admin/wallet/withdrawals', { headers }),
        fetch('/api/admin/wallet/settings', { headers }),
        fetch('/api/admin/activation', { headers }),
        fetch('/api/admin/identity/age-requests', { headers }),
      ]);
      const [depositData, withdrawalData, settingsData, activationData, ageData] = await Promise.all([
        readJson<{ requests: PaymentRequest[] }>(depositResponse),
        readJson<{ requests: PaymentRequest[] }>(withdrawalResponse),
        readJson<{ providers: PaymentProvider[] }>(settingsResponse),
        readJson<ActivationStatus>(activationResponse),
        readJson<{ requests: AgeRequest[] }>(ageResponse),
      ]);
      if (!depositResponse.ok || !withdrawalResponse.ok || !settingsResponse.ok || !activationResponse.ok || !ageResponse.ok) throw new Error(depositData.error || withdrawalData.error || settingsData.error || activationData.error || ageData.error || 'Payment records could not be loaded.');
      setDeposits(depositData.requests || []); setWithdrawals(withdrawalData.requests || []); setProviders(settingsData.providers || []);
      setActivation(activationData); setAgeRequests(ageData.requests || []);
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
      const result = await readJson<{ ok?: boolean; balanceChanged?: boolean }>(response);
      if (!response.ok) throw new Error(result.error || 'The request could not be reviewed.');
      setNotice(kind === 'deposits' && status === 'approved' ? 'Deposit verified and approved; the ETB wallet was credited.' : kind === 'withdrawals' && status === 'rejected' ? 'Withdrawal rejected; the reserved ETB was returned to the wallet.' : kind === 'withdrawals' && status === 'paid' ? 'Withdrawal marked complete with its transfer reference.' : kind === 'withdrawals' && status === 'approved' ? 'Withdrawal approved. Send the transfer, then mark it complete with its reference.' : `${kind === 'deposits' ? 'Deposit' : 'Withdrawal'} marked ${stateLabel(status)}.`);
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
      setProviders(result.providers); setNotice('Payment accounts saved. They remain hidden until the approval gate is active.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment settings could not be saved.'); }
    finally { setBusy(false); }
  };

  const reviewAge = async (row: AgeRequest, status: 'verified' | 'blocked') => {
    if (!token) return;
    const verifiedAge = status === 'verified' ? Number(window.prompt('Verified age in years')) : undefined;
    const reason = status === 'blocked' ? window.prompt('Reason for blocking this age request')?.trim() || '' : '';
    if (status === 'verified' && (!Number.isInteger(verifiedAge) || (verifiedAge as number) < 18)) return;
    if (status === 'blocked' && reason.length < 3) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/identity/age-requests/${row.userId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status, verifiedAge, reason }) });
      const data = await readJson<{ ok?: boolean }>(response);
      if (!response.ok) throw new Error(data.error || 'Age request could not be reviewed.');
      setNotice(status === 'verified' ? 'Age approved. Money access still requires the site approval gate.' : 'Age request blocked.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Age request could not be reviewed.'); }
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
      const data = await readJson<{ recorded?: boolean; active?: boolean }>(response);
      if (!response.ok || !data.recorded) throw new Error(data.error || 'Approval evidence could not be recorded.');
      setNotice('Approval evidence recorded. Live money remains locked until approved production settings are enabled.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval evidence could not be recorded.'); }
    finally { setBusy(false); }
  };

  const rows = section === 'deposits' ? deposits : withdrawals;
  const counts = { deposits: deposits.filter((item) => ['pending', 'needs_info'].includes(item.status)).length, withdrawals: withdrawals.filter((item) => ['pending', 'reviewing', 'approved'].includes(item.status)).length };

  return <section className="payment-management">
    <div className="payment-tab-row" role="tablist" aria-label="Payment administration">
      {(['deposits', 'withdrawals', 'age', 'settings'] as const).map((item) => <button key={item} role="tab" aria-selected={section === item} className={section === item ? 'selected' : ''} onClick={() => { setSection(item); setDetail(null); setError(''); setNotice(''); }}>
        {item === 'deposits' ? 'Deposit requests' : item === 'withdrawals' ? 'Withdrawal requests' : item === 'age' ? 'Age review' : 'Payment settings'}{item === 'deposits' && counts.deposits > 0 && <b>{counts.deposits}</b>}{item === 'withdrawals' && counts.withdrawals > 0 && <b>{counts.withdrawals}</b>}{item === 'age' && ageRequests.length > 0 && <b>{ageRequests.length}</b>}
      </button>)}
    </div>
    <div className="payment-safety-note"><strong>{activation.active ? 'Wallet gate active' : 'Wallet gate locked'}</strong><span>{activation.active ? 'Verified deposits credit the ETB wallet. Approved withdrawals are sent manually and then marked complete.' : 'Deposits, withdrawals and paid rooms remain unavailable until required legal and provider approvals are recorded and production settings are enabled.'}</span></div>
    {error && <p className="room-admin-error" role="alert">{error}</p>}{notice && <p className="room-admin-notice" role="status">{notice}</p>}
    {loading ? <div className="room-admin-state">Loading payment records…</div> : section === 'settings' ? <>
      <form className="payment-settings-grid" onSubmit={(event) => void saveSettings(event)}>
      {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
        const item = providers.find((entry) => entry.provider === id);
        if (!item) return null;
        return <fieldset key={id} className="payment-provider-setting"><legend>{id === 'telebirr' ? 'Telebirr' : 'eBirr'}</legend>
          <label>Receiving account label<input maxLength={100} value={item.accountLabel} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountLabel: event.target.value } : entry))} placeholder="Leave blank until confirmed"/></label>
          <label>Receiving phone number<input type="tel" inputMode="tel" value={item.accountNumber} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, accountNumber: event.target.value } : entry))}/></label>
          <label className="payment-enabled-toggle"><input type="checkbox" checked={item.enabled} disabled={!activation.active} onChange={(event) => setProviders((list) => list.map((entry) => entry.provider === id ? { ...entry, enabled: event.target.checked } : entry))}/> Make this method available to users</label>
          <small>Minimum request: {item.minimumAmount} ETB · Maximum request: {item.maximumAmount} ETB</small>
        </fieldset>;
      })}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save payment settings'}</button>
      </form>
      <div className="payment-safety-note"><strong>Production status</strong><span>{activation.configured ? 'Production settings are configured.' : 'Runtime flags still keep real money disabled.'} {activation.record ? `Recorded minimum age: ${activation.record.minimum_age}+.` : 'No approval evidence record is on file.'}</span></div>
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
    </> : section === 'age' ? <>
      <div className="payment-list-heading"><div><span className="staff-label">AGE CHECKS</span><p>{ageRequests.length} requests · review the verifier reference before approval</p></div><button className="staff-link-button" onClick={() => void load()}>Refresh</button></div>
      {ageRequests.length ? <div className="payment-request-list">{ageRequests.map((row) => <article key={row.userId} className="payment-request-card"><div className="payment-request-main"><div><small>{row.submittedAt}</small><h3>{row.player}</h3><span>Account {row.userId}</span></div><span className="room-admin-status pending">Needs review</span></div><p>Age-check reference: {row.verificationReference || 'Not readable'}</p><div className="payment-review-actions"><button className="secondary-button" disabled={busy} onClick={() => void reviewAge(row, 'blocked')}>Block</button><button className="primary-button" disabled={busy || !row.verificationReference} onClick={() => void reviewAge(row, 'verified')}>Approve 18+</button></div></article>)}</div> : <div className="room-admin-state">No age checks need review.</div>}
    </> : <>
      <div className="payment-list-heading"><div><span className="staff-label">{section === 'deposits' ? 'DEPOSIT REQUESTS' : 'WITHDRAWAL REQUESTS'}</span><p>{rows.length} requests · newest first</p></div><button className="staff-link-button" onClick={() => void load()}>Refresh</button></div>
      {rows.length === 0 ? <div className="room-admin-state">No {section === 'deposits' ? 'deposit' : 'withdrawal'} requests yet.</div> : <div className="payment-request-list">{rows.map((row) => <article key={row.id} className="payment-request-card">
        <div className="payment-request-main"><div><small>{row.id} · {row.created_at}</small><h3>{row.amount.toLocaleString()} ETB</h3><span>{row.player} · {row.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</span></div><span className={`room-admin-status ${row.status}`}>{stateLabel(row.status)}</span></div>
        <div className="payment-request-meta"><span>{section === 'deposits' ? 'Sender' : 'Destination'}: {section === 'deposits' ? row.senderPhone || 'Open details' : row.destinationPhone || 'Open details'}</span>{row.provider_reference && <span>Reference: {row.provider_reference}</span>}</div>
        <button className="room-admin-view" onClick={() => void openDetail(row, section)}>View request</button>
      </article>)}</div>}
    </>}
    {detail && <div className="room-detail-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}><aside className="room-detail-panel payment-detail-panel" role="dialog" aria-modal="true" aria-label="Payment request details">
      <header><div><span className="staff-label">REQUEST DETAILS</span><h3>{detail.id}</h3></div><button className="staff-link-button" onClick={() => setDetail(null)}>Close</button></header>
      <dl className="payment-detail-grid"><div><dt>Player</dt><dd>{detail.player}</dd></div><div><dt>Method</dt><dd>{detail.provider === 'telebirr' ? 'Telebirr' : 'eBirr'}</dd></div><div><dt>Amount</dt><dd>{detail.amount} ETB</dd></div><div><dt>Status</dt><dd>{stateLabel(detail.status)}</dd></div><div><dt>{detail.senderPhone !== undefined ? 'Sender phone' : 'Destination phone'}</dt><dd>{detail.senderPhone ?? detail.destinationPhone ?? 'Not available'}</dd></div>{detail.accountHolderName && <div><dt>Account holder</dt><dd>{detail.accountHolderName}</dd></div>}{detail.provider_reference && <div><dt>Transaction reference</dt><dd>{detail.provider_reference}</dd></div>}<div><dt>Submitted</dt><dd>{detail.created_at}</dd></div></dl>
      {detail.receiptData && <figure className="payment-receipt"><img src={detail.receiptData} alt="Uploaded payment confirmation screenshot"/><figcaption>Payment screenshot for manual verification</figcaption></figure>}
      {detail.review_reason && <p className="payment-safety-note"><strong>Review note</strong><span>{detail.review_reason}</span></p>}
      {section === 'withdrawals' && detail.status === 'approved' ? <div className="payment-review-actions"><button className="primary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'paid')}>Mark payout complete</button></div> : detail.status === 'pending' || detail.status === 'needs_info' || detail.status === 'reviewing' ? <div className="payment-review-actions">
        {section === 'deposits' ? <><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'needs_info')}>Request more info</button><button className="secondary-button" disabled={busy} onClick={() => void review('deposits', detail, 'rejected')}>Reject</button><button className="primary-button" disabled={busy || !detail.receiptData || !detail.provider_reference} onClick={() => void review('deposits', detail, 'approved')}>Verify &amp; approve</button></> : <><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'reviewing')}>Mark reviewing</button><button className="secondary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'rejected')}>Reject and return funds</button><button className="primary-button" disabled={busy} onClick={() => void review('withdrawals', detail, 'approved')}>Approve payout</button></>}
      </div> : <p className="payment-safety-note"><strong>{detail.status === 'paid' ? 'Completed' : 'Already reviewed'}</strong><span>{detail.status === 'paid' ? 'The administrator recorded the manual payout transfer reference.' : detail.status === 'approved' && section === 'withdrawals' ? 'The payout is approved and awaiting the manual transfer.' : detail.status === 'approved' ? 'The payment was verified and the wallet credited.' : 'Review actions are locked after this final decision.'}</span></p>}
    </aside></div>}
  </section>;
}
