import { useEffect, useState, type FormEvent } from 'react';
import { PUBLIC_GAMES } from '@dire-bet/shared';
import { DEMO_ADMIN_KEY, demoPasswordHash, generateDemoPassword } from '../staff/demo';
import AgentManagement from './AgentManagement';
import PaymentManagement from './PaymentManagement';
import RoomManagement from './RoomManagement';

type DemoAdminCredentials = { username: string; salt: string; passwordHash: string };
type Section = 'overview' | 'games' | 'rooms' | 'payments' | 'agents';
const labels: Record<Section, string> = { overview: 'Overview', games: 'Games', rooms: 'Rooms & commissions', payments: 'Payments', agents: 'Agents' };

function readCredentials(): DemoAdminCredentials | null {
  try { return JSON.parse(localStorage.getItem(DEMO_ADMIN_KEY) || 'null') as DemoAdminCredentials | null; }
  catch { return null; }
}

export default function AdminApp({ sessionToken }: { sessionToken: string | null }) {
  const [credentials, setCredentials] = useState<DemoAdminCredentials | null>(readCredentials);
  const [loggedIn, setLoggedIn] = useState(false);
  const [serverAdmin, setServerAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(Boolean(sessionToken));
  const [adminAccessMessage, setAdminAccessMessage] = useState('');
  const [username, setUsername] = useState('demo-admin');
  const [password, setPassword] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState(() => readCredentials() ? '' : generateDemoPassword());
  const [section, setSection] = useState<Section>('overview');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!sessionToken) { setCheckingAdmin(false); setServerAdmin(false); setAdminAccessMessage(''); return; }
    let live = true;
    setCheckingAdmin(true);
    fetch('/api/admin/identity', { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (response) => {
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || 'This account is not the configured Super Admin.');
        if (live) { setServerAdmin(true); setAdminAccessMessage(''); }
      })
      .catch((cause) => { if (live) { setServerAdmin(false); setAdminAccessMessage(cause instanceof Error ? cause.message : 'Owner access is not configured.'); } })
      .finally(() => { if (live) setCheckingAdmin(false); });
    return () => { live = false; };
  }, [sessionToken]);

  const setup = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const salt = crypto.randomUUID();
    const item: DemoAdminCredentials = { username: 'demo-admin', salt, passwordHash: await demoPasswordHash(generatedPassword, salt) };
    localStorage.setItem(DEMO_ADMIN_KEY, JSON.stringify(item));
    setCredentials(item); setLoggedIn(true); setNotice('Save this browser-preview password now. It cannot be recovered after leaving this page.');
  };

  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!credentials || username !== credentials.username || await demoPasswordHash(password, credentials.salt) !== credentials.passwordHash) {
      setError('Username or password did not match.'); return;
    }
    setPassword(''); setLoggedIn(true); setNotice('');
  };

  if (checkingAdmin && sessionToken) return <main className="staff-shell demo-staff-shell"><div className="room-admin-state">Checking owner access…</div></main>;

  if (!serverAdmin && (!credentials || !loggedIn)) return <main className="staff-shell demo-staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">LOCAL PREVIEW</span><a className="staff-back" href="/">Back to games ↗</a></header><section className="demo-staff-gate"><span className="staff-label">DIRE BET · ADMIN PREVIEW</span><h1>{credentials ? 'Admin preview sign-in' : 'Create this browser’s demo admin login'}</h1><p>This password unlocks a local preview on this device only. The real admin dashboard signs in through the owner’s Telegram account.</p>
    {adminAccessMessage && <div className="staff-callout admin-access-callout"><strong>Owner tools are locked</strong><p>{adminAccessMessage}</p><p>9041274256 is the bot ID, so it must not be used as the owner account. Use your personal Telegram ID from @userinfobot and set it as SUPER_ADMIN_TELEGRAM_ID in Cloudflare after you have it.</p></div>}
    {!credentials ? <form className="demo-staff-form" onSubmit={(event) => void setup(event)}><label>Preview username<input value="demo-admin" readOnly/></label><label>Generated preview password<div className="generated-password"><input type="password" value={generatedPassword} readOnly/><button type="button" onClick={() => void navigator.clipboard.writeText(generatedPassword)}>Copy</button></div></label><div className="demo-staff-actions"><button type="button" className="secondary-button" onClick={() => setGeneratedPassword(generateDemoPassword())}>Generate another</button><button type="submit" className="primary-button">Create preview login →</button></div></form> : <form className="demo-staff-form" onSubmit={(event) => void login(event)}><label>Preview username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)}/></label><label>Preview password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}/></label>{error && <p className="staff-form-error" role="alert">{error}</p>}<button className="primary-button" type="submit">Sign in to preview →</button></form>}
    <div className="staff-callout"><strong>Preview only</strong><p>This login cannot manage players, agents, payment settings, deposits, withdrawals, or production rooms.</p><a className="text-button" href="/?page=login&next=%2Fadmin">Sign in with a DIRE BET web account ↗</a></div></section></main>;

  const sections: Section[] = serverAdmin ? ['overview', 'games', 'rooms', 'payments', 'agents'] : ['overview', 'games'];
  return <main className="staff-shell demo-staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">{serverAdmin ? 'SUPER ADMIN' : 'LOCAL PREVIEW'}</span><div className="staff-header-actions">{!serverAdmin && <button className="staff-link-button" onClick={() => setLoggedIn(false)}>Sign out</button>}<a className="staff-back" href="/">Player app ↗</a></div></header><div className="staff-layout"><aside className="staff-sidebar"><span className="staff-label">{serverAdmin ? 'OWNER DASHBOARD' : 'PREVIEW WORKSPACE'}</span>{sections.map((item, index) => <button key={item} className={section === item ? 'selected' : ''} onClick={() => { setSection(item); setNotice(''); }}><span className="staff-nav-icon">{String(index + 1).padStart(2, '0')}</span>{labels[item]}</button>)}<div className="staff-sidebar-note">{serverAdmin ? 'Telegram owner access' : 'This browser only'}<br/>Real money off</div></aside><section className="staff-content">
    <div className="staff-heading"><div><span className="staff-label">DIRE BET · {serverAdmin ? 'SUPER ADMIN' : 'PREVIEW'}</span><h1>{labels[section]}</h1><p>{serverAdmin ? 'Changes are authenticated and recorded in the admin audit log.' : 'Local demo only. Owner tools require your configured Telegram account.'}</p></div><span className={`staff-lock ${serverAdmin ? '' : 'demo-lock'}`}>{serverAdmin ? 'OWNER' : 'DEMO'}</span></div>
    {notice && <div className="staff-notice" role="status">{notice}{generatedPassword && <div className="revealed-credentials"><span>Preview username: <b>demo-admin</b></span><button onClick={() => void navigator.clipboard.writeText(generatedPassword)}>Copy preview password</button></div>}</div>}
    {section === 'overview' && <><div className="demo-admin-metrics"><article><span>Games</span><strong>4</strong><small>Free practice</small></article><article><span>Room systems</span><strong>{serverAdmin ? 'Ready' : 'Locked'}</strong><small>Owner access required</small></article><article><span>Real money</span><strong>Off</strong><small>No balance or payout actions</small></article></div><section className="staff-callout"><strong>{serverAdmin ? 'Owner tools are active' : 'Unlock the owner dashboard'}</strong><p>{serverAdmin ? 'Use Payments for request review and account settings, Agents for promo codes and weekly demo reports, and Rooms for public match management.' : 'Sign in with your personal Telegram account, then configure its numeric Telegram user ID as SUPER_ADMIN_TELEGRAM_ID in Cloudflare. The bot ID is not the owner ID.'}</p>{!serverAdmin && <a className="secondary-button" href="/?page=login">Open account sign-in ↗</a>}<a className="secondary-button" href="/?page=wallet">Open player wallet ↗</a></section></>}
    {section === 'games' && <div className="demo-game-list">{PUBLIC_GAMES.filter((game) => game.availability === 'playable').map((game) => <article key={game.id}><span className={`demo-game-mark ${game.id}`}>{game.id === 'poker' ? '♠' : game.id === 'ludo' ? '⚄' : game.id === 'dominoes' ? '▥' : '×'}</span><div><strong>{game.title}</strong><small>Practice and public rooms · demo credits only</small></div><b>LIVE · DEMO</b></article>)}</div>}
    {section === 'rooms' && serverAdmin && <RoomManagement token={sessionToken}/>}
    {section === 'payments' && serverAdmin && <PaymentManagement token={sessionToken}/>}
    {section === 'agents' && serverAdmin && <AgentManagement token={sessionToken}/>}
    </section></div></main>;
}
