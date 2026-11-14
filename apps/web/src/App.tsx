import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { botMove, initXO, applyXO, type XOState } from '@dire-bet/engines/xo';
import { PUBLIC_GAMES } from '@dire-bet/shared';
import { languageFromTelegram, languageNames, translate, type Language, type TranslationKey } from './i18n';
import { xoRules } from './i18n/rules';

const AdminApp = lazy(() => import('./admin/AdminApp'));
const AgentApp = lazy(() => import('./agent/AgentApp'));

type Page = 'home'|'matches'|'wallet'|'rank'|'menu'|'xo';
type Category = 'all'|'board'|'cards'|'quick';
type Game = (typeof PUBLIC_GAMES)[number];
type Overlay = 'language'|'menu'|'support'|'notifications'|'terms'|'privacy'|'rules'|null;

const languageCodes: Record<Language, string> = { en: 'EN', am: 'AM', so: 'SO', om: 'OM' };
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-6h6v6"/></>,
    matches: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9h.01M16 9h.01M8 15h.01M16 15h.01"/></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M16 14h2"/><path d="M6 5V3h12v2"/></>,
    rank: <><path d="M8 21h8M12 17v4M5 4h14l-1 8a6 6 0 0 1-12 0L5 4Z"/><path d="M5 7H3v3a4 4 0 0 0 4 4M19 7h2v3a4 4 0 0 1-4 4"/></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    person: <><circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/></>,
    question: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.6 2.6 0 1 1 4.7 1.5c-1.2 1.1-2.2 1.6-2.2 3.1M12 17.5h.01"/></>,
    back: <><path d="m14 5-7 7 7 7M7 12h13"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
  };
  return <svg {...common}>{paths[name] || paths.question}</svg>;
}

function GameArt({ id }: { id: string }) {
  if (id === 'ethiopian-41') return <div className="art art-disabled"><span>41</span></div>;
  return <div className={`art art-${id}`} aria-hidden="true">
    {id === 'xo' && <svg viewBox="0 0 100 100"><path d="M24 24 76 76M76 24 24 76"/><circle cx="50" cy="50" r="33"/></svg>}
    {id === 'ludo' && <svg viewBox="0 0 100 100"><rect x="20" y="20" width="60" height="60" rx="12"/><path d="M20 50h60M50 20v60"/><circle cx="35" cy="35" r="6"/><circle cx="65" cy="35" r="6"/><circle cx="35" cy="65" r="6"/><circle cx="65" cy="65" r="6"/></svg>}
    {id === 'dominoes' && <svg viewBox="0 0 100 100"><g transform="rotate(-25 50 50)"><rect x="24" y="18" width="52" height="64" rx="10"/><path d="M26 50h48"/><circle cx="39" cy="35" r="3"/><circle cx="61" cy="35" r="3"/><circle cx="39" cy="65" r="3"/><circle cx="50" cy="58" r="3"/><circle cx="61" cy="71" r="3"/></g></svg>}
    {id === 'poker' && <svg viewBox="0 0 100 100"><g transform="rotate(-12 48 50)"><rect x="23" y="17" width="52" height="68" rx="9"/><path d="M37 36h.01M61 66h.01"/><path d="M49 44c-8-9-17 2 0 15 17-13 8-24 0-15Z"/></g></svg>}
  </div>;
}

