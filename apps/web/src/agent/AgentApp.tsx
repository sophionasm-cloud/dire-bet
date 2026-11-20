import { useEffect, useState } from 'react';

type Referral = { name: string; joinedAt: string };
type Dashboard = { agent: { code: string; status: string }; shareLink: string; referrals: Referral[] };

export default function AgentApp({ token }: { token: string | null }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) { setLoading(false); setData(null); setError('Sign in to DIRE BET with the Telegram account assigned to your agent code.'); return; }
    let live = true;
    setLoading(true); setError('');
    fetch('/api/agent/dashboard', { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const result = await response.json() as Dashboard & { error?: string };
        if (!response.ok) throw new Error(result.error || 'Agent dashboard could not be loaded.');
        return result;
      })
      .then((result) => { if (live) setData(result); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : 'Agent dashboard could not be loaded.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [token]);

  const copyLink = async () => {
    if (!data) return;
    try { await navigator.clipboard.writeText(data.shareLink); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setError('Could not copy the invite link. Copy it from the field below.'); }
  };

  return <main className="staff-shell demo-staff-shell agent-dashboard-shell">
    <header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">AGENT · REFERRALS</span><a className="staff-back" href="/">Back to games ↗</a></header>
    <section className="agent-dashboard-page">
      <div className="staff-heading"><div><span className="staff-label">DIRE BET · AGENT</span><h1>Agent dashboard</h1><p>See accounts referred with your promo code.</p></div></div>
      {loading && <div className="room-admin-state">Loading your agent report…</div>}
      {!loading && error && <div className="agent-access-state" role="status"><span className="staff-label">AGENT ACCESS</span><h2>{error.includes('not an active agent') || error.includes('suspended') ? 'This account has no active agent access' : 'Sign-in required'}</h2><p>{error.includes('not an active agent') || error.includes('suspended') ? 'Ask the Dire Bet owner to add your Telegram user ID or reactivate your code. Then sign in again with that same Telegram account.' : error}</p>{!token && <a className="primary-button" href="/?page=login&next=%2Fagent">Sign in to DIRE BET <span>→</span></a>}</div>}
      {!loading && data && <>
        <div className="agent-code-card"><div><span className="staff-label">YOUR PROMO CODE</span><strong>{data.agent.code}</strong><p>Users can open your Telegram invite or enter this code in Wallet.</p></div><button className="primary-button" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy invite link'}<span>{copied ? '✓' : '↗'}</span></button><label>Invite link<input readOnly value={data.shareLink} onFocus={(event) => event.currentTarget.select()}/></label></div>
        <div className="agent-commission-explainer"><span className="staff-label">REFERRAL TRACKING</span><strong>Promo codes track referral attribution only.</strong><p>No cash commission or agent payout is enabled.</p></div>
        <div className="demo-admin-metrics agent-metrics"><article><span>Referred accounts</span><strong>{data.referrals.length}</strong><small>Linked to this promo code</small></article></div>
        <section className="agent-report-section"><div className="agent-list-heading"><div><span className="staff-label">REFERRED ACCOUNTS</span><p>Names are limited to what players have chosen to share.</p></div></div>{data.referrals.length ? <div className="agent-referral-list">{data.referrals.map((referral, index) => <article key={`${referral.joinedAt}-${index}`}><span className="agent-avatar">{referral.name.slice(0, 1).toUpperCase()}</span><div><strong>{referral.name}</strong><small>Joined {new Date(referral.joinedAt).toLocaleDateString()}</small></div></article>)}</div> : <div className="room-admin-state">No one has joined through your promo code yet.</div>}</section>
      </>}
      <p className="agent-demo-footer">Referrals are for attribution only. No agent commission is enabled.</p>
    </section>
  </main>;
}
