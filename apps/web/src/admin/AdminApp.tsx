import { useMemo, useState, type FormEvent } from 'react';
import { PUBLIC_GAMES } from '@dire-bet/shared';
import { DEMO_ADMIN_KEY, readDemoDeposits, writeDemoDeposits, demoPasswordHash, generateDemoPassword, type DemoDepositRequest } from '../staff/demo';
import RoomManagement from './RoomManagement';

type DemoAdminCredentials = { username: string; salt: string; passwordHash: string };
type Section = 'overview' | 'games' | 'deposits' | 'rooms';

const labels: Record<Section, string> = { overview: 'Overview', games: 'Games', deposits: 'Demo receipt review', rooms: 'Rooms & commissions' };

function readCredentials(): DemoAdminCredentials | null {
  try { return JSON.parse(localStorage.getItem(DEMO_ADMIN_KEY) || 'null') as DemoAdminCredentials | null; }
  catch { return null; }
}

export default function AdminApp({ sessionToken }: { sessionToken: string | null }) {
  const [credentials, setCredentials] = useState<DemoAdminCredentials | null>(readCredentials);
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState('demo-admin');
  const [password, setPassword] = useState('');
  const [generatedPassword, setGeneratedPassword] = useState(() => readCredentials() ? '' : generateDemoPassword());
  const [section, setSection] = useState<Section>('overview');
  const [requests, setRequests] = useState<DemoDepositRequest[]>(readDemoDeposits);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pending = useMemo(() => requests.filter((request) => request.status === 'pending').length, [requests]);

  const setup = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const salt = crypto.randomUUID();
    const item: DemoAdminCredentials = { username: 'demo-admin', salt, passwordHash: await demoPasswordHash(generatedPassword, salt) };
    localStorage.setItem(DEMO_ADMIN_KEY, JSON.stringify(item));
    setCredentials(item); setLoggedIn(true); setNotice('Copy and save this preview password now. It cannot be recovered after you leave this page.');
  };

  const login = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    if (!credentials || username !== credentials.username || await demoPasswordHash(password, credentials.salt) !== credentials.passwordHash) {
      setError('Username or password did not match.'); return;
    }
    setPassword(''); setLoggedIn(true); setNotice('');
  };

  const decide = (id: string, status: 'approved'|'declined') => {
    const next = requests.map((request) => request.id === id ? { ...request, status } : request);
    writeDemoDeposits(next); setRequests(next);
    setNotice(status === 'approved' ? 'Approved in demo only. No cash or balance was changed.' : 'Declined in demo only. No cash or balance was changed.');
  };

  const reset = () => {
    if (!window.confirm('Reset this browser’s demo admin login and demo receipt requests?')) return;
    localStorage.removeItem(DEMO_ADMIN_KEY); localStorage.removeItem('direbet.demoDepositRequests.v1');
    setCredentials(null); setRequests([]); setLoggedIn(false); setUsername('demo-admin'); setPassword(''); setGeneratedPassword(generateDemoPassword()); setNotice(''); setError('');
  };

  if (!credentials || !loggedIn) return <main className="staff-shell demo-staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">LOCAL DEMO</span><a className="staff-back" href="/">Back to games ↗</a></header><section className="demo-staff-gate"><span className="staff-label">DIRE BET · ADMIN PREVIEW</span><h1>{credentials ? 'Admin preview sign-in' : 'Create this browser’s demo admin login'}</h1><p>This login protects a demo workspace on this device only. It does not unlock live accounts, cash deposits or production admin tools.</p>{!credentials ? <form className="demo-staff-form" onSubmit={(event) => void setup(event)}><label>Username<input value="demo-admin" readOnly/></label><label>Generated password<div className="generated-password"><input type="password" value={generatedPassword} readOnly/><button type="button" onClick={() => void navigator.clipboard.writeText(generatedPassword)}>Copy</button></div></label><div className="demo-staff-actions"><button type="button" className="secondary-button" onClick={() => setGeneratedPassword(generateDemoPassword())}>Generate another</button><button type="submit" className="primary-button">Create preview login →</button></div></form> : <form className="demo-staff-form" onSubmit={(event) => void login(event)}><label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}/></label>{error && <p className="staff-form-error" role="alert">{error}</p>}<button className="primary-button" type="submit">Sign in →</button></form>}<div className="staff-callout"><strong>Demo only</strong><p>Demo receipts are stored in this browser. Use fake images only. No payment number is shown and approval does not add money.</p></div></section></main>;

  return <main className="staff-shell demo-staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">DEMO ADMIN</span><div className="staff-header-actions"><button className="staff-link-button" onClick={() => setLoggedIn(false)}>Sign out</button><a className="staff-back" href="/">Player app ↗</a></div></header><div className="staff-layout"><aside className="staff-sidebar"><span className="staff-label">DEMO WORKSPACE</span>{(Object.keys(labels) as Section[]).map((item) => <button key={item} className={section === item ? 'selected' : ''} onClick={() => { setSection(item); setNotice(''); }}><span className="staff-nav-icon">{item === 'deposits' ? pending : String((Object.keys(labels) as Section[]).indexOf(item) + 1).padStart(2, '0')}</span>{labels[item]}</button>)}<div className="staff-sidebar-note">Local to this browser<br/>No live funds</div></aside><section className="staff-content">
    <div className="staff-heading"><div><span className="staff-label">DIRE BET · ADMIN PREVIEW</span><h1>{labels[section]}</h1><p>Demo workspace only. Approval actions update the sample queue and never credit cash.</p></div><span className="staff-lock demo-lock">DEMO</span></div>
    {notice && <div className="staff-notice" role="status">{notice}{generatedPassword && <div className="revealed-credentials"><span>Username: <b>demo-admin</b></span><button onClick={() => void navigator.clipboard.writeText(generatedPassword)}>Copy generated password</button></div>}</div>}
    {section === 'overview' && <><div className="demo-admin-metrics"><article><span>Games</span><strong>4</strong><small>Free practice</small></article><article><span>Pending demo receipts</span><strong>{pending}</strong><small>Local preview requests</small></article><article><span>Real money</span><strong>Off</strong><small>No balance can be credited</small></article></div><section className="staff-callout"><strong>What this preview can do</strong><p>Review a fake receipt image submitted from the Wallet page, approve or decline its demo request, and see the result stay on this browser. Room controls are separate and require the configured Super Admin Telegram account.</p><a className="secondary-button" href="/?page=wallet">Open player wallet ↗</a></section><button className="staff-link-button reset-demo-button" onClick={reset}>Reset this browser’s demo data</button></>}
    {section === 'games' && <div className="demo-game-list">{PUBLIC_GAMES.filter((game) => game.availability === 'playable').map((game) => <article key={game.id}><span className={`demo-game-mark ${game.id}`}>{game.id === 'poker' ? '♠' : game.id === 'ludo' ? '⚄' : game.id === 'dominoes' ? '▥' : '×'}</span><div><strong>{game.title}</strong><small>Practice and private rooms · no entry fee</small></div><b>LIVE · FREE</b></article>)}</div>}
    {section === 'deposits' && <div className="demo-review-list">{requests.length ? requests.map((request) => <article className="demo-review-card" key={request.id}><div className="demo-review-head"><div><span className="staff-label">{request.id}</span><h2>{request.amount} demo credits</h2><small>{new Date(request.createdAt).toLocaleString()}</small></div><span className={`demo-request-status ${request.status}`}>{request.status}</span></div><img src={request.receiptData} alt={`Sample receipt ${request.receiptName}`}/><p><strong>Optional SMS reference:</strong> {request.smsReference || 'None provided'}</p><p className="demo-safety-note">Local sample only. Do not use real receipts or payment details.</p>{request.status === 'pending' && <div className="demo-staff-actions"><button className="secondary-button" onClick={() => decide(request.id, 'declined')}>Decline sample</button><button className="primary-button" onClick={() => decide(request.id, 'approved')}>Approve sample</button></div>}</article>) : <div className="empty-inline"><span className="empty-icon">↻</span><span>No demo receipt requests. Submit one in the player Wallet on this browser.</span></div>}</div>}
    {section === 'rooms' && <RoomManagement token={sessionToken}/>}
    </section></div></main>;
}