function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('direbet.language') as Language | null;
    return saved && ['en','am','so','om'].includes(saved) ? saved : languageFromTelegram(window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code);
  });
  const [page, setPage] = useState<Page>('home');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [onboarding, setOnboarding] = useState(() => !localStorage.getItem('direbet.onboarded'));
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Game | null>(null);
  const [banner, setBanner] = useState(0);
  const [round, setRound] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => JSON.parse(localStorage.getItem('direbet.recent') || '[]') as string[]);
  const [reduceEffects, setReduceEffects] = useState(() => localStorage.getItem('direbet.reduceEffects') === 'true');
  const [displayName, setDisplayName] = useState('Guest');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [xo, setXo] = useState<XOState>(() => initXO());
  const [notice, setNotice] = useState('');
  const t = useCallback((key: TranslationKey) => translate(language, key), [language]);
  const isTelegram = Boolean(sessionToken);

  useEffect(() => {
    localStorage.setItem('direbet.language', language);
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
  }, [language]);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;
    webApp.ready(); webApp.expand(); webApp.setHeaderColor('#000000'); webApp.setBackgroundColor('#000000');
    webApp.disableVerticalSwipes?.();
  }, []);

  useEffect(() => {
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) return;
    let live = true;
    fetch('/api/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) })
      .then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ token: string; user: { displayName?: string } }> })
      .then((data) => { if (live) { setSessionToken(data.token); setDisplayName(data.user.displayName || 'Player'); } })
      .catch(() => { if (live) setDisplayName('Guest'); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const names = ['/admin', '/admin/'];
    if (!names.includes(location.pathname) && location.pathname !== '/agent' && location.pathname !== '/agent/') return;
    const pop = () => setPage('home');
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useEffect(() => {
    if (page !== 'xo' || xo.turn !== 'O' || xo.winner) return;
    const timer = window.setTimeout(() => setXo((current) => {
      const action = botMove(current, 'hard');
      return action === null ? current : applyXO(current, 'O', action);
    }), 420);
    return () => window.clearTimeout(timer);
  }, [page, xo]);

  useEffect(() => {
    if (page !== 'xo' || !xo.winner || round > 0) return;
    setRound(1);
    const next = ['xo', ...recent.filter((id) => id !== 'xo')].slice(0, 4);
    setRecent(next); localStorage.setItem('direbet.recent', JSON.stringify(next));
    if (xo.winner === 'X') window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
  }, [page, xo.winner, recent, round]);

  useEffect(() => {
    if (page === 'xo') window.Telegram?.WebApp?.BackButton?.show();
    else window.Telegram?.WebApp?.BackButton?.hide();
    const back = () => leaveGame();
    window.Telegram?.WebApp?.BackButton?.onClick(back);
    return () => window.Telegram?.WebApp?.BackButton?.offClick(back);
  }, [page]);

  useEffect(() => {
    if (reduceEffects || navigator.hardwareConcurrency <= 4) return;
    const timer = window.setInterval(() => setBanner((current) => (current + 1) % 2), 6000);
    return () => window.clearInterval(timer);
  }, [reduceEffects]);

  const filteredGames = useMemo(() => PUBLIC_GAMES.filter((game) => {
    const matchesSearch = `${game.title} ${game.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesCategory = category === 'all' || game.category === category;
    return matchesSearch && matchesCategory;
  }), [category, query]);

  const openXo = () => {
    setSelected(null); setXo(initXO()); setRound(0); setPage('xo');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  };
  const leaveGame = () => { setPage('home'); setRound(0); };
  const selectGame = (game: Game) => {
    if (game.id === 'ethiopian-41') return;
    setSelected(game);
  };
  const quickMove = (index: number) => {
    if (xo.turn !== 'X' || xo.winner || xo.board[index]) return;
    setXo((current) => applyXO(current, 'X', index));
  };
  const updateLanguage = (value: Language) => {
    setLanguage(value); setOverlay(null);
    if (sessionToken) fetch('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } }).catch(() => undefined);
  };
  const setEffectPreference = () => {
    const value = !reduceEffects; setReduceEffects(value); localStorage.setItem('direbet.reduceEffects', String(value));
  };
  const showUnavailable = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(''), 3000); };
  const nav = (next: Page) => { setPage(next); setOverlay(null); setSelected(null); };

  if (location.pathname.startsWith('/admin')) return <Suspense fallback={<div className="route-loading">Loading…</div>}><AdminApp /></Suspense>;
  if (location.pathname.startsWith('/agent')) return <Suspense fallback={<div className="route-loading">Loading…</div>}><AgentApp /></Suspense>;

  return <main className="player-shell">
    <header className="topbar">
      <button className="mode-chip" onClick={() => showUnavailable(t('demoNotice'))} aria-label={t('testMode')}>
        <span className="mode-dot" />{t('testMode')}
      </button>
      <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); nav('home'); }} aria-label="DIRE BET home"><span>DIRE</span><b>BET</b><i>✦</i></a>
      <div className="top-actions">
        <button className="icon-button language-trigger" onClick={() => setOverlay('language')} aria-label={t('language')}><Icon name="globe" size={17}/><span>{languageCodes[language]}</span></button>
        <button className="icon-button bell-button" onClick={() => setOverlay('notifications')} aria-label={t('matches')}><Icon name="bell" size={18}/><span className="notification-dot" /></button>
        <button className="icon-button menu-trigger" onClick={() => setOverlay('menu')} aria-label={t('menu')}><Icon name="menu" size={21}/></button>
      </div>
    </header>

    <div className="demo-ribbon"><span className="ribbon-spark">✦</span><span>{t('demoNotice')}</span></div>

    {page === 'home' && <section className="screen home-screen">
      {!isTelegram && <div className="guest-banner"><div><strong>{t('guestTitle')}</strong><span>{t('guestDescription')}</span></div><a href="https://t.me/Dire_Bet_bot" target="_blank" rel="noreferrer" className="guest-link">{t('openTelegram')}<Icon name="chevron" size={15}/></a></div>}
      <section className={`hero hero-${banner}`} aria-label={t('tagline')}>
        <div className="hero-copy"><span className="eyebrow">DIRE BET · {t('freePractice')}</span><h1>{banner === 0 ? t('chooseGame') : t('tagline')}</h1><p>{t('guestDescription')}</p><button className="primary-button" onClick={openXo}>{t('quickPlay')}<span>↗</span></button></div>
        <div className="hero-art" aria-hidden="true"><span className="hero-orb orb-one"/><span className="hero-orb orb-two"/><div className="hero-die"><i/><i/><i/><i/><i/></div><span className="hero-x">×</span><span className="hero-o">○</span></div>
        <div className="hero-dots"><button aria-label="Slide 1" className={banner === 0 ? 'active' : ''} onClick={() => setBanner(0)}/><button aria-label="Slide 2" className={banner === 1 ? 'active' : ''} onClick={() => setBanner(1)}/></div>
      </section>

      <div className="section-head"><div><span className="eyebrow">{t('tagline')}</span><h2>{t('chooseGame')}</h2></div><button className="text-button" onClick={() => setOverlay('menu')}>{t('seeAll')}<Icon name="chevron" size={15}/></button></div>
      <label className="search-box"><Icon name="search" size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchGames')} aria-label={t('searchGames')}/><kbd>⌘ K</kbd></label>
      <div className="category-row" role="tablist" aria-label={t('chooseGame')}>
        {(['all','board','cards','quick'] as Category[]).map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{t(({ all:'categoryAll', board:'categoryBoard', cards:'categoryCards', quick:'categoryQuick' } as const)[item])}</button>)}
      </div>
      <div className="game-grid">
        {filteredGames.map((game) => <button key={game.id} className={`game-card ${game.availability === 'unavailable' ? 'game-disabled' : ''}`} onClick={() => selectGame(game)} disabled={game.availability === 'unavailable'} aria-label={`${game.title} ${game.availability === 'unavailable' ? t('unavailable') : ''}`}>
          <GameArt id={game.id}/><div className="game-card-copy"><strong>{game.title}</strong><small>{game.availability === 'playable' ? t('freePractice') : game.availability === 'unavailable' ? t('unavailable') : t('comingSoon')}</small></div>
          {game.availability !== 'playable' && <span className={`availability ${game.availability}`}>{game.availability === 'unavailable' ? t('unavailable') : t('comingSoon')}</span>}
        </button>)}
      </div>

      <section className="recent-section">
        <div className="section-head compact"><div><span className="eyebrow">DIRE BET</span><h2>{t('recentlyPlayed')}</h2></div><button className="text-button" onClick={() => nav('matches')}>{t('seeAll')}<Icon name="chevron" size={15}/></button></div>
        {recent.length ? <div className="recent-row">{recent.map((id) => <button key={id} className="recent-chip" onClick={openXo}><span className="recent-mark">XO</span><span>{t('freePractice')}</span><Icon name="chevron" size={15}/></button>)}</div> : <div className="empty-inline"><span className="empty-icon">✦</span><span>{t('noRecent')}</span></div>}
      </section>

      <section className="leader-preview"><div className="leader-icon">♛</div><div><strong>{t('rankTitle')}</strong><span>{t('rankEmpty')}</span></div><button className="icon-button" aria-label={t('rank')} onClick={() => nav('rank')}><Icon name="chevron"/></button></section>
      <div className="age-note"><span>i</span>{t('ageReview')}</div>
    </section>}

    {page === 'xo' && <section className="screen game-screen">
      <button className="back-button" onClick={leaveGame}><Icon name="back" size={19}/>{t('exitGame')}</button>
      <div className="game-title-row"><div><span className="eyebrow">{t('freePractice')}</span><h1>XO</h1></div><span className="bot-pill"><span className="bot-dot"/>{t('bot')}</span></div>
      <div className="player-pair"><div className="player-badge active-player"><span className="player-avatar">{t('you').slice(0,1)}</span><span><strong>{t('you')}</strong><small>X · {xo.turn === 'X' && !xo.winner ? t('yourTurn') : ' '}</small></span></div><span className="versus">VS</span><div className={`player-badge ${xo.turn === 'O' ? 'active-player' : ''}`}><span className="bot-avatar">✦</span><span><strong>{t('bot')}</strong><small>O · {xo.turn === 'O' && !xo.winner ? t('botTurn') : ' '}</small></span></div></div>
      <div className="xo-board" role="grid" aria-label="XO">
        {xo.board.map((cell, index) => <button key={index} role="gridcell" className={`xo-cell ${cell ? `mark-${cell.toLowerCase()}` : ''} ${xo.winner && cell === xo.winner ? 'winning-cell' : ''}`} disabled={Boolean(cell) || Boolean(xo.winner) || xo.turn !== 'X'} onClick={() => quickMove(index)} aria-label={`XO ${index + 1}${cell ? ` ${cell}` : ''}`}>{cell === 'X' ? <span className="x-mark">×</span> : cell === 'O' ? <span className="o-mark">○</span> : ''}</button>)}
      </div>
      <div className={`game-status ${xo.winner ? 'status-result' : ''}`} aria-live="polite">{xo.winner === 'X' ? t('youWin') : xo.winner === 'O' ? t('botWins') : xo.winner === 'draw' ? t('draw') : xo.turn === 'X' ? t('yourTurn') : t('botTurn')}</div>
      <div className="practice-caption">{t('demoLabel')} · {t('demoNotice')}</div>
      {xo.winner && <div className="game-actions"><button className="primary-button wide" onClick={openXo}>{t('playAgain')}<span>↻</span></button><button className="secondary-button" onClick={leaveGame}>{t('home')}</button></div>}
    </section>}

    {page === 'matches' && <EmptyScreen icon="matches" title={t('matchesEmpty')} copy={t('matchesEmptyCopy')} action={t('home')} onAction={() => nav('home')} />}
    {page === 'rank' && <EmptyScreen icon="rank" title={t('rankTitle')} copy={t('rankEmpty')} action={t('home')} onAction={() => nav('home')} />}
    {page === 'wallet' && <WalletScreen t={t} onSupport={() => setOverlay('support')} />}
    {page === 'menu' && <MenuScreen t={t} language={language} onLanguage={() => setOverlay('language')} onTerms={() => setOverlay('terms')} onPrivacy={() => setOverlay('privacy')} onSupport={() => setOverlay('support')} onEffect={setEffectPreference} reduceEffects={reduceEffects} displayName={displayName} />}

    {page !== 'xo' && <button className="support-float" aria-label={t('support')} onClick={() => setOverlay('support')}><Icon name="question" size={21}/></button>}
    <nav className="bottom-nav" aria-label={t('menu')}>
      {(['home','matches','wallet','rank','menu'] as Page[]).map((item) => <button key={item} className={page === item ? 'active' : ''} onClick={() => nav(item)} aria-current={page === item ? 'page' : undefined}><Icon name={item === 'menu' ? 'menu' : item} size={20}/><span>{t(item as TranslationKey)}</span></button>)}
    </nav>

    {selected && <GameSheet game={selected} t={t} onClose={() => setSelected(null)} onRules={() => { setSelected(null); setOverlay('rules'); }} onPlay={() => selected.id === 'xo' ? openXo() : setSelected(null)} />}
    {overlay && <OverlaySheet overlay={overlay} t={t} language={language} onLanguage={updateLanguage} onClose={() => setOverlay(null)} onNavigate={nav} onNotice={showUnavailable} />}
    {onboarding && <Onboarding step={onboardingStep} setStep={setOnboardingStep} language={language} setLanguage={setLanguage} t={t} onFinish={() => { localStorage.setItem('direbet.onboarded','true'); setOnboarding(false); }} />}
    {notice && <div role="status" className="toast">{notice}</div>}
  </main>;
}

function EmptyScreen({ icon, title, copy, action, onAction }: { icon:string; title:string; copy:string; action:string; onAction:()=>void }) {
  return <section className="screen empty-screen"><button className="empty-back" onClick={onAction}><Icon name="back" size={18}/></button><div className="empty-state"><div className="empty-state-icon"><Icon name={icon} size={25}/></div><h1>{title}</h1><p>{copy}</p><button className="secondary-button" onClick={onAction}>{action}</button></div></section>;
}

function WalletScreen({ t, onSupport }: { t:(key:TranslationKey)=>string; onSupport:()=>void }) {
  return <section className="screen wallet-screen"><span className="eyebrow">{t('testMode')}</span><h1>{t('walletTitle')}</h1><div className="wallet-card"><div className="wallet-card-top"><span>{t('demoCredits')}</span><span className="demo-tag">{t('demoLabel')}</span></div><strong>—</strong><small>{t('liveFundsOff')}</small><div className="wallet-glow"/></div><div className="locked-actions"><button disabled><span>＋</span>{t('deposit')}<small>{t('disabled')}</small></button><button disabled><span>↗</span>{t('withdraw')}<small>{t('disabled')}</small></button></div><div className="callout"><span className="callout-icon">!</span><p>{t('walletCopy')}</p></div><div className="section-head compact"><div><span className="eyebrow">{t('wallet')}</span><h2>{t('transactionHistory')}</h2></div></div><div className="empty-inline"><span className="empty-icon">↻</span><span>{t('matchesEmpty')}</span></div><button className="text-button wallet-help" onClick={onSupport}>{t('support')}<Icon name="chevron" size={15}/></button></section>;
}

function MenuScreen({ t, language, onLanguage, onTerms, onPrivacy, onSupport, onEffect, reduceEffects, displayName }: { t:(key:TranslationKey)=>string; language:Language; onLanguage:()=>void; onTerms:()=>void; onPrivacy:()=>void; onSupport:()=>void; onEffect:()=>void; reduceEffects:boolean; displayName:string }) {
  return <section className="screen menu-screen"><span className="eyebrow">DIRE BET</span><h1>{t('menuTitle')}</h1><div className="profile-card"><div className="profile-avatar">{displayName.slice(0,1).toUpperCase()}</div><div><strong>{displayName}</strong><span>{t('guestTitle')}</span></div><span className="guest-pill">{t('demoLabel')}</span></div><div className="menu-group"><button onClick={onLanguage}><span className="menu-icon"><Icon name="globe"/></span><span><strong>{t('language')}</strong><small>{languageNames[language]}</small></span><Icon name="chevron"/></button><button onClick={onEffect} aria-pressed={reduceEffects}><span className="menu-icon">◌</span><span><strong>{t('reduceEffects')}</strong><small>{t('settings')}</small></span><span className={`toggle ${reduceEffects ? 'on' : ''}`} /></button><button onClick={onSupport}><span className="menu-icon"><Icon name="question"/></span><span><strong>{t('support')}</strong><small>{t('comingSoon')}</small></span><Icon name="chevron"/></button></div><div className="menu-group"><button onClick={onTerms}><span className="menu-icon">§</span><span><strong>{t('terms')}</strong><small>{t('ageReview')}</small></span><Icon name="chevron"/></button><button onClick={onPrivacy}><span className="menu-icon">◈</span><span><strong>{t('privacy')}</strong><small>{t('ageReview')}</small></span><Icon name="chevron"/></button></div><div className="version">DIRE BET · PREVIEW 0.1.0</div></section>;
}

function GameSheet({ game, t, onClose, onRules, onPlay }: { game:Game; t:(key:TranslationKey)=>string; onClose:()=>void; onRules:()=>void; onPlay:()=>void }) {
  const description = game.availability === 'playable' ? t('freePractice') : t(game.availability === 'unavailable' ? 'unavailable' : 'comingSoon');
  return <div className="scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="bottom-sheet game-sheet" role="dialog" aria-modal="true" aria-labelledby="game-sheet-title"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><GameArt id={game.id}/><span className="eyebrow">{game.availability === 'playable' ? t('freePractice') : t('comingSoon')}</span><h2 id="game-sheet-title">{game.title}</h2><p>{description}</p>{game.id === 'xo' && <button className="rules-link" onClick={onRules}><Icon name="question" size={17}/>{t('howToPlay')}<Icon name="chevron" size={16}/></button>}{game.availability === 'playable' ? <button className="primary-button wide" onClick={onPlay}>{t('playNow')}<span>↗</span></button> : <button className="secondary-button wide" disabled>{t('comingSoon')}</button>}</section></div>;
}

function OverlaySheet({ overlay, t, language, onLanguage, onClose, onNavigate, onNotice }: { overlay:Exclude<Overlay,null>; t:(key:TranslationKey)=>string; language:Language; onLanguage:(language:Language)=>void; onClose:()=>void; onNavigate:(page:Page)=>void; onNotice:(message:string)=>void }) {
  if (overlay === 'language') return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="bottom-sheet language-sheet" role="dialog" aria-modal="true" aria-labelledby="language-title"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><span className="eyebrow">DIRE BET</span><h2 id="language-title">{t('selectLanguage')}</h2>{(['en','am','so','om'] as Language[]).map((lang) => <button key={lang} className={`language-option ${language === lang ? 'chosen' : ''}`} onClick={() => onLanguage(lang)}><span className="language-code">{languageCodes[lang]}</span><strong>{languageNames[lang]}</strong>{language === lang && <span className="check-mark">✓</span>}</button>)}</section></div>;
  if (overlay === 'menu') return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><aside className="drawer" role="dialog" aria-modal="true"><div className="drawer-head"><a className="wordmark" href="/" onClick={(e) => e.preventDefault()}><span>DIRE</span><b>BET</b><i>✦</i></a><button className="icon-button" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button></div><div className="profile-card"><div className="profile-avatar">G</div><div><strong>{t('guestTitle')}</strong><span>{t('guestDescription')}</span></div></div><div className="drawer-wallet"><span>{t('testMode')}</span><strong>—</strong><small>{t('demoNotice')}</small></div>{(['wallet','matches','rank'] as Page[]).map((page) => <button key={page} className="drawer-row" onClick={() => onNavigate(page)}><Icon name={page}/><span>{t(page as TranslationKey)}</span><Icon name="chevron" size={17}/></button>)}<button className="drawer-row" onClick={() => { onClose(); onNotice(t('support')); }}><Icon name="question"/><span>{t('support')}</span><Icon name="chevron" size={17}/></button><button className="drawer-row" onClick={() => { onClose(); onNavigate('menu'); }}><Icon name="globe"/><span>{t('language')}</span><span className="drawer-current">{languageNames[language]}</span></button><div className="drawer-footer">DIRE BET · PREVIEW 0.1.0</div></aside></div>;
  const isLegal = overlay === 'terms' || overlay === 'privacy';
  const title = overlay === 'support' ? t('support') : overlay === 'notifications' ? t('matches') : overlay === 'terms' ? t('terms') : overlay === 'privacy' ? t('privacy') : t('howToPlay');
  const copy = overlay === 'support' ? t('comingSoon') : overlay === 'notifications' ? t('matchesEmpty') : overlay === 'rules' ? xoRules[language] : t('ageReview');
  return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="bottom-sheet simple-sheet" role="dialog" aria-modal="true"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><span className="eyebrow">{isLegal ? t('ageReview') : 'DIRE BET'}</span><h2>{title}</h2><p>{copy}</p><button className="secondary-button wide" onClick={onClose}>{t('close')}</button></section></div>;
}

function Onboarding({ step, setStep, language, setLanguage, t, onFinish }: { step:number; setStep:(step:number)=>void; language:Language; setLanguage:(language:Language)=>void; t:(key:TranslationKey)=>string; onFinish:()=>void }) {
  const title = t((`onboardingTitle${step + 1}`) as TranslationKey);
  const body = t((`onboardingBody${step + 1}`) as TranslationKey);
  return <div className="scrim onboarding-scrim"><section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><button className="skip-button" onClick={onFinish}>{t('skip')}</button><div className="onboarding-art"><span className="onboard-orb"/><span className="onboard-x">×</span><span className="onboard-o">○</span><div className="onboard-die">✦</div></div><div className="onboard-dots"><span className={step === 0 ? 'active' : ''}/><span className={step === 1 ? 'active' : ''}/><span className={step === 2 ? 'active' : ''}/></div><h1 id="onboarding-title">{title}</h1><p>{body}</p>{step === 0 && <div className="onboarding-languages"><span>{t('selectLanguage')}</span>{(['en','am','so','om'] as Language[]).map((lang) => <button key={lang} className={language === lang ? 'chosen' : ''} onClick={() => setLanguage(lang)}>{languageCodes[lang]}</button>)}</div>}<button className="primary-button wide" onClick={() => step < 2 ? setStep(step + 1) : onFinish()}>{step < 2 ? t('continue') : t('startPlaying')}<span>{step < 2 ? '→' : '✦'}</span></button><small className="onboard-note">{t('testMode')} · {t('demoNotice')}</small></section></div>;
}

export default App;
