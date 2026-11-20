import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { TranslationKey } from '../i18n';

type ProviderId = 'telebirr' | 'ebirr';
type Provider = { provider: ProviderId; accountLabel: string; accountNumber: string; enabled: boolean; minimumAmount: number; maximumAmount: number };
type WalletRequest = { id: string; provider: ProviderId; amount: number; status: string; created_at: string; review_reason: string | null; provider_reference?: string | null; reviewed_at?: string | null };
type DepositProof = 'receipt' | 'sms';
type RequestData = { deposits: WalletRequest[]; withdrawals: WalletRequest[] };
type Props = { t: (key: TranslationKey) => string; token: string | null; onSupport: () => void; ageReviewPending: boolean };
type View = 'main' | 'deposit' | 'instructions' | 'withdraw' | 'submitted';

const providerLabel: Record<ProviderId, string> = { telebirr: 'Telebirr', ebirr: 'eBirr' };

function ProviderMark({ provider }: { provider: ProviderId }) {
  return <span className={`wallet-provider-mark ${provider}`} aria-hidden="true">{provider === 'telebirr' ? 'T' : 'e'}</span>;
}

function WalletIcon({ name }: { name: 'wallet' | 'deposit' | 'withdraw' | 'copy' | 'upload' | 'phone' | 'receipt' | 'person' | 'back' }) {
  const common = { width: 23, height: 23, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths = {
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h2"/><path d="M6 5V3h12v2"/></>,
    deposit: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M5 14v5h14v-5"/></>,
    withdraw: <><path d="M12 8v12m0 0 5-5m-5 5-5-5"/><path d="M5 10V5h14v5"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    upload: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m21 15-5-5L5 20"/></>,
    phone: <><path d="M7 3H5a2 2 0 0 0-2 2c0 8.8 7.2 16 16 16a2 2 0 0 0 2-2v-2l-5-2-2 3a14 14 0 0 1-7-7l3-2-3-5Z"/></>,
    receipt: <><path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Z"/><path d="M8 8h8M8 12h8M8 16h4"/></>,
    person: <><circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/></>,
    back: <><path d="m14 5-7 7 7 7M7 12h13"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function statusCopy(status: string): string {
  if (status === 'pending') return 'Pending verification';
  if (status === 'needs_info') return 'More information needed';
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Not approved';
  if (status === 'reviewing') return 'Under review';
  if (status === 'paid') return 'Completed';
  return status;
}

export default function WalletApp({ t, token, onSupport, ageReviewPending }: Props) {
  const [view, setView] = useState<View>('main');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [requests, setRequests] = useState<RequestData>({ deposits: [], withdrawals: [] });
  const [balance, setBalance] = useState<number | null>(null);
  const [moneyEnabled, setMoneyEnabled] = useState(false);
  const [simulationOnly, setSimulationOnly] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [ageReference, setAgeReference] = useState('');
  const [confirmsAdult, setConfirmsAdult] = useState(false);
  const [ageSubmitted, setAgeSubmitted] = useState(false);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [amount, setAmount] = useState(100);
  const [customAmount, setCustomAmount] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [senderPhone, setSenderPhone] = useState('');
  const [transactionReference, setTransactionReference] = useState('');
  const [proofMethod, setProofMethod] = useState<DepositProof>('receipt');
  const [confirmationSms, setConfirmationSms] = useState('');
  const [receipt, setReceipt] = useState<{ file: File; data: string } | null>(null);
  const [destinationPhone, setDestinationPhone] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState('');
  const [submittedKind, setSubmittedKind] = useState<'deposit' | 'withdrawal'>('deposit');
  const [submittedSimulation, setSubmittedSimulation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoMessage, setPromoMessage] = useState('');
  const idempotencyKey = useRef(crypto.randomUUID());
  const selectedProvider = useMemo(() => providers.find((item) => item.provider === provider && item.enabled) || null, [provider, providers]);
  const requestAmount = useCustom ? Number(customAmount) : amount;

  const refresh = async () => {
    const settingResponse = await fetch('/api/wallet/settings').catch(() => null);
    if (settingResponse?.ok) {
      const data = await settingResponse.json() as { providers?: Provider[]; moneyEnabled?: boolean; simulationOnly?: boolean };
      setProviders(data.providers || []);
      setMoneyEnabled(data.moneyEnabled === true);
      setSimulationOnly(data.simulationOnly === true);
    }
    if (!token) { setRequests({ deposits: [], withdrawals: [] }); setBalance(null); setWalletError('Sign in to use your wallet.'); return; }
    const [requestResponse, balanceResponse] = await Promise.all([
      fetch('/api/wallet/requests', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
      fetch('/api/wallet/balance', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
    ]);
    if (requestResponse?.ok) setRequests(await requestResponse.json() as RequestData);
    const data = balanceResponse ? await balanceResponse.json().catch(() => ({})) as { balance?: number; enabled?: boolean; simulated?: boolean; error?: string } : {};
    setMoneyEnabled(data.enabled === true);
    setSimulationOnly(data.simulated === true);
    setWalletError(balanceResponse?.ok ? '' : data.error || 'Wallet status could not be loaded.');
    setBalance(balanceResponse?.ok && Number.isFinite(data.balance) ? data.balance as number : null);
  };

  useEffect(() => { void refresh(); }, [token]);

  const openDeposit = () => {
    if (!token || !moneyEnabled) { setMessage(walletError || 'Wallet deposits are not available.'); return; }
    setView('deposit'); setMessage(''); setProvider(null); setUseCustom(false); setCustomAmount('');
    setAmount(100);
  };
  const openWithdrawal = () => {
    if (!token || !moneyEnabled) { setMessage(walletError || 'Wallet withdrawals are not available.'); return; }
    setView('withdraw'); setMessage(''); setProvider(null); setAmount(100); setUseCustom(false); setCustomAmount('');
  };
  const continueToInstructions = () => {
    setMessage('');
    if (!selectedProvider) { setMessage('Choose an enabled payment method.'); return; }
    if (!Number.isSafeInteger(requestAmount) || requestAmount < selectedProvider.minimumAmount || requestAmount > selectedProvider.maximumAmount) {
      setMessage(`Enter a whole-birr amount from ${selectedProvider.minimumAmount} to ${selectedProvider.maximumAmount}.`); return;
    }
    setView('instructions');
  };

  const pickReceipt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      setMessage('Choose a PNG or JPG image up to 2 MB.'); event.target.value = ''; return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') { setReceipt({ file, data: reader.result }); setMessage(''); }
      else setMessage('That image could not be previewed.');
    };
    reader.onerror = () => setMessage('That image could not be previewed.');
    reader.readAsDataURL(file);
  };

  const submitDeposit = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    if (!token) { setMessage('Sign in through Telegram or your web account before sending a request.'); return; }
    if (!provider || !Number.isSafeInteger(requestAmount) || !senderPhone.trim() || transactionReference.trim().length < 5 || (proofMethod === 'receipt' ? !receipt : confirmationSms.trim().length < 8)) { setMessage(t('walletProofRequired')); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/wallet/deposits', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
        provider, amount: requestAmount, senderPhone, transactionReference, proofMethod,
        receiptData: proofMethod === 'receipt' ? receipt?.data || null : null,
        confirmationSms: proofMethod === 'sms' ? confirmationSms.trim() : null,
        idempotencyKey: idempotencyKey.current,
      }) });
      const data = await response.json() as { requestId?: string; status?: string; error?: string };
      if (!response.ok || !data.requestId) throw new Error(data.error || 'The request could not be sent.');
      idempotencyKey.current = crypto.randomUUID(); setRequestId(data.requestId); setSubmittedKind('deposit'); setSubmittedSimulation(simulationOnly); setView('submitted');
      setSenderPhone(''); setTransactionReference(''); setReceipt(null); setConfirmationSms(''); await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The request could not be sent.'); }
    finally { setBusy(false); }
  };

  const submitWithdrawal = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    if (!token) { setMessage('Sign in through Telegram or your web account before sending a request.'); return; }
    if (!provider || !Number.isSafeInteger(requestAmount) || !destinationPhone.trim() || accountHolderName.trim().length < 2 || (balance !== null && requestAmount > balance)) { setMessage('Check your amount, available balance, destination number and account name.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/wallet/withdrawals', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({
        provider, amount: requestAmount, destinationPhone, accountHolderName, idempotencyKey: idempotencyKey.current,
      }) });
      const data = await response.json() as { requestId?: string; status?: string; error?: string };
      if (!response.ok || !data.requestId) throw new Error(data.error || 'The request could not be sent.');
      idempotencyKey.current = crypto.randomUUID(); setRequestId(data.requestId); setSubmittedKind('withdrawal'); setSubmittedSimulation(simulationOnly); setView('submitted');
      setDestinationPhone(''); setAccountHolderName(''); await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'The request could not be sent.'); }
    finally { setBusy(false); }
  };

  const submitAgeReview = async (event: FormEvent) => {
    event.preventDefault(); setMessage('');
    if (!token || !confirmsAdult || ageReference.trim().length < 3) { setMessage('Confirm you are at least 18 and enter your age-check reference.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/account/age-verification', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirmsAdult, verificationReference: ageReference.trim() }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Age verification could not be submitted.');
      setAgeSubmitted(true); setAgeReference(''); setMessage('Your age-check reference was sent for administrator review.');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Age verification could not be submitted.'); }
    finally { setBusy(false); }
  };

  const applyPromoCode = async (event: FormEvent) => {
    event.preventDefault(); setPromoMessage('');
    if (!token) { setPromoMessage(t('walletPromoSignIn')); return; }
    try {
      const response = await fetch('/api/referrals/claim', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: promoCode }) });
      const data = await response.json() as { error?: string; bonusStatus?: 'credited' | 'pending_age' | 'withheld'; walletEnabled?: boolean };
      if (!response.ok) throw new Error(data.error || 'That promo code could not be applied.');
      setPromoMessage(data.bonusStatus === 'credited' ? data.walletEnabled ? t('walletPromoCredited') : t('walletPromoRecorded') : data.bonusStatus === 'withheld' ? t('walletPromoWithheld') : t('walletPromoPending')); setPromoCode('');
    } catch (cause) { setPromoMessage(cause instanceof Error ? cause.message : 'That promo code could not be applied.'); }
  };

  const backToMain = () => { setView('main'); setMessage(''); void refresh(); };
  const methodCards = (variant: 'deposit' | 'withdrawal') => <div className="wallet-method-grid" role="group" aria-label={"Payment method"}>
    {(['telebirr', 'ebirr'] as ProviderId[]).map((id) => {
      const item = providers.find((entry) => entry.provider === id);
      const enabled = item?.enabled === true;
      return <button key={id} type="button" className={`wallet-method-card ${provider === id ? 'selected' : ''} ${enabled ? '' : 'unavailable'}`} aria-pressed={provider === id} disabled={!enabled} onClick={() => { setProvider(id); setMessage(''); }}>
        <ProviderMark provider={id}/><strong>{providerLabel[id]}</strong><span className="wallet-method-check">{provider === id ? '●' : '○'}</span>{!enabled && <small>{t('unavailable')}</small>}
      </button>;
    })}
  </div>;

  const amountOptions = (label: string) => <fieldset className="wallet-amount-fieldset"><legend>{label}</legend><div className="wallet-amount-grid">{[50, 100, 200, 500].map((item) => <button key={item} type="button" className={`wallet-amount-button ${!useCustom && amount === item ? 'selected' : ''}`} aria-pressed={!useCustom && amount === item} onClick={() => { setAmount(item); setUseCustom(false); setMessage(''); }}><strong>{item}</strong><small>{t('etb')}</small></button>)}</div><button type="button" className={`wallet-custom-amount ${useCustom ? 'selected' : ''}`} aria-pressed={useCustom} onClick={() => { setUseCustom(true); setCustomAmount(''); }}><span aria-hidden="true">⌨</span>{t('marketCustom')}</button>{useCustom && <label className="wallet-field">Amount in whole Birr<input type="number" inputMode="numeric" min={selectedProvider?.minimumAmount || 50} max={selectedProvider?.maximumAmount || 10000} step="1" placeholder={`Enter amount (${t('etb')})`} value={customAmount} onChange={(event) => setCustomAmount(event.target.value)}/></label>}</fieldset>;

  if (view === 'submitted') return <section className="screen wallet-screen wallet-flow-screen"><div className="wallet-confirmation-mark">✓</div><span className="eyebrow">{submittedSimulation ? 'SIMULATED REQUEST' : 'REQUEST RECEIVED'}</span><h1>{submittedKind === 'deposit' ? 'Deposit request sent' : 'Withdrawal request sent'}</h1><p className="wallet-flow-copy">{submittedSimulation ? 'This is a test request. No real money was sent, credited, reserved or paid.' : submittedKind === 'deposit' ? t('walletDepositReview') : 'An administrator will review your request and send the payout manually. The request status will show when it is complete.'}</p><div className="wallet-confirmation-card"><span>Request ID</span><strong>{requestId}</strong><span className="demo-request-status pending">PENDING {submittedKind === 'deposit' ? 'VERIFICATION' : 'REVIEW'}</span></div><button className="primary-button wide" onClick={backToMain}>{t('wallet')}<span aria-hidden="true">→</span></button></section>;

  if (view === 'main') return <section className="screen wallet-screen wallet-redesign">
    <span className="eyebrow">{t('wallet')}</span><h1>{t('wallet')}</h1>
    <div className="wallet-hero-card"><div className="wallet-card-top"><div><span>{t('walletTitle')}</span><small>{simulationOnly ? 'SIMULATED TEST BALANCE' : t('demoCredits')}</small></div><span className="wallet-hero-icon"><WalletIcon name="wallet"/></span></div><strong>{balance === null ? 'Unavailable' : balance.toLocaleString()}</strong><span className="wallet-credit-unit">{t('etb')}</span><span className="wallet-practice-badge">{simulationOnly ? 'SIMULATION' : moneyEnabled ? 'AVAILABLE' : 'LOCKED'}</span></div>
    <div className="wallet-action-grid"><button className="wallet-action-card primary" disabled={!token || !moneyEnabled} onClick={openDeposit}><WalletIcon name="deposit"/><strong>{t('deposit')}</strong></button><button className="wallet-action-card" disabled={!token || !moneyEnabled} onClick={openWithdrawal}><WalletIcon name="withdraw"/><strong>{t('withdraw')}</strong></button></div>
    {simulationOnly && <div className="wallet-simulation-note" role="status"><strong>Simulation only</strong><span>Requests and balances here are test data. Do not transfer money; real wallet credit and payouts remain authorization-gated.</span></div>}
    {!moneyEnabled && !simulationOnly && <div className="wallet-preview-warning"><span>!</span><p><strong>Money features are locked.</strong> They open only after required approvals are recorded. Do not send money unless active account details are shown here.</p></div>}
    {walletError.includes('age check') && !ageSubmitted && !ageReviewPending && <form className="wallet-request-form" onSubmit={(event) => void submitAgeReview(event)}><h2>Verify your age</h2><p>Wallet and paid rooms require an approved 18+ check.</p><label className="wallet-field">Age-check reference<input required minLength={3} maxLength={240} value={ageReference} onChange={(event) => setAgeReference(event.target.value)} placeholder="Reference from your age check"/></label><label><input type="checkbox" checked={confirmsAdult} onChange={(event) => setConfirmsAdult(event.target.checked)}/> I confirm I am at least 18 years old.</label>{message && <p className="wallet-form-message" role="status">{message}</p>}<button className="secondary-button" type="submit" disabled={busy || !confirmsAdult}>{busy ? 'Sending…' : 'Submit for age review'}</button></form>}
    {walletError.includes('age check') && ageReviewPending && <p className="wallet-form-message" role="status">{t('ageGatePending')}</p>}
    {ageSubmitted && <p className="wallet-form-message" role="status">Age verification request sent. Money features remain locked until an administrator approves it.</p>}
    <form className="wallet-promo-inline" onSubmit={(event) => void applyPromoCode(event)}><label htmlFor="wallet-promo-code">Have an agent promo code?</label><div><input id="wallet-promo-code" autoCapitalize="characters" maxLength={16} value={promoCode} onChange={(event) => setPromoCode(event.target.value.toUpperCase())} placeholder="Enter promo code"/><button type="submit" disabled={!promoCode.trim()}>Apply</button></div>{promoMessage && <small role="status">{promoMessage}</small>}</form>
    <div className="wallet-request-history"><div className="wallet-section-heading"><div><span className="eyebrow">ACTIVITY</span><h2>Your requests</h2></div><button className="text-button" onClick={() => void refresh()}>Refresh ↻</button></div>
      {!token ? <p className="wallet-history-empty">Sign in to see your balance and payment request status.</p> : [...requests.deposits, ...requests.withdrawals].sort((a, b) => b.created_at.localeCompare(a.created_at)).length ? [...requests.deposits.map((item) => ({ ...item, kind: 'Deposit' })), ...requests.withdrawals.map((item) => ({ ...item, kind: 'Withdrawal' }))].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8).map((item) => <article className="wallet-history-row" key={item.id}><span className={`wallet-history-icon ${item.kind.toLowerCase()}`}><WalletIcon name={item.kind === 'Deposit' ? 'deposit' : 'withdraw'}/></span><div><strong>{item.kind} · {providerLabel[item.provider]}</strong><small>{item.id} · {new Date(item.created_at).toLocaleDateString()}</small>{item.review_reason && <small className="wallet-review-note">{item.review_reason}</small>}</div><div className="wallet-history-side"><strong>{item.amount} {t('etb')}</strong><span className={`demo-request-status ${item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'declined' : 'pending'}`}>{statusCopy(item.status)}</span></div></article>) : <p className="wallet-history-empty">No requests yet. Deposit and withdrawal requests will appear here.</p>}
    </div><button className="text-button wallet-help" onClick={onSupport}>{t('support')}<span>›</span></button>
  </section>;

  if (view === 'deposit') return <section className="screen wallet-screen wallet-flow-screen"><div className="wallet-flow-header"><button className="wallet-back" onClick={backToMain} aria-label="Back"><WalletIcon name="back"/></button><h1>{t('deposit')}</h1><span className="wallet-home-mark" aria-hidden="true">⌂</span></div>{simulationOnly && <div className="wallet-simulation-note"><strong>Simulation only</strong><span>Do not send money. Admin approvals credit only a separate test balance.</span></div>}<p className="wallet-choice-title">Choose a payment method</p>{methodCards('deposit')}{amountOptions(t('marketEntryAmount'))}
    <div className="wallet-preview-warning compact"><span aria-hidden="true">i</span><p>{t('walletDepositProofHint')}</p></div>{message && <p className="wallet-form-message" role="alert">{message}</p>}<button className="primary-button wide" disabled={!moneyEnabled || !selectedProvider || !Number.isSafeInteger(requestAmount)} onClick={continueToInstructions}>{t('continue')}<span aria-hidden="true">→</span></button>
  </section>;

  if (view === 'instructions') return <section className="screen wallet-screen wallet-flow-screen"><div className="wallet-flow-header"><button className="wallet-back" onClick={() => setView('deposit')} aria-label="Back"><WalletIcon name="back"/></button><h1>{simulationOnly ? 'Test with ' : 'Pay with '}{provider ? providerLabel[provider] : 'Telebirr'}</h1><span className="wallet-home-mark" aria-hidden="true">⌂</span></div>
    {provider && <div className="wallet-provider-tabs">{(['telebirr', 'ebirr'] as ProviderId[]).map((id) => <button type="button" key={id} className={provider === id ? 'selected' : ''} disabled={!providers.find((entry) => entry.provider === id)?.enabled} onClick={() => { setProvider(id); setMessage(''); }}><ProviderMark provider={id}/><span>{providerLabel[id]}</span></button>)}</div>}
    <div className="wallet-receiving-card"><span className="wallet-receiving-label">{simulationOnly ? 'CONFIGURED ACCOUNT · DISPLAY ONLY' : 'DIRE BET RECEIVING ACCOUNT'}</span><strong>{selectedProvider?.accountNumber || 'Not configured'}</strong><button type="button" className="wallet-copy-number" onClick={() => void navigator.clipboard.writeText(selectedProvider?.accountNumber || '').then(() => setMessage('Number copied.')).catch(() => setMessage('Select the number to copy it.'))} disabled={!selectedProvider?.accountNumber}><WalletIcon name="copy"/>Copy number</button>{selectedProvider?.accountLabel && <small>{selectedProvider.accountLabel}</small>}<div className="wallet-receiving-amount"><span>{simulationOnly ? 'Test amount' : 'Send exactly'}</span><strong>{requestAmount} {t('etb')}</strong></div></div>
    <div className="wallet-instructions"><strong>{simulationOnly ? 'Simulation steps' : 'Deposit steps'}</strong>{simulationOnly && <p>Do not transfer money. Use a sample receipt and reference to test administrator review.</p>}<ol>{simulationOnly ? <><li>Choose the configured Telebirr or eBirr option.</li><li>Enter any test reference and attach a sample receipt or SMS.</li><li>An administrator can approve or reject this simulated request.</li></> : <><li>Send the exact amount to this account.</li><li>Enter your sender number and transaction reference.</li><li>Choose either the receipt photo or confirmation SMS below.</li><li>An administrator checks the payment and approves or rejects it.</li></>}</ol></div>
    <form className="wallet-request-form" onSubmit={(event) => void submitDeposit(event)}><label className="wallet-field">Sender phone number<input type="tel" inputMode="tel" autoComplete="tel" placeholder="09XX XXX XXX" maxLength={24} required value={senderPhone} onChange={(event) => setSenderPhone(event.target.value)}/></label><label className="wallet-field">Transaction reference<input autoComplete="off" minLength={5} maxLength={80} placeholder="Transaction reference" required value={transactionReference} onChange={(event) => setTransactionReference(event.target.value)}/></label>
      <fieldset className="wallet-proof-choice"><legend>{t('walletProofChoice')}</legend><div><button type="button" aria-pressed={proofMethod === 'receipt'} className={proofMethod === 'receipt' ? 'selected' : ''} onClick={() => { setProofMethod('receipt'); setConfirmationSms(''); }}>{t('walletProofReceipt')}</button><button type="button" aria-pressed={proofMethod === 'sms'} className={proofMethod === 'sms' ? 'selected' : ''} onClick={() => { setProofMethod('sms'); setReceipt(null); }}>{t('walletProofSms')}</button></div></fieldset>
      {proofMethod === 'receipt' ? <><label className="wallet-receipt-upload"><input type="file" accept="image/png,image/jpeg" required onChange={(event) => void pickReceipt(event)}/><WalletIcon name="upload"/><span>{receipt ? receipt.file.name : 'Upload payment receipt'}</span><small>PNG or JPG · max 2 MB</small></label>{receipt && <div className="wallet-receipt-preview"><img src={receipt.data} alt="Payment receipt preview"/><div><strong>{receipt.file.name}</strong><small>{(receipt.file.size / 1024).toFixed(0)} KB</small></div><button type="button" onClick={() => setReceipt(null)}>Remove</button></div>}</> : <label className="wallet-field">{t('walletProofSmsLabel')}<textarea required minLength={8} maxLength={1000} rows={4} value={confirmationSms} onChange={(event) => setConfirmationSms(event.target.value)} placeholder={t('walletProofSmsPlaceholder')}/></label>}
      <p className="wallet-pin-warning">♢ Never share your PIN or OTP.</p>{message && <p className="wallet-form-message" role="alert">{message}</p>}<button className="primary-button wide" type="submit" disabled={busy || !selectedProvider || (proofMethod === 'receipt' ? !receipt : confirmationSms.trim().length < 8)}>{busy ? 'Sending request…' : simulationOnly ? 'Submit simulation request' : 'Submit for verification'}<span aria-hidden="true">→</span></button>
    </form>
  </section>;

  return <section className="screen wallet-screen wallet-flow-screen"><div className="wallet-flow-header"><button className="wallet-back" onClick={backToMain} aria-label="Back"><WalletIcon name="back"/></button><h1>{t('withdraw')}</h1><span className="wallet-home-mark" aria-hidden="true">⌂</span></div>{simulationOnly && <div className="wallet-simulation-note"><strong>Simulation only</strong><span>Withdrawal holds use a separate test balance. No payout will be sent.</span></div>}<p className="wallet-choice-title">Choose a payment method</p>{methodCards('withdrawal')}
    <form className="wallet-request-form" onSubmit={(event) => void submitWithdrawal(event)}>{amountOptions(`Amount in ${t('etb')}`)}<label className="wallet-field">Your Telebirr/eBirr number<input type="tel" inputMode="tel" autoComplete="tel" placeholder="09XX XXX XXX" maxLength={24} required value={destinationPhone} onChange={(event) => setDestinationPhone(event.target.value)}/></label><label className="wallet-field">Account holder name<input autoComplete="name" maxLength={100} placeholder="Enter account name" required value={accountHolderName} onChange={(event) => setAccountHolderName(event.target.value)}/></label>{message && <p className="wallet-form-message" role="alert">{message}</p>}<button className="primary-button wide" type="submit" disabled={busy || !selectedProvider || (balance !== null && requestAmount > balance)}>{busy ? 'Sending request…' : 'Submit withdrawal request'}<span>→</span></button><div className="wallet-preview-warning compact"><span>i</span><p>{simulationOnly ? 'The test balance is reserved until review. Rejection restores it. Marking a request complete records a test action only; no transfer occurs.' : 'Your amount is reserved while an administrator reviews the request. Funds return to your wallet if the request is rejected. An approved payout is sent manually and marked complete here.'}</p></div></form>
  </section>;
}
