const sections = [
  'Overview','Players','Games','Live Matches','Match History','Wallet','Deposit Requests',
  'Withdrawal Management','Agents','Referral Management','Promo Codes','Promotions',
  'Reports and Analytics','Notifications','Payment Settings','Game Settings',
  'Administrator Management','Audit Logs',
];

export default function AdminApp() {
  return <main className="staff-shell"><header className="staff-topbar"><a className="wordmark" href="/"><span>DIRE</span><b>BET</b><i>✦</i></a><span className="staff-mode">PREVIEW · ACCESS DISABLED</span><a className="staff-back" href="/">Back to player app ↗</a></header><div className="staff-layout"><aside className="staff-sidebar"><span className="staff-label">ADMINISTRATION</span>{sections.map((item, i) => <button key={item} className={i === 0 ? 'selected' : ''} disabled><span className="staff-nav-icon">{String(i + 1).padStart(2, '0')}</span>{item}</button>)}</aside><section className="staff-content"><div className="staff-heading"><div><span className="staff-label">DIRE BET · ADMIN</span><h1>Dashboard access is not configured</h1><p>Admin password, second-factor enrollment, role checks and protected data routes are not implemented in this preview.</p></div><span className="staff-lock">LOCKED</span></div><div className="staff-callout"><strong>Safe preview</strong><p>No player records, wallet balances or payment settings are exposed here. Configure secure admin onboarding and server-side RBAC before enabling this dashboard.</p></div><h2>Planned sections</h2><div className="staff-section-grid">{sections.map((item, i) => <div key={item} className="staff-section-card"><span>{String(i + 1).padStart(2, '0')}</span><strong>{item}</strong><small>Not available in preview</small></div>)}</div></section></div></main>;
}
