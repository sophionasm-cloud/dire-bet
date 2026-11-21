import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { botMove, initXO, applyXO, type XOState } from '@dire-bet/engines/xo';
import { PUBLIC_GAMES, type GameId } from '@dire-bet/shared';
import { languageNames, translate, type Language, type TranslationKey } from './i18n';
import { xoRules } from './i18n/rules';
import { CheckersPractice, LudoPractice, PokerPractice } from './games/PracticeGames';
import { OnlineMatches, OnlineRoom, type RoomConfig } from './games/OnlineXO';
import PublicRoomLobby from './games/PublicRoomLobby';
import WalletApp from './wallet/WalletApp';
import DireBetPoster from './DireBetPoster';
import WalletBalancePill from './WalletBalancePill';
import { clearAuth, installAuthFetch, isSignedOut, onAuthChange, readAccessToken, readRefreshToken, refreshSession, storeAuth } from './authClient';

const AdminApp = lazy(() => import('./admin/AdminApp'));
const AgentApp = lazy(() => import('./agent/AgentApp'));

type Page = 'home'|'matches'|'online'|'lobby'|'wallet'|'rank'|'menu'|'account'|'login'|GameId;
type Category = 'all'|'board'|'cards'|'quick';
type Game = (typeof PUBLIC_GAMES)[number];
type Overlay = 'language'|'menu'|'support'|'notifications'|'terms'|'privacy'|'rules'|null;
type Account = { webUsername: string | null; phoneShared: boolean };

const languageCodes: Record<Language, string> = { en: 'EN', am: 'AM', so: 'SO', om: 'OM' };
const bannerSlides: { image: string; alt: string; poster?: boolean; ratio: number }[] = [
  { image: '/promotions/dire-bet-poster-bg.jpg', alt: 'Dire Bet friends playing together poster with Ludo, checkers and XO artwork', poster: true, ratio: 727 / 1600 },
  { image: '/promotions/amharic-games.png', alt: 'Dire Bet Amharic gaming poster with players, cards, numbers and trophies', ratio: 543 / 1280 },
  { image: '/promotions/community-games.png', alt: 'Dire Bet poster showing multiple games and people playing together', ratio: 698 / 1280 },
  { image: '/promotions/blue-games.png', alt: 'Blue Dire Bet game poster featuring XO, Ludo, Bingo and Spin', ratio: 543 / 1280 },
];
const posterHeadline = translate('am', 'tagline');
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
  return <div className={`art art-${id} art-poster`} aria-hidden="true">
    <img src={posterSrc(id)} alt="" loading="lazy" decoding="async" />
  </div>;
}

function posterSrc(id: string): string {
  return id === 'checkers' ? '/posters/checkers.svg' : id === 'poker' ? '/posters/american-texas-coming-soon.svg' : `/posters/${id}.jpg`;
}

