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
type Tab = 'rooms' | 'create';
type MarketState = { type: 'market'; rooms: MarketplaceRoom[]; ownRoom: MarketplaceRoom | null; serverTime: number };
type ResponseBody = { error?: string; room?: MarketplaceRoom | null; rooms?: MarketplaceRoom[]; ticket?: string; code?: string; gameId?: GameId; balanceCredits?: number; settings?: MarketplaceSettings };

const defaultSettings: MarketplaceSettings = { standardAmounts: [10, 20, 50, 100], customEnabled: true, customMaximum: 1000, commissionBps: 1000, waitingSeconds: 60, startingCredits: 1000 };

export default function PublicRoomLobby({ gameId, token, t, displayName, onRoom, onPractice, onExit }: Props) {
  const [tab, setTab] = useState<Tab>('rooms');
  const [rooms, setRooms] = useState<MarketplaceRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<MarketplaceRoom | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [balance, setBalance] = useState<number | null>(null);
  const [entry, setEntry] = useState<number | 'free'>(10);
  const [customAmount, setCustomAmount] = useState('150');
  const [ludoColor, setLudoColor] = useState<'blue'|'white'>('blue');
  const [countdown, setCountdown] = useState(60);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [connection, setConnection] = useState<'connecting'|'connected'|'offline'>('connecting');
  const requestKey = useRef('');
  if (!requestKey.current) requestKey.current = crypto.randomUUID();
  const launching = useRef('');
  const amount = entry === 'free' ? 0 : entry === -1 ? Number(customAmount) : entry;
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
          fetch('/api/public-rooms/balance', { headers }).then(async (response) => response.ok ? await response.json() as { balanceCredits: number } : null),
          fetch(`/api/public-rooms/mine?gameId=${gameId}`, { headers }).then((response) => response.json() as Promise<{ room?: MarketplaceRoom | null }>),
        ]);
        if (!live) return;
        if (configResult.status === 'fulfilled') setSettings(configResult.value);
        if (balanceResult.status === 'fulfilled' && balanceResult.value) setBalance(balanceResult.value.balanceCredits);
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
        body: JSON.stringify({ gameId, entry: entry === 'free' ? { kind: 'free' } : { kind: entry === -1 ? 'custom' : 'standard', amount }, options: gameId === 'ludo' ? { player0Color: ludoColor } : {}, idempotencyKey: requestKey.current }),
      });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      requestKey.current = crypto.randomUUID();
      setActiveRoom(result.room); setBalance(result.balanceCredits ?? balance); setTab('rooms');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const join = async (room: MarketplaceRoom) => {
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    const entryLabel = room.entryCredits === 0 ? t('marketFree') : `${formatCredits(room.entryCredits)} ${t('marketDemoCredits')}`;
    if (!window.confirm(t('marketJoinConfirm').replace('{game}', gameTitle(room.gameId)).replace('{amount}', entryLabel))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${room.code}/join`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      setActiveRoom(result.room); setBalance(result.balanceCredits ?? balance);
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
      <div className="market-tabs" role="tablist" aria-label={title}>
        <button role="tab" aria-selected={tab === 'rooms'} className={tab === 'rooms' ? 'active' : ''} onClick={() => { setTab('rooms'); setMessage(''); }}>{t('marketPublicRooms')}<span>{rooms.length}</span></button>
        <button role="tab" aria-selected={tab === 'create'} className={tab === 'create' ? 'active' : ''} onClick={() => { setTab('create'); setMessage(''); }}>{t('marketCreateRoom')}<span>＋</span></button>
      </div>
      {tab === 'rooms' ? <div className="public-room-list" role="tabpanel">
        {loading ? <div className="market-empty"><span>◌</span><p>{t('marketLoading')}</p></div> : rooms.length ? rooms.map((room) => <RoomCard key={room.id} room={room} busy={busy} canJoin={Boolean(token)} onJoin={() => void join(room)} t={t}/>) : <div className="market-empty"><span>⌁</span><h2>{t('marketNoRooms')}</h2><p>{t('marketNoRoomsCopy')}</p><button className="primary-button" onClick={() => { setTab('create'); setMessage(''); }}>{t('marketCreateRoom')}<span>＋</span></button></div>}
      </div> : <div className="market-create-panel" role="tabpanel">
        <div className="market-form-heading"><div><span className="eyebrow">{t('marketCreateRoom')}</span><h2>{t('marketEntryAmount')}</h2></div><span className="market-capacity">2 {t('marketPlayersRequired')}</span></div>
        <div className="market-entry-options"><button type="button" className={entry === 'free' ? 'selected' : ''} onClick={() => setEntry('free')}><strong>{t('marketFree')}</strong><small>{t('marketNoEntry')}</small></button>{settings.standardAmounts.map((value) => <button key={value} type="button" className={entry === value ? 'selected' : ''} onClick={() => setEntry(value)}><strong>{value}</strong><small>{t('marketCreditsEach')}</small></button>)}{settings.customEnabled && <button type="button" className={entry === -1 ? 'selected' : ''} onClick={() => setEntry(-1)}><strong>{t('marketCustom')}</strong><small>{t('marketCustomRange').replace('{max}', formatCredits(settings.customMaximum))}</small></button>}</div>
        {entry === -1 && <label className="market-custom-field">{t('marketCustomAmount')}<input inputMode="numeric" type="number" min="101" max={settings.customMaximum} step="1" value={customAmount} onChange={(event) => setCustomAmount(event.target.value.replace(/\D/g, '').slice(0, 6))}/><small>{t('marketCustomHelp').replace('{max}', formatCredits(settings.customMaximum))}</small></label>}
        {gameId === 'ludo' && <fieldset className="market-color-field"><legend>{t('marketYourColor')}</legend><button type="button" aria-pressed={ludoColor === 'blue'} className={ludoColor === 'blue' ? 'selected' : ''} onClick={() => setLudoColor('blue')}><i className="color-token red-token"/>{t('marketRed')}</button><button type="button" aria-pressed={ludoColor === 'white'} className={ludoColor === 'white' ? 'selected' : ''} onClick={() => setLudoColor('white')}><i className="color-token yellow-token"/>{t('marketYellow')}</button></fieldset>}
        <div className="market-settings-line"><span>{t('marketMode')}</span><strong>{gameMode(gameId)}</strong></div>
        <div className="market-preview"><span>{t('marketPerPlayer')} <strong>{entry === 'free' ? t('marketFree') : `${amount} ${t('marketDemoCredits')}`}</strong></span><span>{t('marketPlayersRequired')} <strong>2</strong></span><span>{t('marketEstimatedPool')} <strong>{formatCredits(fullPool)} {t('marketDemoCredits')}</strong></span><span>{t('marketSimulatedFee')} <strong>{formatCredits(fee)} {t('marketDemoCredits')}</strong></span><span>{t('marketEstimatedPayout')} <strong>{formatCredits(payout)} {t('marketDemoCredits')}</strong></span><small>{t('marketSimulationNote')}</small></div>
        {message && <p className="market-message" role="alert">{message}</p>}
        <button className="primary-button wide market-create-button" disabled={busy || !token} onClick={() => void create()}>{busy ? t('marketCreating') : t('marketCreateAction')}<span>↗</span></button>
        <button className="market-practice-link" onClick={onPractice}>{t('marketPracticeInstead')} →</button>
      </div>}
      {message && tab === 'rooms' && <p className="market-message" role="alert">{message}</p>}
    </> : <WaitingRoom room={activeRoom} countdown={countdown} busy={busy} onCancel={() => void cancel()} onBack={() => { setActiveRoom(null); void loadRooms(); }} t={t}/>}
  </section>;
}

function RoomCard({ room, busy, canJoin, onJoin, t }: { room: MarketplaceRoom; busy: boolean; canJoin: boolean; onJoin: () => void; t: Translator }) {
  const seconds = Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000));
  return <article className="public-room-card">
    <div className="public-room-card-head"><span className="market-avatar">{room.creatorAvatar}</span><div><strong>{room.creatorName}</strong><small>{gameTitle(room.gameId)} · {room.mode}</small></div><span className="market-room-status">{t('marketWaiting')}</span></div>
    <div className="public-room-values"><div><span>{t('marketPerPlayer')}</span><strong>{room.entryCredits === 0 ? t('marketFree') : `${room.entryCredits} ${t('marketDemoCredits')}`}</strong></div><div><span>{t('roomPlayers')}</span><strong>{room.playerCount}/{room.capacity}</strong></div><div><span>{t('marketEstimatedPool')}</span><strong>{formatCredits(room.poolCredits)}</strong></div><div><span>{t('marketTimeLeft')}</span><strong>{seconds}s</strong></div></div>
    <p className="public-room-preview">{t('marketSimulatedFee')}: {formatCredits(room.feeCredits)} · {t('marketEstimatedPayout')}: {formatCredits(room.payoutCredits)} {t('marketDemoCredits')}</p>
    <button className="primary-button wide" disabled={busy || !canJoin} onClick={onJoin}>{canJoin ? t('joinRoom') : t('marketTelegramRequired')}<span>→</span></button>
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

function gameTitle(id: GameId): string { return id === 'poker' ? 'Texas Hold’em' : id === 'xo' ? 'XO' : id === 'ludo' ? 'Ludo' : 'Dominoes'; }
function gameSymbol(id: GameId): string { return id === 'ludo' ? '⚄' : id === 'dominoes' ? '▥' : id === 'poker' ? '♠' : '× ○'; }
function gameMode(id: GameId): string { return id === 'ludo' ? 'Classic · two players' : id === 'poker' ? 'Heads-up' : id === 'dominoes' ? 'Classic · two players' : 'Classic 3 × 3'; }
function formatCredits(amount: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(amount); }
