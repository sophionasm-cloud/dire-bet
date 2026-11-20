import { useEffect, useState } from 'react';
import { PUBLIC_GAMES } from '@dire-bet/shared';
import AgentManagement from './AgentManagement';
import PaymentManagement from './PaymentManagement';
import RoomManagement from './RoomManagement';

type Section = 'overview' | 'games' | 'rooms' | 'payments' | 'agents';
const labels: Record<Section, string> = { overview: 'Overview', games: 'Games', rooms: 'Rooms & money', payments: 'Payments', agents: 'Agents' };

export default function AdminApp({ sessionToken }: { sessionToken: string | null }) {
  const [serverAdmin, setServerAdmin] = useState(false);
  const [checking, setChecking] = useState(Boolean(sessionToken));
  const [accessMessage, setAccessMessage] = useState('Sign in with the configured Super Admin Telegram account.');
  const [moneyActive, setMoneyActive] = useState(false);
  const [section, setSection] = useState<Section>('overview');

  useEffect(() => {
    if (!sessionToken) { setChecking(false); setServerAdmin(false); return; }
    let live = true;
    setChecking(true);
    fetch('/api/admin/identity', { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (response) => {
        const identity = await response.json() as { error?: string };
        if (!response.ok) throw new Error(identity.error || 'This account is not the configured Super Admin.');
        const activationResponse = await fetch('/api/admin/activation', { headers: { Authorization: `Bearer ${sessionToken}` } });
        const activation = await activationResponse.json() as { active?: boolean };
        if (live) { setServerAdmin(true); setMoneyActive(activation.active === true); setAccessMessage(''); }
      })
      .catch((cause) => { if (live) { setServerAdmin(false); setAccessMessage(cause instanceof Error ? cause.message : 'Owner access is not configured.'); } })
      .finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [sessionToken]);

  if (checking) return <main className="staff-shell"><div className="room-admin-state">Checking administrator access…</div></main>;
  if (!serverAdmin) return <main className="staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">ADMIN ACCESS</span><a className="staff-back" href="/">Back to games ↗</a></header><section className="demo-staff-gate"><span className="staff-label">DIRE BET · SUPER ADMIN</span><h1>Administrator access required</h1><p>{accessMessage}</p><div className="staff-callout"><strong>Owner tools are protected</strong><p>Sign in with the Super Admin Telegram account configured for this deployment.</p><a className="text-button" href="/?page=login&amp;next=%2Fadmin">Sign in ↗</a></div></section></main>;

  return <main className="staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">SUPER ADMIN</span><a className="staff-back" href="/">Player app ↗</a></header><div className="staff-layout"><aside className="staff-sidebar"><span className="staff-label">OWNER DASHBOARD</span>{(Object.keys(labels) as Section[]).map((item, index) => <button key={item} className={section === item ? 'selected' : ''} onClick={() => setSection(item)}><span className="staff-nav-icon">{String(index + 1).padStart(2, '0')}</span>{labels[item]}</button>)}<div className="staff-sidebar-note">Telegram owner access<br/>Money gate {moneyActive ? 'active' : 'locked'}</div></aside><section className="staff-content">
    <div className="staff-heading"><div><span className="staff-label">DIRE BET · SUPER ADMIN</span><h1>{labels[section]}</h1><p>Owner actions are authenticated and recorded.</p></div><span className="staff-lock">OWNER</span></div>
    {section === 'overview' && <><div className="demo-admin-metrics"><article><span>Games</span><strong>{PUBLIC_GAMES.filter((game) => game.availability === 'playable').length}</strong><small>Practice and multiplayer</small></article><article><span>Money gate</span><strong>{moneyActive ? 'Active' : 'Locked'}</strong><small>{moneyActive ? 'Approval evidence and production settings pass' : 'Approval evidence or production settings are missing'}</small></article></div><section className="staff-callout"><strong>{moneyActive ? 'Money features are enabled' : 'Money features remain locked'}</strong><p>{moneyActive ? 'Review payment requests and room activity in their sections.' : 'Record the required legal, license, age, privacy and payment-provider evidence in Payments. Production settings must also be enabled before funds can move.'}</p><a className="secondary-button" href="/?page=wallet">Open player wallet ↗</a></section></>}
    {section === 'games' && <div className="demo-game-list">{PUBLIC_GAMES.filter((game) => game.availability === 'playable').map((game) => <article key={game.id}><span className={`demo-game-mark ${game.id}`}>{game.id === 'poker' ? '♠' : game.id === 'ludo' ? '⚄' : game.id === 'checkers' ? '♛' : '×'}</span><div><strong>{game.title}</strong><small>Free practice and multiplayer · paid entries require approval</small></div><b>AVAILABLE</b></article>)}</div>}
    {section === 'rooms' && <RoomManagement token={sessionToken}/>}
    {section === 'payments' && <PaymentManagement token={sessionToken}/>}
    {section === 'agents' && <AgentManagement token={sessionToken}/>}
    </section></div></main>;
}
