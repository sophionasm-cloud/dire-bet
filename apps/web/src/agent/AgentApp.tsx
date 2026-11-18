import { useEffect, useState } from 'react';

type Week = { weekStart: string; simulatedCommissionCredits: number; referredNetLossCredits: number; referredPlayers: number };
type Referral = { name: string; joinedAt: string; completedMatches: number };
type Dashboard = { agent: { code: string; status: string; commissionRate: number; basis: string }; shareLink: string; weeks: Week[]; referrals: Referral[] };

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

  const currentWeek = data?.weeks[0];
  return <main className="staff-shell demo-staff-shell agent-dashboard-shell">
    <header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">AGENT · DEMO REPORT</span><a className="staff-back" href="/">Back to games ↗</a></header>
    <section className="agent-dashboard-page">
      <div className="staff-heading"><div><span className="staff-label">DIRE BET · AGENT</span><h1>Agent dashboard</h1><p>See referred accounts and the weekly demo-credit report for your code.</p></div><span className="staff-lock demo-lock">SIMULATED</span></div>
      {loading && <div className="room-admin-state">Loading your agent report…</div>}
      {!loading && error && <div className="agent-access-state" role="status"><span className="staff-label">AGENT ACCESS</span><h2>{error.includes('not an active agent') || error.includes('suspended') ? 'This account has no active agent access' : 'Sign-in required'}</h2><p>{error.includes('not an active agent') || error.includes('suspended') ? 'Ask the Dire Bet owner to add your Telegram user ID or reactivate your code. Then sign in again with that same Telegram account.' : error}</p>{!token && <a className="primary-button" href="/?page=login&next=%2Fagent">Sign in to DIRE BET <span>→</span></a>}</div>}
      {!loading && data && <>
        <div className="agent-code-card"><div><span className="staff-label">YOUR PROMO CODE</span><strong>{data.agent.code}</strong><p>Users can open your Telegram invite or enter this code in Wallet.</p></div><button className="primary-button" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy invite link'}<span>{copied ? '✓' : '↗'}</span></button><label>Invite link<input readOnly value={data.shareLink} onFocus={(event) => event.currentTarget.select()}/></label></div>
        <div className="demo-admin-metrics agent-metrics"><article><span>Latest eligible week’s loss</span><strong>{(currentWeek?.referredNetLossCredits || 0).toLocaleString()} credits</strong><small>Completed demo matches only</small></article><article><span>5% simulated share</span><strong>{(currentWeek?.simulatedCommissionCredits || 0).toLocaleString()} credits</strong><small>No cash value or payout</small></article><article><span>Referred accounts</span><strong>{data.referrals.length}</strong><small>Linked to this promo code</small></article></div>
        <div className="agent-commission-explainer"><span className="staff-label">HOW THE WEEKLY REPORT WORKS</span><strong>5% of positive net demo-credit losses, calculated per referred player</strong><p>A player’s completed public demo-match entries minus demo payouts are added for the week. Only a positive net loss is used. The report is simulated and does not create money owed.</p></div>
        <section className="agent-report-section"><div className="agent-list-heading"><div><span className="staff-label">WEEKLY REPORT</span><p>Weeks begin Monday in Addis Ababa time.</p></div></div>{data.weeks.length ? <div className="agent-week-list">{data.weeks.map((week) => <article key={week.weekStart}><div><strong>Week of {new Date(`${week.weekStart}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC' })}</strong><small>{week.referredPlayers} referred players with a positive net loss</small></div><span><small>Net demo loss</small><strong>{week.referredNetLossCredits.toLocaleString()}</strong></span><span><small>5% simulated</small><strong>{week.simulatedCommissionCredits.toLocaleString()}</strong></span></article>)}</div> : <div className="room-admin-state">No completed, eligible demo matches for this code yet.</div>}</section>
        <section className="agent-report-section"><div className="agent-list-heading"><div><span className="staff-label">REFERRED ACCOUNTS</span><p>Names are limited to what players have chosen to share.</p></div></div>{data.referrals.length ? <div className="agent-referral-list">{data.referrals.map((referral, index) => <article key={`${referral.joinedAt}-${index}`}><span className="agent-avatar">{referral.name.slice(0, 1).toUpperCase()}</span><div><strong>{referral.name}</strong><small>Joined {new Date(referral.joinedAt).toLocaleDateString()}</small></div><span>{referral.completedMatches} matches</span></article>)}</div> : <div className="room-admin-state">No one has joined through your promo code yet.</div>}</section>
      </>}
      <p className="agent-demo-footer">Test Mode · No real deposits, commissions, or withdrawals are active.</p>
    </section>
  </main>;
}
