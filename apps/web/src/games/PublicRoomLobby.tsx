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

const defaultSettings: MarketplaceSettings = { standardAmounts: [], customEnabled: false, customMaximum: 1000, commissionBps: 0, waitingSeconds: 30, realMoneyEnabled: false };

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
          setActiveRoom(ownResult.value.room);
          setRooms((current) => current.filter((room) => room.id !== ownResult.value.room?.id));
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
          if (snapshot.ownRoom) setActiveRoom((current) => !current || current.id === snapshot.ownRoom?.id ? snapshot.ownRoom : current);
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
    if (!token || !activeRoom || !['IN_PROGRESS', 'COMPLETED'].includes(activeRoom.status) || launching.current === activeRoom.id) return;
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
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    if (entry !== 'free' && (!Number.isSafeInteger(amount) || amount <= 0 || (entry === -1 && (amount <= 100 || amount > settings.customMaximum)))) { setMessage(t('marketAmountInvalid')); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/public-rooms', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ gameId, entry: entry === 'free' ? { kind: 'free' } : { kind: entry === -1 ? 'custom' : 'standard', amount }, options: gameId === 'ludo' ? { player0Color, crownTarget } : {}, idempotencyKey: requestKey.current }),
      });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      requestKey.current = crypto.randomUUID();
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const join = async (room: MarketplaceRoom) => {
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    const entryLabel = room.entryCredits === 0 ? t('marketFree') : `${formatCredits(room.entryCredits)} ETB`;
    if (!window.confirm(t('marketJoinConfirm').replace('{game}', gameTitle(room.gameId)).replace('{amount}', entryLabel))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${room.code}/join`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
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
      setActiveRoom(result.room || null); setRooms((items) => items.filter((item) => item.id !== activeRoom.id));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const fullPool = amount * 2;
  const fee = Math.floor(fullPool * settings.commissionBps / 10000);
  const payout = fullPool - fee;

  return <section className="screen public-lobby-screen">
    <header className="public-lobby-header"><button className="back-button" onClick={onExit}>← {t('home')}</button><div className="public-lobby-game"><span className={`market-game-mark ${gameId}`}>{gameSymbol(gameId)}</span><div><span className="eyebrow">{t('onlineMatches')}</span><h1>{title}</h1></div></div><span className={`market-connection ${connection}`}><i/>{connection === 'connected' ? t('marketConnected') : connection === 'connecting' ? t('marketConnecting') : t('marketOffline')}</span></header>
    <p className="public-lobby-intro">{t('marketLobbyIntro')}</p>
    {token && balance !== null && <div className="demo-credit-balance"><span>{t('marketDemoBalance')}</span><strong>{formatCredits(balance)}</strong><small>{t('marketCreditOnly')}</small></div>}
    {!token && <div className="market-signin-hint" role="status">{t('marketTelegramRequired')}</div>}
    {!activeRoom ? <>
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
        <div className="market-entry-options"><button type="button" aria-pressed={entry === 'free'} className={entry === 'free' ? 'selected' : ''} onClick={() => setEntry('free')}><strong>{t('marketFree')}</strong></button>{settings.standardAmounts.map((value) => <button key={value} type="button" aria-pressed={entry === value} className={entry === value ? 'selected' : ''} onClick={() => setEntry(value)} disabled={Boolean(token && balance !== null && value > balance)}><strong>{value}</strong></button>)}{settings.customEnabled && <button type="button" aria-pressed={entry === -1} className={entry === -1 ? 'selected' : ''} onClick={() => setEntry(-1)}><strong>{t('marketCustom')}</strong></button>}</div>
        {entry === -1 && <label className="market-custom-field">{t('marketCustomAmount')}<input inputMode="numeric" type="number" min="101" max={settings.customMaximum} step="1" value={customAmount} onChange={(event) => setCustomAmount(event.target.value.replace(/\D/g, '').slice(0, 6))}/><small>{t('marketCustomHelp').replace('{max}', formatCredits(settings.customMaximum))}</small></label>}
        {gameId === 'ludo' && <fieldset className="market-color-field"><legend>{t('marketColor')}</legend><button type="button" aria-pressed={player0Color === 'yellow'} className={player0Color === 'yellow' ? 'selected' : ''} onClick={() => setPlayer0Color('yellow')}><i className="color-token yellow-token"/><span>{t('marketYellow')}</span><b>VS</b><i className="color-token red-token"/><span>{t('marketRed')}</span></button><button type="button" aria-pressed={player0Color === 'green'} className={player0Color === 'green' ? 'selected' : ''} onClick={() => setPlayer0Color('green')}><i className="color-token green-token"/><span>{t('marketGreen')}</span><b>VS</b><i className="color-token blue-token"/><span>{t('marketBlue')}</span></button></fieldset>}
        <div className="market-settings-line"><span>{t('marketMode')}</span><strong>{gameMode(gameId)}</strong></div>
        <div className="market-preview"><span>{t('marketPerPlayer')} <strong>{entry === 'free' ? t('marketFree') : `${amount} ${t('marketDemoCredits')}`}</strong></span><span>{t('marketPlayersRequired')} <strong>2</strong></span><span>{t('marketEstimatedPool')} <strong>{formatCredits(fullPool)} {t('marketDemoCredits')}</strong></span><span>{t('marketSimulatedFee')} <strong>{formatCredits(fee)} {t('marketDemoCredits')}</strong></span><span>{t('marketEstimatedPayout')} <strong>{formatCredits(payout)} {t('marketDemoCredits')}</strong></span><small>{t('marketSimulationNote')}</small></div>
        {insufficient && <p className="market-message" role="alert">{t('marketLowBalance')}</p>}
        {message && <p className="market-message" role="alert">{message}</p>}
        <button className="primary-button wide market-create-button" disabled={busy || !token || insufficient} onClick={() => void create()}>{busy ? t('marketCreating') : t('marketCreateAction')}<span>↗</span></button>
        <button className="market-practice-link" onClick={onPractice}>{t('marketPracticeInstead')} →</button>
      </div>
    </> : <WaitingRoom room={activeRoom} countdown={countdown} busy={busy} onCancel={() => void cancel()} onBack={() => { setActiveRoom(null); void loadRooms(); }} t={t}/>}
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

function WaitingRoom({ room, countdown, busy, onCancel, onBack, t }: { room: MarketplaceRoom; countdown: number; busy: boolean; onCancel: () => void; onBack: () => void; t: Translator }) {
  const preparing = ['FULL', 'STARTING'].includes(room.status);
  return <section className="market-waiting-room" aria-live="polite">
    <div className="market-waiting-title"><span className="market-room-status">{preparing ? t('marketStarting') : t('marketWaiting')}</span><h2>{preparing ? t('marketRoomFullCopy') : t('marketWaitingCopy')}</h2><p>{gameTitle(room.gameId)} · {room.mode}</p></div>
    <div className="market-room-id"><span>{t('marketRoomId')}</span><strong>#{room.code}</strong><small>{preparing ? t('marketPreparingGame') : `${t('marketTimeLeft')} · ${countdown}s`}</small></div>
    <div className="market-waiting-players">{Array.from({ length: room.capacity }, (_, index) => {
      const player = room.players.find((seat) => seat.seat === index);
      return <div className={`market-wait-seat ${player ? 'occupied' : ''}`} key={index}>{player ? <><span className="market-avatar">{player.avatar}</span><span><strong>{player.name}</strong><small>{room.viewerSeat === index ? t('marketYou') : t('marketPlayer')}</small></span><i>●</i></> : <><span className="market-seat-empty">＋</span><span><strong>{t('marketOpenSeat')}</strong><small>{t('marketWaiting')}</small></span></>}</div>;
    })}</div>
    <div className="market-waiting-entry"><span>{t('marketPerPlayer')} <strong>{room.entryCredits === 0 ? t('marketFree') : `${room.entryCredits} ${t('marketDemoCredits')}`}</strong></span><span>{t('marketEstimatedPool')} <strong>{formatCredits(room.poolCredits)} {t('marketDemoCredits')}</strong></span><span>{t('marketSimulatedFee')} <strong>{formatCredits(room.feeCredits)} {t('marketDemoCredits')}</strong></span></div>
    {room.viewerIsCreator && room.status === 'WAITING' && <button className="secondary-button wide market-cancel-button" disabled={busy} onClick={onCancel}>{t('marketCancelRoom')}</button>}
    {!room.viewerIsCreator && <p className="market-wait-note">{t('marketWaitingCopy')}</p>}
    {room.status === 'CANCELLED' || room.status === 'EXPIRED' ? <div className="market-expired-state"><p>{room.status === 'EXPIRED' ? t('marketRoomExpired') : t('marketRoomCancelled')}</p><button className="secondary-button" onClick={onBack}>{t('marketBackToRooms')}</button></div> : null}
  </section>;
}

function gameTitle(id: GameId): string { return id === 'poker' ? 'Texas Hold’em' : id === 'xo' ? 'XO' : id === 'ludo' ? 'Ludo' : 'Checkers'; }
function gameSymbol(id: GameId): string { return id === 'ludo' ? '⚄' : id === 'checkers' ? '♛' : id === 'poker' ? '♠' : '× ○'; }
function gameMode(id: GameId): string { return id === 'ludo' ? 'Classic · two players' : id === 'poker' ? 'Heads-up' : id === 'checkers' ? 'American · two players' : 'Classic 3 × 3'; }
function formatCredits(amount: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount); }
