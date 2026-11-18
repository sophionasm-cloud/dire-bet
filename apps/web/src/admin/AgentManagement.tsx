import { useCallback, useEffect, useState, type FormEvent } from 'react';

type Agent = { id: string; userId: number | null; telegramId: number | null; name: string; code: string; status: 'active' | 'suspended' | 'revoked' | string; referrals: number; createdAt: string; commissionRate: number; commissionBasis: string };
type Props = { token: string | null };
type ErrorBody = { error?: string };

export default function AgentManagement({ token }: Props) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [telegramId, setTelegramId] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!token) { setLoading(false); setError('Sign in with the Super Admin Telegram account.'); return; }
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/admin/agents', { headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json() as { agents?: Agent[]; error?: string };
      if (!response.ok) throw new Error(result.error || 'Agent accounts could not be loaded.');
      setAgents(result.agents || []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Agent accounts could not be loaded.'); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    if (!token || !/^\d{5,15}$/.test(telegramId.trim())) { setError('Enter the agent’s numeric Telegram user ID.'); return; }
    setBusyId('new');
    try {
      const response = await fetch('/api/admin/agents', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ telegramId: Number(telegramId), code: code.trim() || undefined }) });
      const result = await response.json() as { agent?: { code: string }; error?: string };
      if (!response.ok || !result.agent) throw new Error(result.error || 'The agent could not be added.');
      setNotice(`Agent added with promo code ${result.agent.code}.`); setTelegramId(''); setCode(''); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The agent could not be added.'); }
    finally { setBusyId(''); }
  };

  const setStatus = async (agent: Agent, status: 'active' | 'suspended' | 'revoked') => {
    if (!token) return;
    const action = status === 'revoked' ? 'revoke this agent and disable their promo code' : status === 'suspended' ? 'suspend this agent and disable their promo code' : 'reactivate this agent';
    if (!window.confirm(`Are you sure you want to ${action}?`)) return;
    setBusyId(agent.id); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/agents/${encodeURIComponent(agent.id)}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
      const result = await response.json() as ErrorBody;
      if (!response.ok) throw new Error(result.error || 'The agent status could not be changed.');
      setNotice(status === 'revoked' ? 'Agent access revoked. The record is kept for the audit history.' : `Agent ${status}.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The agent status could not be changed.'); }
    finally { setBusyId(''); }
  };

  return <section className="agent-management">
    <div className="agent-commission-explainer"><span className="staff-label">WEEKLY REFERRAL RULE · DEMO ONLY</span><strong>5% of each referred player’s positive net demo-credit loss for the week</strong><p>Net loss is calculated from completed public demo matches attributed to an agent code. This creates no cash commission and no payable balance.</p></div>
    {error && <p className="room-admin-error" role="alert">{error}</p>}{notice && <p className="room-admin-notice" role="status">{notice}</p>}
    <form className="agent-create-form" onSubmit={(event) => void create(event)}><div><span className="staff-label">ADD AGENT</span><h2>Assign an existing DIRE BET account</h2><p>The agent must open the app once first. Use their Telegram user ID from @userinfobot.</p></div><label>Telegram user ID<input value={telegramId} inputMode="numeric" maxLength={15} placeholder="Digits only" onChange={(event) => setTelegramId(event.target.value.replace(/\D/g, ''))}/></label><label>Promo code <small>optional</small><input value={code} maxLength={16} placeholder="Auto-generate if blank" onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}/></label><button className="primary-button" type="submit" disabled={busyId === 'new'}>{busyId === 'new' ? 'Adding…' : 'Create promo code'}</button></form>
    <div className="agent-list-heading"><div><span className="staff-label">AGENT ACCOUNTS</span><p>{agents.length} records · active, suspended and revoked</p></div><button className="staff-link-button" onClick={() => void load()}>Refresh</button></div>
    {loading ? <div className="room-admin-state">Loading agents…</div> : agents.length === 0 ? <div className="room-admin-state">No agents added yet.</div> : <div className="agent-admin-list">{agents.map((agent) => <article key={agent.id} className="agent-admin-card">
      <div className="agent-admin-main"><div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div><div><h3>{agent.name}</h3><p>Telegram ID: {agent.telegramId ?? 'not linked'} · {agent.referrals} referred accounts</p><code>{agent.code}</code></div><span className={`room-admin-status ${agent.status}`}>{agent.status}</span></div>
      <div className="agent-admin-meta"><span>5% weekly share of referred players’ net demo-credit losses</span><a href={`https://t.me/Dire_Bet_bot?start=agent_${encodeURIComponent(agent.code)}`} target="_blank" rel="noreferrer">Open invite ↗</a></div>
      <div className="agent-admin-actions">{agent.status === 'active' && <button className="secondary-button" disabled={busyId === agent.id} onClick={() => void setStatus(agent, 'suspended')}>Suspend</button>}{agent.status === 'suspended' && <button className="secondary-button" disabled={busyId === agent.id} onClick={() => void setStatus(agent, 'active')}>Reactivate</button>}{agent.status !== 'revoked' && <button className="agent-revoke-button" disabled={busyId === agent.id} onClick={() => void setStatus(agent, 'revoked')}>Revoke access</button>}</div>
    </article>)}</div>}
  </section>;
}
