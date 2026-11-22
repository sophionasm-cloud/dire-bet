import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameId } from '@dire-bet/shared';
import type { TranslationKey } from '../i18n';
import type { MarketplaceRoom, MarketplaceSettings, RoomConfig } from './marketplaceTypes';

type Translator = (key: TranslationKey) => string;
type Props = {
  gameId: GameId;
  token: string | null;
  t: Translator;
  displayName: string;
  onRoom: (room: RoomConfig) => void;
  onPractice: () => void;
  onExit: () => void;
};
type MarketState = { type: 'market'; rooms: MarketplaceRoom[]; ownRoom: MarketplaceRoom | null; serverTime: number };
type ResponseBody = { error?: string; room?: MarketplaceRoom | null; rooms?: MarketplaceRoom[]; ticket?: string; code?: string; gameId?: GameId; balance?: number; settings?: MarketplaceSettings };

const defaultSettings: MarketplaceSettings = { standardAmounts: [10, 20, 30, 50, 100, 200, 500], customEnabled: true, customMaximum: 1000, waitingSeconds: 30, realMoneyEnabled: false };

export default function PublicRoomLobby({ gameId, token, t, displayName, onRoom, onPractice, onExit }: Props) {
  const [rooms, setRooms] = useState<MarketplaceRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<MarketplaceRoom | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [balance, setBalance] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | 'free'>('free');
  const [customAmount, setCustomAmount] = useState('150');
  const [crownTarget, setCrownTarget] = useState<1 | 2 | 4>(1);
  const [player0Color, setPlayer0Color] = useState<'yellow'|'green'>('yellow');
  const [clockNow, setClockNow] = useState(Date.now());
  const [countdown, setCountdown] = useState(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState<'connecting'|'connected'|'offline'>('connecting');
  const requestKey = useRef('');
  if (!requestKey.current) requestKey.current = crypto.randomUUID();
  const launching = useRef('');
  const settledRefresh = useRef('');
  const amount = entry === 'free' ? 0 : entry === -1 ? Number(customAmount) : entry;
  const insufficient = Boolean(token && balance !== null && entry !== 'free' && amount > balance);
  const title = gameTitle(gameId);
  const headers = useMemo<Record<string, string>>(() => { const value: Record<string, string> = {}; if (token) value.Authorization = `Bearer ${token}`; return value; }, [token]);

  const loadRooms = useCallback(async () => {
    try {
      const response = await fetch(`/api/public-rooms?gameId=${gameId}`);
      const body = await response.json() as { rooms?: MarketplaceRoom[] };
      if (response.ok) setRooms(body.rooms || []);
    } catch { setConnection('offline'); }
    finally { setLoading(false); }
  }, [gameId]);

  useEffect(() => {
    let live = true;
    let socket: WebSocket | null = null;
    let poll = 0;
    const load = async () => {
      await loadRooms();
      if (!live) return;
      if (token) {
        const [configResult, balanceResult, ownResult] = await Promise.allSettled([
          fetch('/api/public-rooms/config').then((response) => response.json() as Promise<MarketplaceSettings>),
          fetch('/api/public-rooms/balance', { headers }).then(async (response) => response.ok ? await response.json() as { balance: number } : null),
          fetch(`/api/public-rooms/mine?gameId=${gameId}`, { headers }).then((response) => response.json() as Promise<{ room?: MarketplaceRoom | null }>),
        ]);
        if (!live) return;
        if (configResult.status === 'fulfilled') setSettings(configResult.value);
        if (balanceResult.status === 'fulfilled' && balanceResult.value) setBalance(balanceResult.value.balance);
        if (ownResult.status === 'fulfilled' && ownResult.value.room) {
          const own = ownResult.value.room;
          if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(own.status) || isExited(own.code)) {
            setActiveRoom(null);
          } else if (['WAITING', 'FULL', 'STARTING'].includes(own.status)) {
            setActiveRoom(own);
            setRooms((current) => current.filter((room) => room.id !== own.id));
          } else if (own.status === 'IN_PROGRESS' || own.status === 'SETTLING') {
            setActiveRoom(own);
          }
        }
      } else {
        const response = await fetch('/api/public-rooms/config').catch(() => null);
        if (response?.ok && live) setSettings(await response.json() as MarketplaceSettings);
      }
      if (!live) return;
      const ticketResponse = token ? await fetch('/api/public-rooms/ws-ticket', { method: 'POST', headers }).catch(() => null) : null;
      const ticketBody = ticketResponse?.ok ? await ticketResponse.json() as { ticket?: string } : null;
      if (!live) return;
      const address = new URL('/ws/public-rooms', location.href);
      address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      address.searchParams.set('gameId', gameId);
      if (ticketBody?.ticket) address.searchParams.set('ticket', ticketBody.ticket);
      socket = new WebSocket(address);
      socket.onopen = () => { if (live) setConnection('connected'); };
      socket.onmessage = (event) => {
        try {
          const snapshot = JSON.parse(String(event.data)) as MarketState;
          if (snapshot.type !== 'market' || !live) return;
          setRooms((snapshot.rooms || []).filter((room) => room.id !== snapshot.ownRoom?.id));
          if (snapshot.ownRoom) {
            if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(snapshot.ownRoom.status) || isExited(snapshot.ownRoom.code)) {
              setActiveRoom(null);
            } else {
              setActiveRoom((current) => !current || current.id === snapshot.ownRoom?.id ? snapshot.ownRoom : current);
            }
          }
          setConnection('connected');
        } catch { setConnection('offline'); }
      };
      socket.onclose = () => { if (live) setConnection('offline'); };
      socket.onerror = () => { if (live) setConnection('offline'); };
      poll = window.setInterval(() => void loadRooms(), 5000);
    };
    void load();
    return () => { live = false; if (poll) window.clearInterval(poll); socket?.close(1000, 'Leaving public room list'); };
  }, [gameId, token, headers, loadRooms]);

  useEffect(() => {
    if (!activeRoom) return;
    const tick = () => setCountdown(Math.max(0, Math.ceil((activeRoom.expiresAt - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [activeRoom?.id, activeRoom?.expiresAt]);

  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!activeRoom || !['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(activeRoom.status)) return;
    const key = `${activeRoom.id}:${activeRoom.status}`;
    if (settledRefresh.current === key) return;
    settledRefresh.current = key;
    window.dispatchEvent(new Event('direbet:wallet-changed'));
  }, [activeRoom]);

  useEffect(() => {
    if (!token || !activeRoom || !['IN_PROGRESS', 'SETTLING'].includes(activeRoom.status) || launching.current === activeRoom.id) return;
    if (isExited(activeRoom.code)) return;
    launching.current = activeRoom.id;
    let live = true;
    fetch(`/api/public-rooms/${activeRoom.code}/session`, { headers })
      .then(async (response) => {
        const result = await response.json() as ResponseBody;
        if (!response.ok || !result.ticket || !result.code || !result.gameId) throw new Error(result.error || t('onlineDisconnected'));
        if (live) onRoom({ code: result.code, ticket: result.ticket, gameId: result.gameId, publicRoom: result.room || activeRoom });
      })
      .catch((cause) => { launching.current = ''; if (live) setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); });
    return () => { live = false; };
  }, [activeRoom, headers, onRoom, t, token]);

  const create = async () => {
    try { sessionStorage.removeItem(`direbet.exited_${gameId}`); localStorage.removeItem(`direbet.exited_${gameId}`); } catch {}
    launching.current = '';
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    if (entry !== 'free' && (!Number.isSafeInteger(amount) || amount <= 0 || (entry === -1 && (amount <= 100 || amount > settings.customMaximum)))) { setMessage(t('marketAmountInvalid')); return; }
    setBusy(true); setMessage('');
    const freshKey = crypto.randomUUID();
    requestKey.current = freshKey;
    try {
      const response = await fetch('/api/public-rooms', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ gameId, entry: entry === 'free' ? { kind: 'free' } : { kind: entry === -1 ? 'custom' : 'standard', amount }, options: gameId === 'ludo' ? { player0Color, crownTarget } : {}, idempotencyKey: freshKey }),
      });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      requestKey.current = crypto.randomUUID();
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
      window.dispatchEvent(new Event('direbet:wallet-changed'));
    } catch (cause) { requestKey.current = crypto.randomUUID(); setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const join = async (room: MarketplaceRoom) => {
    try { sessionStorage.removeItem(`direbet.exited_${gameId}`); localStorage.removeItem(`direbet.exited_${gameId}`); } catch {}
    launching.current = '';
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    const entryLabel = room.entryCredits === 0 ? t('marketFree') : `${formatCredits(room.entryCredits)} ${t('etb')}`;
    if (!window.confirm(t('marketJoinConfirm').replace('{game}', gameTitle(room.gameId)).replace('{amount}', entryLabel))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${room.code}/join`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
      window.dispatchEvent(new Event('direbet:wallet-changed'));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); void loadRooms(); }
    finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!activeRoom) return;
    if (activeRoom.playerCount > 1 && !window.confirm(t('confirmCancelPublicRoom'))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${activeRoom.code}/cancel`, { method: 'POST', headers });
      const result = await response.json() as ResponseBody;
      if (!response.ok) throw new Error(result.error || t('onlineDisconnected'));
      try { if (activeRoom?.code) { sessionStorage.setItem(`direbet.exited_${gameId}`, activeRoom.code); localStorage.setItem(`direbet.exited_${gameId}`, activeRoom.code); } } catch {}
      setActiveRoom(null); setRooms((items) => items.filter((item) => item.id !== activeRoom.id));
      window.dispatchEvent(new Event('direbet:wallet-changed'));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const fullPool = amount * 2;
  const payout = fullPool;

  if (activeRoom && ['WAITING', 'FULL', 'STARTING'].includes(activeRoom.status)) {
    return <WaitingRoom
      room={activeRoom}
      countdown={countdown}
      busy={busy}
      connection={connection}
      displayName={displayName}
      onCancel={() => void cancel()}
      onBack={() => { setActiveRoom(null); void loadRooms(); }}
      t={t}
    />;
  }

  return <section className="screen public-lobby-screen">
    <header className="public-lobby-header"><button className="back-button" onClick={onExit}>← {t('home')}</button><div className="public-lobby-game"><span className={`market-game-mark ${gameId}`}>{gameSymbol(gameId)}</span><div><span className="eyebrow">{t('onlineMatches')}</span><h1>{title}</h1></div></div><span className={`market-connection ${connection}`}><i/>{connection === 'connected' ? t('marketConnected') : connection === 'connecting' ? t('marketConnecting') : t('marketOffline')}</span></header>
    <p className="public-lobby-intro">{t('marketLobbyIntro')}</p>
    
    {!token && <div className="market-signin-hint" role="status">{t('marketTelegramRequired')}</div>}
    <div className="market-room-browser">
      <div className="market-section-heading"><div><span className="eyebrow">{t('marketPublicRooms')}</span><h2>{t('marketAvailableRooms')} <b>{rooms.length}</b></h2></div><button className="market-refresh" type="button" aria-label={t('marketRefresh')} title={t('marketRefresh')} disabled={refreshing || loading} onClick={() => { setRefreshing(true); void loadRooms().finally(() => setRefreshing(false)); }}>{refreshing ? '…' : '↻'}</button></div>
      <div className="public-room-list">
        {loading ? <div className="market-empty"><span>◌</span><p>{t('marketLoading')}</p></div> : rooms.length ? rooms.map((room) => <RoomCard key={room.id} room={room} now={clockNow} busy={busy} canJoin={Boolean(token)} onJoin={() => void join(room)} t={t}/>) : <div className="market-empty compact"><span>⌁</span><div><h2>{t('marketNoRooms')}</h2><p>{t('marketNoRoomsCopy')}</p></div></div>}
      </div>
    </div>
    <div className="market-create-panel">
      <div className="market-form-heading"><div><span className="eyebrow">{t('marketCreateRoom')}</span><h2>{t('marketEntryAmount')}</h2></div><span className="market-capacity">2 {t('marketPlayersRequired')}</span></div>
      {gameId === 'ludo' && <fieldset className="market-option-field"><legend>{t('marketCrownOptions')}</legend><div className="market-crown-options">{([1, 2, 4] as const).map((count) => <button key={count} type="button" aria-pressed={crownTarget === count} className={crownTarget === count ? 'selected' : ''} onClick={() => setCrownTarget(count)}><span>{Array.from({ length: count }, (_, index) => <i key={index}>♛</i>)}</span><small>{t('marketPawnCount').replace('{count}', String(count))}</small></button>)}</div></fieldset>}
      <div className="market-option-heading"><strong>{t('marketEntryAmount')}</strong><small>{t('marketDemoCredits')}</small></div>
      <div className="market-entry-options"><button type="button" aria-pressed={entry === 'free'} className={entry === 'free' ? 'selected' : ''} onClick={() => setEntry('free')}><strong>{t('marketFree')}</strong></button>{(settings.standardAmounts.length > 0 ? settings.standardAmounts : [10, 20, 30, 50, 100, 200, 500]).map((value) => <button key={value} type="button" aria-pressed={entry === value} className={entry === value ? 'selected' : ''} onClick={() => setEntry(value)} disabled={Boolean(token && balance !== null && value > balance)}><strong>{value}</strong></button>)}{settings.customEnabled && <button type="button" aria-pressed={entry === -1} className={entry === -1 ? 'selected' : ''} onClick={() => setEntry(-1)}><strong>{t('marketCustom')}</strong></button>}</div>
      {entry === -1 && <label className="market-custom-field">{t('marketCustomAmount')}<input inputMode="numeric" type="number" min="101" max={settings.customMaximum} step="1" value={customAmount} onChange={(event) => setCustomAmount(event.target.value.replace(/\D/g, '').slice(0, 6))}/><small>{t('marketCustomHelp').replace('{max}', formatCredits(settings.customMaximum))}</small></label>}
      {gameId === 'ludo' && <fieldset className="market-color-field"><legend>{t('marketColor')}</legend><button type="button" aria-pressed={player0Color === 'yellow'} className={player0Color === 'yellow' ? 'selected' : ''} onClick={() => setPlayer0Color('yellow')}><i className="color-token yellow-token"/><span>{t('marketYellow')}</span><b>VS</b><i className="color-token red-token"/><span>{t('marketRed')}</span></button><button type="button" aria-pressed={player0Color === 'green'} className={player0Color === 'green' ? 'selected' : ''} onClick={() => setPlayer0Color('green')}><i className="color-token green-token"/><span>{t('marketGreen')}</span><b>VS</b><i className="color-token blue-token"/><span>{t('marketBlue')}</span></button></fieldset>}
      <div className="market-settings-line"><span>{t('marketMode')}</span><strong>{gameMode(gameId)}</strong></div>
      
      {insufficient && <p className="market-message" role="alert">{t('marketLowBalance')}</p>}
      {message && <p className="market-message" role="alert">{message}</p>}
      <button className="primary-button wide market-create-button" disabled={busy || !token || insufficient} onClick={() => void create()}>{busy ? t('marketCreating') : entry === 'free' ? `${t('marketCreateAction')} (${t('marketFree')})` : `${t('marketCreateAction')} · ${amount} ${t('etb')}`}<span>↗</span></button>
      <button className="market-practice-link" onClick={onPractice}>{t('marketPracticeInstead')} →</button>
    </div>
  </section>;
}

function RoomCard({ room, now, busy, canJoin, onJoin, t }: { room: MarketplaceRoom; now: number; busy: boolean; canJoin: boolean; onJoin: () => void; t: Translator }) {
  const seconds = Math.max(0, Math.ceil((room.expiresAt - now) / 1000));
  const target = room.options.crownTarget === 1 || room.options.crownTarget === 2 || room.options.crownTarget === 4 ? room.options.crownTarget : 4;
  const pair = room.options.player0Color === 'green' ? t('marketGreenVsBlue') : t('marketYellowVsRed');
  return <article className="public-room-card">
    <div className="market-room-primary"><span className="market-avatar">{room.creatorAvatar}</span><div className="market-room-player"><strong>{room.creatorName}</strong><small>{room.gameId === 'ludo' ? <><span aria-hidden="true">♛</span> {target} · {pair}</> : gameMode(room.gameId)}</small></div><div className="market-room-stake"><strong>{room.entryCredits === 0 ? t('marketFree') : formatCredits(room.entryCredits)}</strong><small>{room.entryCredits === 0 ? t('marketNoEntry') : t('marketDemoCredits')}</small></div><div className="market-room-time"><strong>{seconds}s</strong><small>{t('marketTimeLeft')}</small></div><button className="market-join-button" disabled={busy || !canJoin} onClick={onJoin}>{canJoin ? t('joinRoom') : t('marketTelegramRequired')}</button></div>
    <div className="market-room-details"><span>#{room.code}</span><span>{gameTitle(room.gameId)} · {room.mode}</span><span>{room.playerCount}/{room.capacity} {t('marketPlayersRequired')}</span></div>
  </article>;
}

function WaitingRoom({
  room,
  countdown,
  busy,
  connection,
  displayName,
  onCancel,
  onBack,
  t,
}: {
  room: MarketplaceRoom;
  countdown: number;
  busy: boolean;
  connection?: 'connecting' | 'connected' | 'offline';
  displayName?: string;
  onCancel: () => void;
  onBack: () => void;
  t: Translator;
}) {
  const [copied, setCopied] = useState(false);
  const preparing = ['FULL', 'STARTING'].includes(room.status);
  const isSettled = ['CANCELLED', 'EXPIRED'].includes(room.status);

  // Identify viewer and opponent
  const viewerSeat = room.viewerSeat ?? (room.viewerIsCreator ? 0 : 1);
  const me = room.players.find((p) => p.seat === viewerSeat) || {
    name: displayName || room.creatorName || t('marketYou'),
    avatar: room.creatorAvatar || '👤',
    seat: viewerSeat,
  };
  const opponent = room.players.find((p) => p.seat !== viewerSeat);

  const copyRoomCode = () => {
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(room.code);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  const inviteFriend = () => {
    const shareUrl = `https://t.me/Dire_Bet_bot?start=room_${room.code}`;
    const text = `Play ${gameTitle(room.gameId)} on Dire Bet with me! Room #${room.code}`;
    const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(text)}`;
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (url: string) => void } } }).Telegram?.WebApp;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(tgUrl);
    } else {
      window.open(tgUrl, '_blank');
    }
  };

  const formattedCountdown = `00:${countdown < 10 ? '0' + countdown : countdown}`;
  const entryFormatted = room.entryCredits === 0 ? t('marketFree') : `${formatCredits(room.entryCredits)} ${t('etb')}`;
  const poolFormatted = room.entryCredits === 0 ? t('marketFree') : `${formatCredits(room.poolCredits || room.entryCredits * 2)} ${t('etb')}`;

  return (
    <section className="screen market-waiting-room baron-waiting-room" aria-live="polite">
      {/* 1. Header Bar */}
      <header className="baron-waiting-header">
        <button className="baron-back-btn" onClick={onCancel} disabled={busy} title={t('marketCancelRoom')}>
          <span className="back-arrow">←</span>
          <span>{t('marketCancelRoom')}</span>
        </button>

        <div className="baron-room-badge" onClick={copyRoomCode} role="button" tabIndex={0} title="Click to copy code">
          <span className="game-icon">{gameSymbol(room.gameId)}</span>
          <span className="room-code-tag">#{room.code}</span>
          <span className="copy-icon">{copied ? '✓' : '📋'}</span>
          {copied && <span className="copied-tooltip">Copied!</span>}
        </div>

        <div className={`baron-conn-badge ${connection || 'connected'}`}>
          <span className="pulse-dot" />
          <span>{connection === 'connected' || !connection ? (preparing ? t('marketStarting') : t('marketWaiting')) : connection}</span>
        </div>
      </header>

      {/* 2. Hero Headline Banner */}
      <div className="baron-hero-headline">
        <div className="baron-mode-pill">
          <span className="glow-star">⚡</span>
          <span>1 VS 1 BATTLE ARENA</span>
        </div>
        <h2 className="baron-status-title">
          {preparing ? t('marketRoomFullCopy') : t('marketWaitingCopy')}
        </h2>
        <div className="baron-countdown-pill">
          <span className="clock-icon">⏱</span>
          <span className="countdown-digits">{formattedCountdown}</span>
          <span className="countdown-label">{t('marketTimeLeft')}</span>
        </div>
      </div>

      {/* 3. The Hero VS Battle Arena */}
      <div className="baron-vs-arena">
        {/* Player 1 (You) */}
        <div className="baron-fighter-card baron-fighter-left">
          <div className="baron-avatar-wrap pulse-glow">
            <span className="baron-avatar">{me.avatar || '👤'}</span>
            <span className="baron-you-crown">👑 YOU</span>
          </div>
          <strong className="baron-fighter-name">{me.name}</strong>
          <span className="baron-ready-pill ready">✓ READY</span>
          <div className="baron-fighter-stake">
            <small>{t('marketPerPlayer')}</small>
            <strong>{entryFormatted}</strong>
          </div>
        </div>

        {/* Center VS & Radar Pulses */}
        <div className="baron-vs-core">
          <div className="baron-radar-ripples">
            <span className="radar-ring r1" />
            <span className="radar-ring r2" />
            <span className="radar-ring r3" />
          </div>
          <div className="baron-vs-emblem">
            <span>VS</span>
          </div>
          <div className="baron-pool-box">
            <span className="pool-trophy">🏆</span>
            <div className="pool-info">
              <span className="pool-label">{t('marketEstimatedPool')}</span>
              <strong className="pool-amount">{poolFormatted}</strong>
            </div>
          </div>
        </div>

        {/* Player 2 (Opponent) */}
        <div className="baron-fighter-card baron-fighter-right">
          {opponent ? (
            <div className="baron-fighter-loaded">
              <div className="baron-avatar-wrap opponent-glow">
                <span className="baron-avatar">{opponent.avatar || '👤'}</span>
                <span className="baron-challenger-tag">CHALLENGER</span>
              </div>
              <strong className="baron-fighter-name">{opponent.name}</strong>
              <span className="baron-ready-pill ready">✓ READY</span>
              <div className="baron-fighter-stake">
                <small>{t('marketPerPlayer')}</small>
                <strong>{entryFormatted}</strong>
              </div>
            </div>
          ) : (
            <div className="baron-fighter-searching">
              <div className="baron-avatar-wrap radar-scanner">
                <div className="radar-sweep-beam" />
                <span className="radar-mystery-icon">?</span>
              </div>
              <strong className="baron-fighter-name searching-text">
                Searching<span className="animated-dots">...</span>
              </strong>
              <span className="baron-ready-pill waiting">WAITING</span>
              <button className="baron-invite-pill" type="button" onClick={inviteFriend}>
                <span>📲</span> Invite Friend
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 4. Match Spec Info Strip */}
      <div className="baron-match-spec-strip">
        <div className="spec-item">
          <span>🎮 {t('marketMode')}</span>
          <strong>{gameTitle(room.gameId)} ({room.mode})</strong>
        </div>
        <div className="spec-item">
          <span>👥 {t('marketPlayersRequired')}</span>
          <strong>{room.playerCount} / {room.capacity}</strong>
        </div>
        <div className="spec-item">
          <span>💰 {t('marketEstimatedPayout')}</span>
          <strong>{poolFormatted}</strong>
        </div>
      </div>

      {/* 5. Bottom Action & Guarantee Bar */}
      <footer className="baron-waiting-footer">
        {room.viewerIsCreator && room.status === 'WAITING' && (
          <button
            className="baron-cancel-btn"
            disabled={busy}
            onClick={onCancel}
          >
            {busy ? '…' : `✕ ${t('marketCancelRoom')}`}
          </button>
        )}
        {!room.viewerIsCreator && room.status === 'WAITING' && (
          <p className="baron-wait-notice">{t('marketWaitingCopy')}</p>
        )}

        <div className="baron-security-banner">
          <span>🔒 100% Instant Refund</span>
          <small>Held bet is returned to your wallet balance immediately upon cancel or timeout.</small>
        </div>
        <div className="baron-trust-marks">
          <span>🛡️ Provably Fair</span>
          <span>⚡ Real-Time P2P Match</span>
        </div>
      </footer>

      {/* Cancelled or Expired State Overlay */}
      {isSettled && (
        <div className="baron-settled-modal">
          <div className="baron-settled-card">
            <span className="settled-icon">{room.status === 'EXPIRED' ? '⏱' : '✕'}</span>
            <h3>{room.status === 'EXPIRED' ? t('marketRoomExpired') : t('marketRoomCancelled')}</h3>
            <p>Your entry bet of {entryFormatted} has been credited back to your balance.</p>
            <button className="primary-button wide" onClick={onBack}>
              {t('marketBackToRooms')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function gameTitle(id: GameId): string { return id === 'poker' ? 'Texas Hold’em' : id === 'xo' ? 'XO' : id === 'ludo' ? 'Ludo' : 'Checkers'; }
function gameSymbol(id: GameId): string { return id === 'ludo' ? '⚄' : id === 'checkers' ? '♛' : id === 'poker' ? '♠' : '× ○'; }
function gameMode(id: GameId): string { return id === 'ludo' ? 'Classic · two players' : id === 'poker' ? 'Heads-up' : id === 'checkers' ? 'American · two players' : 'Classic 3 × 3'; }
function formatCredits(amount: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount); }