function App() {
  const requestedPage = new URLSearchParams(location.search).get('page');
  const telegramInitData = window.Telegram?.WebApp?.initData || '';
  const telegramMiniApp = Boolean(telegramInitData);
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('direbet.language') as Language | null;
    return saved && ['en','am','so','om'].includes(saved) ? saved : 'am';
  });
  const [page, setPage] = useState<Page>(() => !telegramMiniApp && (requestedPage === 'wallet' || requestedPage === 'account' || requestedPage === 'login' || requestedPage === 'menu') ? requestedPage : 'home');
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [onboarding, setOnboarding] = useState(() => !telegramMiniApp && !localStorage.getItem('direbet.onboarded') && requestedPage !== 'account' && requestedPage !== 'login');
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Game | null>(null);
  const [lobbyGameId, setLobbyGameId] = useState<GameId>('ludo');
  const [banner, setBanner] = useState(0);
  const [bannerPaused, setBannerPaused] = useState(false);
  const [round, setRound] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => JSON.parse(localStorage.getItem('direbet.recent') || '[]') as string[]);
  const [reduceEffects, setReduceEffects] = useState(() => localStorage.getItem('direbet.reduceEffects') === 'true');
  const [displayName, setDisplayName] = useState('Guest');
  const [sessionToken, setSessionToken] = useState<string | null>(() => isSignedOut() ? null : readAccessToken());
  const [account, setAccount] = useState<Account | null>(null);
  const [telegramAuthError, setTelegramAuthError] = useState(() => isSignedOut());
  const [telegramAuthAttempt, setTelegramAuthAttempt] = useState(0);
  const [accountUsername, setAccountUsername] = useState('');
  const [accountPin, setAccountPin] = useState('');
  const [accountMessage, setAccountMessage] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPin, setLoginPin] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [roomConfig, setRoomConfig] = useState<RoomConfig | null>(null);
  const [xo, setXo] = useState<XOState>(() => initXO());
  const [notice, setNotice] = useState('');
  const promoTouchStart = useRef<{ x: number; y: number } | null>(null);
  const t = useCallback((key: TranslationKey) => translate(language, key), [language]);
  const telegramAuthPending = Boolean(telegramMiniApp && !sessionToken && !telegramAuthError);

  useEffect(() => {
    localStorage.setItem('direbet.language', language);
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
  }, [language]);

  useEffect(() => installAuthFetch(), []);

  useEffect(() => onAuthChange((payload) => {
    if (!payload?.token) { setSessionToken(null); return; }
    setSessionToken(payload.token);
    if (payload.user?.displayName) setDisplayName(payload.user.displayName);
  }), []);

  useEffect(() => {
    const check = () => {
      if (!readRefreshToken()) return;
      const expiresAt = Number(localStorage.getItem('direbet.sessionExpires') || 0);
      if (!expiresAt || expiresAt - Date.now() <= 5 * 60_000) void refreshSession();
    };
    const timer = window.setInterval(check, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    check();
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;
    webApp.ready(); webApp.expand(); webApp.setHeaderColor('#000000'); webApp.setBackgroundColor('#000000');
    webApp.disableVerticalSwipes?.();
  }, []);

  useEffect(() => {
    if (!telegramInitData || sessionToken || isSignedOut()) return;
    let live = true;
    const previousRefresh = readRefreshToken();
    fetch('/api/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: telegramInitData, ...(previousRefresh ? { refreshToken: previousRefresh } : {}) }) })
      .then(async (r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ token: string; refreshToken?: string; expiresIn?: number; user: { displayName?: string } }> })
      .then((data) => {
        if (!live) return;
        storeAuth(data);
        setSessionToken(data.token);
        setDisplayName(data.user.displayName || 'Player');
        setTelegramAuthError(false);
        setPage('home');
        const search = new URLSearchParams(location.search);
        search.delete('page');
        history.replaceState(null, '', `${location.pathname}${search.toString() ? `?${search}` : ''}${location.hash}`);
      })
      .catch(() => { if (live) { setDisplayName('Guest'); setTelegramAuthError(true); } });
    return () => { live = false; };
  }, [telegramInitData, telegramAuthAttempt, sessionToken]);

  useEffect(() => {
    if (!sessionToken) { setAccount(null); return; }
    let live = true;
    fetch('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Session expired. Sign in again.');
        return response.json() as Promise<{ user: { displayName: string; webUsername: string | null; phoneShared: boolean } }>;
      })
      .then((data) => {
        if (!live) return;
        setAccount({ webUsername: data.user.webUsername, phoneShared: data.user.phoneShared });
        setDisplayName(data.user.displayName || 'Player');
        if (data.user.webUsername) setAccountUsername(data.user.webUsername);
      })
      .catch((cause) => {
        if (!live) return;
        clearAuth();
        setSessionToken(null);
        setAccount(null);
        setAccountMessage(cause instanceof Error ? cause.message : 'Sign in again to continue.');
      });
    return () => { live = false; };
  }, [sessionToken]);

  useEffect(() => {
    const code = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (!sessionToken || !code || roomConfig || !/^[23456789A-HJ-NP-Z]{6}$/.test(code)) return;
    let live = true;
    fetch(`/api/rooms/${code}/join`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${sessionToken}` }, body: '{}' })
      .then(async (response) => {
        const result = await response.json() as { code?: string; ticket?: string; gameId?: GameId; error?: string };
        if (!response.ok || !result.code || !result.ticket) throw new Error(result.error || t('onlineDisconnected'));
        if (live) { setRoomConfig({ code: result.code, ticket: result.ticket, gameId: result.gameId || 'xo' }); setPage('online'); history.replaceState(null, '', `${location.pathname}${location.hash}`); }
      })
      .catch((cause) => { if (live) showUnavailable(cause instanceof Error ? cause.message : t('onlineDisconnected')); });
    return () => { live = false; };
  }, [sessionToken, roomConfig, t]);

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
    if (reduceEffects || bannerPaused) return;
    let timer = 0;
    const stop = () => { if (timer) window.clearInterval(timer); timer = 0; };
    const start = () => {
      stop();
      if (!document.hidden) timer = window.setInterval(() => setBanner((current) => (current + 1) % bannerSlides.length), 7200);
    };
    const onVisibilityChange = () => document.hidden ? stop() : start();
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [reduceEffects, bannerPaused]);

  const filteredGames = useMemo(() => PUBLIC_GAMES.filter((game) => {
    const matchesSearch = `${game.title} ${game.id}`.toLowerCase().includes(query.toLowerCase());
    const matchesCategory = category === 'all' || game.category === category;
    return matchesSearch && matchesCategory;
  }), [category, query]);

  const openXo = () => {
    setSelected(null); setXo(initXO()); setRound(0); setPage('xo');
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  };
  const openPractice = (game: GameId) => {
    if (PUBLIC_GAMES.find((item) => item.id === game)?.availability !== 'playable') return;
    setSelected(null); setPage(game);
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
  };
  const leaveGame = () => { setPage('home'); setRound(0); setRoomConfig(null); };
  const selectGame = (game: Game) => {
    if (game.id === 'ethiopian-41') return;
    if (game.availability !== 'playable') { setSelected(game); return; }
    setSelected(null);
    setLobbyGameId(game.id);
    setPage('lobby');
  };
  const quickMove = (index: number) => {
    if (xo.turn !== 'X' || xo.winner || xo.board[index]) return;
    setXo((current) => applyXO(current, 'X', index));
  };
  const updateLanguage = (value: Language) => {
    setLanguage(value); setOverlay(null);
    if (sessionToken) fetch('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } }).catch(() => undefined);
  };
  const retryTelegramAuthentication = () => { clearAuth(); setTelegramAuthError(false); setTelegramAuthAttempt((attempt) => attempt + 1); };
  const setEffectPreference = () => {
    const value = !reduceEffects; setReduceEffects(value); localStorage.setItem('direbet.reduceEffects', String(value));
  };
  const showUnavailable = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(''), 3000); };
  const enterOnlineRoom = useCallback((room: RoomConfig) => { setRoomConfig(room); setOverlay(null); setSelected(null); setPage('online'); }, []);
  const exitOnlineRoom = useCallback(() => {
    if (roomConfig?.code && roomConfig.gameId) {
      try { sessionStorage.setItem(`direbet.exited_${roomConfig.gameId}`, roomConfig.code); localStorage.setItem(`direbet.exited_${roomConfig.gameId}`, roomConfig.code); } catch {}
    }
    setRoomConfig(null);
    nav('home');
  }, [roomConfig]);
  const nav = (next: Page) => { setPage(next); setOverlay(null); setSelected(null); if (next !== 'online') setRoomConfig(null); };
  const signInWithWebLogin = async (event: FormEvent) => {
    event.preventDefault(); setLoginMessage('');
    if (!/^\d{8}$/.test(loginPin)) { setLoginMessage('Enter your 8-digit PIN.'); return; }
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: loginUsername, password: loginPin }) });
      const data = await response.json() as { token?: string; refreshToken?: string; expiresIn?: number; user?: { displayName?: string }; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error || 'Could not sign in.');
      storeAuth(data);
      setSessionToken(data.token); setDisplayName(data.user?.displayName || loginUsername); setLoginPin(''); setPage('home');
      const nextRoute = new URLSearchParams(location.search).get('next');
      history.replaceState(null, '', nextRoute === '/agent' || nextRoute === '/admin' ? nextRoute : location.pathname);
    } catch (cause) { setLoginMessage(cause instanceof Error ? cause.message : 'Could not sign in.'); }
  };
  const saveWebLogin = async (event: FormEvent) => {
    event.preventDefault(); setAccountMessage('');
    if (!sessionToken) { setAccountMessage('Open DIRE BET in Telegram to register.'); return; }
    if (!/^\d{8}$/.test(accountPin)) { setAccountMessage('Choose an 8-digit PIN for web sign-in.'); return; }
    try {
      const response = await fetch('/api/account/web-login', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ username: accountUsername, password: accountPin }) });
      const data = await response.json() as { username?: string; error?: string };
      if (!response.ok) throw new Error(data.error || 'Could not save web login.');
      setAccount({ webUsername: data.username || accountUsername, phoneShared: Boolean(account?.phoneShared) });
      setAccountUsername(data.username || accountUsername); setAccountPin('');
      setAccountMessage('Web login saved. You can now sign in from a browser.');
    } catch (cause) { setAccountMessage(cause instanceof Error ? cause.message : 'Could not save web login.'); }
  };
  const requestPhoneContact = () => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp?.requestContact) { setAccountMessage('Open the DIRE BET bot in Telegram and tap Share contact.'); return; }
    setAccountMessage('Telegram will ask whether to share your contact with the bot.');
    webApp.requestContact((shared) => setAccountMessage(shared ? 'Contact sent to the bot. Refresh the status here in a moment.' : 'Contact was not shared. You can try again when ready.'));
  };
  const refreshAccount = async () => {
    if (!sessionToken) return;
    setAccountMessage('Checking your account…');
    try {
      const response = await fetch('/api/me', { headers: { Authorization: `Bearer ${sessionToken}` } });
      const data = await response.json() as { user?: { displayName: string; webUsername: string | null; phoneShared: boolean }; error?: string };
      if (!response.ok || !data.user) throw new Error(data.error || 'Could not check account status.');
      setAccount({ webUsername: data.user.webUsername, phoneShared: data.user.phoneShared });
      setDisplayName(data.user.displayName || 'Player');
      if (data.user.webUsername) setAccountUsername(data.user.webUsername);
      setAccountMessage(data.user.phoneShared ? 'Contact linked to your Telegram account.' : 'The bot has not received your contact yet.');
    } catch (cause) { setAccountMessage(cause instanceof Error ? cause.message : 'Could not check account status.'); }
  };
  const signOutWeb = async () => {
    const refreshToken = readRefreshToken();
    clearAuth(true);
    setSessionToken(null); setAccount(null); setDisplayName('Guest'); setPage('home'); setAccountMessage('');
    if (telegramMiniApp) setTelegramAuthError(true);
    if (refreshToken) {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
    }
  };

  if (location.pathname.startsWith('/admin')) return <Suspense fallback={<div className="route-loading">Loading…</div>}><AdminApp sessionToken={sessionToken} /></Suspense>;
  if (location.pathname.startsWith('/agent')) return <Suspense fallback={<div className="route-loading">Loading…</div>}><AgentApp token={sessionToken} /></Suspense>;

  return <main className="player-shell">
    <header className="topbar">
      <div className="topbar-brand">
        <a className="wordmark" href="/" onClick={(e) => { e.preventDefault(); nav('home'); }} aria-label="DIRE BET home"><span>DIRE</span><b>BET</b><i>✦</i></a>
        <WalletBalancePill token={sessionToken} pending={telegramAuthPending} onOpen={() => nav('wallet')} />
      </div>
      <div className="top-actions">
        <button className="icon-button language-trigger" onClick={() => setOverlay('language')} aria-label={t('language')}><Icon name="globe" size={17}/><span>{languageCodes[language]}</span></button>
        <button className="icon-button bell-button" onClick={() => setOverlay('notifications')} aria-label={t('matches')}><Icon name="bell" size={18}/><span className="notification-dot" /></button>
        <button className="icon-button menu-trigger" onClick={() => setOverlay('menu')} aria-label={t('menu')}><Icon name="menu" size={21}/></button>
      </div>
    </header>

    {page === 'home' && <section className="screen home-screen">
      {sessionToken ? <div className="profile-welcome"><div className="profile-avatar">{displayName.slice(0, 1).toUpperCase()}</div><div><strong>{displayName}</strong><span>{account ? account.phoneShared ? t('contactLinked') : t('contactNotLinked') : t('onlineConnecting')}</span></div><button className="profile-open" onClick={() => nav('account')}>{t('account')}</button></div> : telegramMiniApp ? <div className="telegram-auth-status" role="status"><span>{telegramAuthPending ? t('onlineConnecting') : t('telegramAuthFailed')}</span>{!telegramAuthPending && <button type="button" onClick={retryTelegramAuthentication}>{t('retryTelegramAuth')}</button>}</div> : <div className="guest-banner"><div><strong>{t('guestTitle')}</strong><span>{t('guestDescription')}</span></div><div className="guest-actions"><a href="https://t.me/Dire_Bet_bot" target="_blank" rel="noreferrer" className="guest-link">{t('openTelegram')}<Icon name="chevron" size={15}/></a><button className="guest-login" onClick={() => nav('login')}>{t('webLogin')}</button></div></div>}
      <section className="promo-carousel" aria-label={t('tagline')} aria-roledescription="carousel" onMouseEnter={() => setBannerPaused(true)} onMouseLeave={() => setBannerPaused(false)} onFocusCapture={() => setBannerPaused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBannerPaused(false); }} onTouchStart={(event) => { const touch = event.touches[0]; promoTouchStart.current = { x: touch.clientX, y: touch.clientY }; }} onTouchEnd={(event) => { const start = promoTouchStart.current; const touch = event.changedTouches[0]; promoTouchStart.current = null; if (!start || !touch) return; const dx = touch.clientX - start.x; const dy = touch.clientY - start.y; if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) setBanner((current) => (current + (dx < 0 ? 1 : bannerSlides.length - 1)) % bannerSlides.length); }} onTouchCancel={() => { promoTouchStart.current = null; }}>
        <div className="promo-window" style={{ '--promo-ratio': bannerSlides[banner].ratio } as CSSProperties}><div className="promo-track" style={{ transform: `translateX(-${banner * 100}%)` }}>
          {bannerSlides.map((slide, index) => <div key={slide.image} className="promo-slide" role="group" aria-roledescription="slide" aria-label={`${index + 1} / ${bannerSlides.length}`} aria-hidden={banner !== index}>{slide.poster ? <DireBetPoster headline={posterHeadline} quickLabel={t('quickPlay')} onQuickPlay={openXo} active={banner === index}/> : <img src={slide.image} alt={slide.alt} draggable={false} decoding="async" />}</div>)}
        </div></div>
        <div className="promo-dots" role="group" aria-label={t('chooseGame')}>{bannerSlides.map((slide, index) => <button key={slide.image} type="button" aria-label={t('showBanner').replace('{number}', String(index + 1))} aria-pressed={banner === index} className={banner === index ? 'active' : ''} onClick={() => setBanner(index)} />)}</div>
      </section>

      <div className="section-head"><div><span className="eyebrow">{t('tagline')}</span><h2>{t('chooseGame')}</h2></div><button className="text-button" onClick={() => setOverlay('menu')}>{t('seeAll')}<Icon name="chevron" size={15}/></button></div>
      <label className="search-box"><Icon name="search" size={18}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchGames')} aria-label={t('searchGames')}/><kbd>⌘ K</kbd></label>
      <div className="category-row" role="tablist" aria-label={t('chooseGame')}>
        {(['all','board','cards','quick'] as Category[]).map((item) => <button key={item} role="tab" aria-selected={category === item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{t(({ all:'categoryAll', board:'categoryBoard', cards:'categoryCards', quick:'categoryQuick' } as const)[item])}</button>)}
      </div>
      <div className="game-grid">
        {filteredGames.map((game) => <button key={game.id} className={`game-card ${game.availability === 'unavailable' ? 'game-disabled' : ''}`} onClick={() => selectGame(game)} disabled={game.availability === 'unavailable'} aria-label={`${game.title} ${game.availability === 'coming-soon' ? t('comingSoon') : game.availability === 'unavailable' ? t('unavailable') : ''}`}>
          <GameArt id={game.id}/><div className="game-card-copy"><strong>{game.title}</strong><small>{game.availability === 'playable' ? t('freePractice') : game.availability === 'unavailable' ? t('unavailable') : t('comingSoon')}</small></div>
          {game.availability !== 'playable' && <span className={`availability ${game.availability}`}>{game.availability === 'unavailable' ? t('unavailable') : t('comingSoon')}</span>}
        </button>)}
      </div>

      <section className="recent-section">
        <div className="section-head compact"><div><span className="eyebrow">DIRE BET</span><h2>{t('recentlyPlayed')}</h2></div><button className="text-button" onClick={() => nav('matches')}>{t('seeAll')}<Icon name="chevron" size={15}/></button></div>
        {recent.length ? <div className="recent-row">{recent.map((id) => <button key={id} className="recent-chip" onClick={openXo}><span className="recent-mark">XO</span><span>{t('freePractice')}</span><Icon name="chevron" size={15}/></button>)}</div> : <div className="empty-inline"><span className="empty-icon">✦</span><span>{t('noRecent')}</span></div>}
      </section>

      <section className="leader-preview"><div className="leader-icon">♛</div><div><strong>{t('rankTitle')}</strong><span>{t('rankEmpty')}</span></div><button className="icon-button" aria-label={t('rank')} onClick={() => nav('rank')}><Icon name="chevron"/></button></section>
    </section>}

    {page === 'xo' && <section className="screen game-screen">
      <button className="back-button" onClick={leaveGame}><Icon name="back" size={19}/>{t('exitGame')}</button>
      <div className="game-title-row"><div><span className="eyebrow">{t('freePractice')}</span><h1>XO</h1></div><span className="bot-pill"><span className="bot-dot"/>{t('bot')}</span></div>
      <div className="player-pair"><div className="player-badge active-player"><span className="player-avatar">{t('you').slice(0,1)}</span><span><strong>{t('you')}</strong><small>X · {xo.turn === 'X' && !xo.winner ? t('yourTurn') : ' '}</small></span></div><span className="versus">VS</span><div className={`player-badge ${xo.turn === 'O' ? 'active-player' : ''}`}><span className="bot-avatar">✦</span><span><strong>{t('bot')}</strong><small>O · {xo.turn === 'O' && !xo.winner ? t('botTurn') : ' '}</small></span></div></div>
      <div className="xo-board" role="grid" aria-label="XO">
        {xo.board.map((cell, index) => <button key={index} role="gridcell" className={`xo-cell ${cell ? `mark-${cell.toLowerCase()}` : ''} ${xo.winner && cell === xo.winner ? 'winning-cell' : ''}`} disabled={Boolean(cell) || Boolean(xo.winner) || xo.turn !== 'X'} onClick={() => quickMove(index)} aria-label={`XO ${index + 1}${cell ? ` ${cell}` : ''}`}>{cell === 'X' ? <span className="x-mark">×</span> : cell === 'O' ? <span className="o-mark">○</span> : ''}</button>)}
      </div>
      <div className={`game-status ${xo.winner ? 'status-result' : ''}`} aria-live="polite">{xo.winner === 'X' ? t('youWin') : xo.winner === 'O' ? t('botWins') : xo.winner === 'draw' ? t('draw') : xo.turn === 'X' ? t('yourTurn') : t('botTurn')}</div>
      {xo.winner && <div className="game-actions"><button className="primary-button wide" onClick={openXo}>{t('playAgain')}<span>↻</span></button><button className="secondary-button" onClick={leaveGame}>{t('home')}</button></div>}
    </section>}

    {page === 'ludo' && <LudoPractice t={t} onExit={leaveGame} reduceEffects={reduceEffects} />}
    {page === 'checkers' && <CheckersPractice t={t} onExit={leaveGame} reduceEffects={reduceEffects} />}
    {page === 'poker' && <PokerPractice t={t} onExit={leaveGame} reduceEffects={reduceEffects} />}

    {page === 'matches' && <OnlineMatches t={t} token={sessionToken} onRoom={enterOnlineRoom} />}
    {page === 'lobby' && <PublicRoomLobby gameId={lobbyGameId} token={sessionToken} t={t} displayName={displayName} onRoom={enterOnlineRoom} onPractice={() => lobbyGameId === 'xo' ? openXo() : openPractice(lobbyGameId)} onExit={() => nav('home')} />}
    {page === 'online' && roomConfig && <OnlineRoom room={roomConfig} t={t} token={sessionToken} onExit={exitOnlineRoom} />}
    {page === 'rank' && <EmptyScreen icon="rank" title={t('rankTitle')} copy={t('rankEmpty')} action={t('home')} onAction={() => nav('home')} />}
    {page === 'wallet' && <WalletApp t={t} token={sessionToken} onSupport={() => setOverlay('support')} />}
    {page === 'menu' && <MenuScreen t={t} language={language} onLanguage={() => setOverlay('language')} onTerms={() => setOverlay('terms')} onPrivacy={() => setOverlay('privacy')} onSupport={() => setOverlay('support')} onEffect={setEffectPreference} reduceEffects={reduceEffects} displayName={displayName} account={account} authenticated={Boolean(sessionToken)} onAccount={() => nav('account')} />}
    {page === 'account' && <AccountScreen t={t} displayName={displayName} authenticated={Boolean(sessionToken)} authPending={telegramAuthPending} account={account} username={accountUsername} pin={accountPin} message={accountMessage} setUsername={setAccountUsername} setPin={setAccountPin} onSave={saveWebLogin} onShareContact={requestPhoneContact} onRefresh={() => void refreshAccount()} onLogin={() => nav('login')} onSignOut={signOutWeb} onBack={() => nav('menu')} />}
    {page === 'login' && <WebLoginScreen t={t} username={loginUsername} pin={loginPin} message={loginMessage} setUsername={setLoginUsername} setPin={setLoginPin} onSubmit={signInWithWebLogin} onBack={() => nav('home')} />}

      {page !== 'xo' && page !== 'wallet' && page !== 'account' && page !== 'login' && <button className="support-float" aria-label={t('support')} onClick={() => setOverlay('support')}><Icon name="question" size={21}/></button>}
    {page !== 'account' && page !== 'login' && <nav className="bottom-nav" aria-label={t('menu')}>
      {(['home','matches','wallet','rank','menu'] as Page[]).map((item) => <button key={item} className={`${page === item ? 'active' : ''} ${item === 'wallet' ? 'wallet-nav-item' : ''}`} onClick={() => nav(item)} aria-label={t(item as TranslationKey)} aria-current={page === item ? 'page' : undefined}><Icon name={item === 'menu' ? 'menu' : item} size={20}/><span>{t(item as TranslationKey)}</span></button>)}
    </nav>}

    {selected && <GameSheet game={selected} t={t} onClose={() => setSelected(null)} onRules={() => { setSelected(null); setOverlay('rules'); }} onPlay={() => selected.id === 'xo' ? openXo() : openPractice(selected.id as GameId)} />}
    {overlay && <OverlaySheet overlay={overlay} t={t} language={language} displayName={displayName} authenticated={Boolean(sessionToken)} phoneShared={account?.phoneShared ?? null} onLanguage={updateLanguage} onClose={() => setOverlay(null)} onNavigate={nav} onNotice={showUnavailable} />}
    {onboarding && <Onboarding step={onboardingStep} setStep={setOnboardingStep} language={language} setLanguage={setLanguage} t={t} onFinish={() => { localStorage.setItem('direbet.onboarded','true'); setOnboarding(false); }} />}
    {notice && <div role="status" className="toast">{notice}</div>}
  </main>;
}

function EmptyScreen({ icon, title, copy, action, onAction }: { icon:string; title:string; copy:string; action:string; onAction:()=>void }) {
  return <section className="screen empty-screen"><button className="empty-back" onClick={onAction}><Icon name="back" size={18}/></button><div className="empty-state"><div className="empty-state-icon"><Icon name={icon} size={25}/></div><h1>{title}</h1><p>{copy}</p><button className="secondary-button" onClick={onAction}>{action}</button></div></section>;
}

function WebLoginScreen({ t, username, pin, message, setUsername, setPin, onSubmit, onBack }: { t:(key:TranslationKey)=>string; username:string; pin:string; message:string; setUsername:(value:string)=>void; setPin:(value:string)=>void; onSubmit:(event:FormEvent)=>void; onBack:()=>void }) {
  return <section className="screen auth-screen"><button className="back-button" onClick={onBack}><Icon name="back" size={19}/>{t('home')}</button><span className="eyebrow">DIRE BET</span><h1>{t('webLogin')}</h1><p className="auth-intro">{t('webLoginIntro')}</p><form className="auth-form" onSubmit={onSubmit}><label>{t('username')}<input autoComplete="username" minLength={3} maxLength={24} pattern="[A-Za-z][A-Za-z0-9_]{2,23}" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>{t('eightDigitPin')}<input autoComplete="current-password" type="password" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} required value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} /></label>{message && <p className="auth-message" role="alert">{message}</p>}<button className="primary-button wide" type="submit">{t('signIn')}<span>→</span></button></form><p className="auth-footnote">{t('needTelegramAccount')} <a href="https://t.me/Dire_Bet_bot" target="_blank" rel="noreferrer">{t('openTelegram')}</a></p></section>;
}

function AccountScreen({ t, displayName, authenticated, authPending, account, username, pin, message, setUsername, setPin, onSave, onShareContact, onRefresh, onLogin, onSignOut, onBack }: { t:(key:TranslationKey)=>string; displayName:string; authenticated:boolean; authPending:boolean; account:{webUsername:string|null;phoneShared:boolean}|null; username:string; pin:string; message:string; setUsername:(value:string)=>void; setPin:(value:string)=>void; onSave:(event:FormEvent)=>void; onShareContact:()=>void; onRefresh:()=>void; onLogin:()=>void; onSignOut:()=>void; onBack:()=>void }) {
  return <section className="screen auth-screen account-screen"><button className="back-button" onClick={onBack}><Icon name="back" size={19}/>{t('menuTitle')}</button><span className="eyebrow">DIRE BET</span><h1>{t('account')}</h1>{authenticated ? <><p className="auth-intro">{t('telegramAccount')} <strong>{displayName}</strong>. {t('webLoginOptional')}</p><div className="account-contact"><div><strong>{t('contactSharing')}</strong><span>{account?.phoneShared ? t('contactLinked') : account ? t('contactNotLinked') : t('onlineConnecting')}</span></div><div className="account-actions">{account && !account.phoneShared && <button className="secondary-button" type="button" onClick={onShareContact}>{t('shareContact')}</button>}<button className="text-button" type="button" onClick={onRefresh}>{t('refreshStatus')}</button></div></div><p className="auth-footnote">{t('contactPrivacy')}</p>{account?.phoneShared ? <form className="auth-form" onSubmit={onSave}><label>{t('username')}<input autoComplete="username" minLength={3} maxLength={24} pattern="[A-Za-z][A-Za-z0-9_]{2,23}" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>{t('eightDigitPin')}<input autoComplete="new-password" type="password" inputMode="numeric" pattern="[0-9]{8}" minLength={8} maxLength={8} required value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} /></label><small className="auth-footnote">{t('pinTip')}</small>{message && <p className="auth-message" role="status">{message}</p>}<button className="primary-button wide" type="submit">{account.webUsername ? t('updateWebLogin') : t('saveWebLogin')}<span>→</span></button></form> : account ? <div className="account-prompt"><p>{t('contactNeeded')}</p><a className="secondary-button" href="https://t.me/Dire_Bet_bot" target="_blank" rel="noreferrer">{t('openTelegram')}</a>{message && <p className="auth-message" role="status">{message}</p>}</div> : <p className="auth-message" role="status">{t('onlineConnecting')}</p>}<button className="text-button account-signout" type="button" onClick={onSignOut}>{t('signOut')}</button></> : authPending ? <p className="auth-message" role="status">{t('onlineConnecting')}</p> : <><p className="auth-intro">{t('accountNeedsTelegram')}</p><a className="primary-button wide auth-telegram-link" href="https://t.me/Dire_Bet_bot" target="_blank" rel="noreferrer">{t('openTelegram')}<span>↗</span></a><button className="text-button" onClick={onLogin}>{t('webLogin')}</button>{message && <p className="auth-message" role="status">{message}</p>}</>}</section>;
}

function MenuScreen({ t, language, onLanguage, onTerms, onPrivacy, onSupport, onEffect, reduceEffects, displayName, account, authenticated, onAccount }: { t:(key:TranslationKey)=>string; language:Language; onLanguage:()=>void; onTerms:()=>void; onPrivacy:()=>void; onSupport:()=>void; onEffect:()=>void; reduceEffects:boolean; displayName:string; account:Account|null; authenticated:boolean; onAccount:()=>void }) {
  return <section className="screen menu-screen"><span className="eyebrow">DIRE BET</span><h1>{t('menuTitle')}</h1><div className="profile-card"><div className="profile-avatar">{displayName.slice(0,1).toUpperCase()}</div><div><strong>{displayName}</strong><span>{authenticated ? account ? account.phoneShared ? t('contactLinked') : t('contactNotLinked') : t('onlineConnecting') : t('guestTitle')}</span></div></div><div className="menu-group"><button onClick={onAccount}><span className="menu-icon"><Icon name="person"/></span><span><strong>{t('account')}</strong><small>{t('webLogin')}</small></span><Icon name="chevron"/></button></div><div className="menu-group"><button onClick={onLanguage}><span className="menu-icon"><Icon name="globe"/></span><span><strong>{t('language')}</strong><small>{languageNames[language]}</small></span><Icon name="chevron"/></button><button onClick={onEffect} aria-pressed={reduceEffects}><span className="menu-icon">◌</span><span><strong>{t('reduceEffects')}</strong><small>{t('settings')}</small></span><span className={`toggle ${reduceEffects ? 'on' : ''}`} /></button><button onClick={onSupport}><span className="menu-icon"><Icon name="question"/></span><span><strong>{t('support')}</strong><small>{t('comingSoon')}</small></span><Icon name="chevron"/></button></div><div className="menu-group"><button onClick={onTerms}><span className="menu-icon">§</span><span><strong>{t('terms')}</strong><small>{t('legalNote')}</small></span><Icon name="chevron"/></button><button onClick={onPrivacy}><span className="menu-icon">◈</span><span><strong>{t('privacy')}</strong><small>{t('legalNote')}</small></span><Icon name="chevron"/></button></div><div className="version">DIRE BET · FREE PLAY</div></section>;
}

function GameSheet({ game, t, onClose, onRules, onPlay }: { game:Game; t:(key:TranslationKey)=>string; onClose:()=>void; onRules:()=>void; onPlay:()=>void }) {
  const description = game.availability === 'playable' ? t('freePractice') : t(game.availability === 'unavailable' ? 'unavailable' : 'comingSoon');
  return <div className="scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="bottom-sheet game-sheet" role="dialog" aria-modal="true" aria-labelledby="game-sheet-title"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><GameArt id={game.id}/><span className="eyebrow">{game.availability === 'playable' ? t('freePractice') : t('comingSoon')}</span><h2 id="game-sheet-title">{game.title}</h2><p>{description}</p>{game.id === 'xo' && <button className="rules-link" onClick={onRules}><Icon name="question" size={17}/>{t('howToPlay')}<Icon name="chevron" size={16}/></button>}{game.availability === 'playable' ? <button className="primary-button wide" onClick={onPlay}>{t('playNow')}<span>↗</span></button> : <button className="secondary-button wide" disabled>{t('comingSoon')}</button>}</section></div>;
}

function OverlaySheet({ overlay, t, language, displayName, authenticated, phoneShared, onLanguage, onClose, onNavigate, onNotice }: { overlay:Exclude<Overlay,null>; t:(key:TranslationKey)=>string; language:Language; displayName:string; authenticated:boolean; phoneShared:boolean|null; onLanguage:(language:Language)=>void; onClose:()=>void; onNavigate:(page:Page)=>void; onNotice:(message:string)=>void }) {
  if (overlay === 'language') return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="bottom-sheet language-sheet" role="dialog" aria-modal="true" aria-labelledby="language-title"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><span className="eyebrow">DIRE BET</span><h2 id="language-title">{t('selectLanguage')}</h2>{(['en','am','so','om'] as Language[]).map((lang) => <button key={lang} className={`language-option ${language === lang ? 'chosen' : ''}`} onClick={() => onLanguage(lang)}><span className="language-code">{languageCodes[lang]}</span><strong>{languageNames[lang]}</strong>{language === lang && <span className="check-mark">✓</span>}</button>)}</section></div>;
  if (overlay === 'menu') return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><aside className="drawer" role="dialog" aria-modal="true"><div className="drawer-head"><a className="wordmark" href="/" onClick={(e) => e.preventDefault()}><span>DIRE</span><b>BET</b><i>✦</i></a><button className="icon-button" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button></div><div className="profile-card"><div className="profile-avatar">{displayName.slice(0,1).toUpperCase()}</div><div><strong>{displayName}</strong><span>{authenticated ? phoneShared ? t('contactLinked') : phoneShared === false ? t('contactNotLinked') : t('onlineConnecting') : t('guestTitle')}</span></div></div>{(['wallet','matches','rank'] as Page[]).map((page) => <button key={page} className={`drawer-row ${page === 'wallet' ? 'wallet-drawer-row' : ''}`} onClick={() => onNavigate(page)}><Icon name={page}/><span>{t(page as TranslationKey)}</span><Icon name="chevron" size={17}/></button>)}<button className="drawer-row" onClick={() => { onClose(); onNotice(t('support')); }}><Icon name="question"/><span>{t('support')}</span><Icon name="chevron" size={17}/></button><button className="drawer-row" onClick={() => { onClose(); onNavigate('menu'); }}><Icon name="globe"/><span>{t('language')}</span><span className="drawer-current">{languageNames[language]}</span></button><div className="drawer-footer">DIRE BET · FREE PLAY</div></aside></div>;
  const isLegal = overlay === 'terms' || overlay === 'privacy';
  const title = overlay === 'support' ? t('support') : overlay === 'notifications' ? t('matches') : overlay === 'terms' ? t('terms') : overlay === 'privacy' ? t('privacy') : t('howToPlay');
  const copy = overlay === 'support' ? t('comingSoon') : overlay === 'notifications' ? t('matchesEmpty') : overlay === 'rules' ? xoRules[language] : t('legalNote');
  return <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="bottom-sheet simple-sheet" role="dialog" aria-modal="true"><div className="sheet-handle"/><button className="sheet-close" onClick={onClose} aria-label={t('close')}><Icon name="close"/></button><span className="eyebrow">{isLegal ? t('legalNote') : 'DIRE BET'}</span><h2>{title}</h2><p>{copy}</p><button className="secondary-button wide" onClick={onClose}>{t('close')}</button></section></div>;
}

function Onboarding({ step, setStep, language, setLanguage, t, onFinish }: { step:number; setStep:(step:number)=>void; language:Language; setLanguage:(language:Language)=>void; t:(key:TranslationKey)=>string; onFinish:()=>void }) {
  const title = t((`onboardingTitle${step + 1}`) as TranslationKey);
  const body = t((`onboardingBody${step + 1}`) as TranslationKey);
  return <div className="scrim onboarding-scrim"><section className="onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title"><button className="skip-button" onClick={onFinish}>{t('skip')}</button><div className="onboarding-art"><span className="onboard-orb"/><span className="onboard-x">×</span><span className="onboard-o">○</span><div className="onboard-die">✦</div></div><div className="onboard-dots"><span className={step === 0 ? 'active' : ''}/><span className={step === 1 ? 'active' : ''}/><span className={step === 2 ? 'active' : ''}/></div><h1 id="onboarding-title">{title}</h1><p>{body}</p>{step === 0 && <div className="onboarding-languages"><span>{t('selectLanguage')}</span>{(['en','am','so','om'] as Language[]).map((lang) => <button key={lang} className={language === lang ? 'chosen' : ''} onClick={() => setLanguage(lang)}>{languageCodes[lang]}</button>)}</div>}<button className="primary-button wide" onClick={() => step < 2 ? setStep(step + 1) : onFinish()}>{step < 2 ? t('continue') : t('startPlaying')}<span>{step < 2 ? '→' : '✦'}</span></button></section></div>;
}

export default App;
