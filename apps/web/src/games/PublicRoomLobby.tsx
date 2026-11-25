import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameId } from '@dire-bet/shared';
import type { TranslationKey } from '../i18n';
import type { MarketplaceRoom, MarketplaceSettings, RoomConfig } from './marketplaceTypes';

export type RoomAlertPrefs = { enabled: boolean; minEtb: number; maxEtb: number };

type Translator = (key: TranslationKey) => string;
type Props = {
  gameId: GameId;
  token: string | null;
  t: Translator;
  displayName: string;
  alertPrefs?: RoomAlertPrefs;
  onSaveAlertPrefs?: (prefs: RoomAlertPrefs) => Promise<void>;
  onRoomsSnapshot?: (rooms: MarketplaceRoom[]) => void;
  onRoom: (room: RoomConfig) => void;
  onPractice: () => void;
  onExit: () => void;
};
type MarketState = { type: 'market'; rooms: MarketplaceRoom[]; ownRoom: MarketplaceRoom | null; serverTime: number };
type ResponseBody = { error?: string; room?: MarketplaceRoom | null; rooms?: MarketplaceRoom[]; ticket?: string; code?: string; gameId?: GameId; balance?: number; settings?: MarketplaceSettings };

const STANDARD_PAID_AMOUNTS = [10, 30, 50, 100, 200, 300, 500];
const ALERT_ETB_OPTIONS = [0, 10, 30, 50, 100, 200, 300, 500];
const defaultAlertPrefs: RoomAlertPrefs = { enabled: false, minEtb: 10, maxEtb: 500 };
const defaultSettings: MarketplaceSettings = { standardAmounts: STANDARD_PAID_AMOUNTS, customEnabled: true, customMaximum: 1000, waitingSeconds: 30, realMoneyEnabled: false };

export default function PublicRoomLobby({ gameId, token, t, displayName, alertPrefs = defaultAlertPrefs, onSaveAlertPrefs, onRoomsSnapshot, onRoom, onPractice, onExit }: Props) {
  const isLudo = gameId === 'ludo';
  const [rooms, setRooms] = useState<MarketplaceRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<MarketplaceRoom | null>(null);
  const [pendingJoin, setPendingJoin] = useState<MarketplaceRoom | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [balance, setBalance] = useState<number | null>(null);
  const [entry, setEntry] = useState<number>(10);
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
  const [notifModalOpen, setNotifModalOpen] = useState(false);
  const [draftEnabled, setDraftEnabled] = useState(alertPrefs.enabled);
  const [draftMinEtb, setDraftMinEtb] = useState(alertPrefs.minEtb);
  const [draftMaxEtb, setDraftMaxEtb] = useState(alertPrefs.maxEtb);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifError, setNotifError] = useState('');
  const launching = useRef('');
  const creating = useRef(false);
  const settledRefresh = useRef('');
  const roomMutation = useRef(0);
  const cancelledRooms = useRef(new Set<string>());
  const onRoomsSnapshotRef = useRef(onRoomsSnapshot);
  onRoomsSnapshotRef.current = onRoomsSnapshot;
  const amount = entry === -1 ? Number(customAmount) : entry;
  const insufficient = Boolean(token && balance !== null && amount > 0 && amount > balance);
  const title = gameTitle(gameId);
  const headers = useMemo<Record<string, string>>(() => { const value: Record<string, string> = {}; if (token) value.Authorization = `Bearer ${token}`; return value; }, [token]);

  const loadRooms = useCallback(async () => {
    try {
      const response = await fetch(`/api/public-rooms?gameId=${gameId}`);
      const body = await response.json() as { rooms?: MarketplaceRoom[] };
      if (response.ok) {
        const nextRooms = (body.rooms || []).filter((room) => !cancelledRooms.current.has(room.id));
        setRooms(nextRooms);
        if (gameId === 'ludo') onRoomsSnapshotRef.current?.(nextRooms);
      }
    } catch { setConnection('offline'); }
    finally { setLoading(false); }
  }, [gameId]);

  useEffect(() => {
    let live = true;
    let socket: WebSocket | null = null;
    let poll = 0;
    let retry = 0;
    const load = async () => {
      await loadRooms();
      if (!live) return;
      const mutation = roomMutation.current;
      if (token) {
        const [configResult, balanceResult, ownResult] = await Promise.allSettled([
          fetch('/api/public-rooms/config').then((response) => response.json() as Promise<MarketplaceSettings>),
          fetch('/api/public-rooms/balance', { headers }).then(async (response) => response.ok ? await response.json() as { balance: number } : null),
          fetch(`/api/public-rooms/mine?gameId=${gameId}`, { headers }).then((response) => response.json() as Promise<{ room?: MarketplaceRoom | null }>),
        ]);
        if (!live) return;
        if (configResult.status === 'fulfilled') setSettings(configResult.value);
        if (balanceResult.status === 'fulfilled' && balanceResult.value) setBalance(balanceResult.value.balance);
        if (ownResult.status === 'fulfilled' && mutation === roomMutation.current) {
          const own = ownResult.value.room;
          if (!own || ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(own.status)) {
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
      const connect = async () => {
        if (!live) return;
        setConnection('connecting');
        const ticketResponse = token ? await fetch('/api/public-rooms/ws-ticket', { method: 'POST', headers }).catch(() => null) : null;
        const ticketBody = ticketResponse?.ok ? await ticketResponse.json() as { ticket?: string } : null;
        if (!live) return;
        if (token && !ticketBody?.ticket) {
          setConnection('offline');
          retry = window.setTimeout(() => void connect(), 3000);
          return;
        }
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
            const visibleRooms = (snapshot.rooms || []).filter((room) => room.id !== snapshot.ownRoom?.id && !cancelledRooms.current.has(room.id));
            setRooms(visibleRooms);
            if (gameId === 'ludo') onRoomsSnapshotRef.current?.(visibleRooms);
            if (snapshot.ownRoom && !cancelledRooms.current.has(snapshot.ownRoom.id)) {
              if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(snapshot.ownRoom.status)) {
                setActiveRoom(null);
              } else {
                setActiveRoom((current) => !current || current.id === snapshot.ownRoom?.id ? snapshot.ownRoom : current);
              }
            } else {
              setActiveRoom((current) => {
                if (current && ['WAITING', 'FULL', 'STARTING', 'IN_PROGRESS', 'SETTLING'].includes(current.status)) {
                  return current;
                }
                return null;
              });
            }
            setConnection('connected');
          } catch { setConnection('offline'); }
        };
        socket.onclose = () => {
          if (!live) return;
          setConnection('offline');
          retry = window.setTimeout(() => void connect(), 3000);
        };
        socket.onerror = () => { if (live) setConnection('offline'); };
      };
      void connect();
      const pollMarket = async () => {
        void loadRooms();
        if (token) {
          try {
            const res = await fetch(`/api/public-rooms/mine?gameId=${gameId}`, { headers });
            if (res.ok) {
              const data = await res.json() as { room?: MarketplaceRoom | null };
              const mine = data.room;
              if (mine && !cancelledRooms.current.has(mine.id)) {
                if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(mine.status)) {
                  setActiveRoom(null);
                } else {
                  setActiveRoom((current) => !current || current.id === mine.id ? mine : current);
                }
              }
            }
          } catch {}
        }
      };
      poll = window.setInterval(() => void pollMarket(), 3000);
    };
    void load();
    return () => { live = false; if (poll) window.clearInterval(poll); if (retry) window.clearTimeout(retry); socket?.close(1000, 'Leaving public room list'); };
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

  const create = async () => {
    if (entry === 0) {
      onPractice();
      return;
    }
    if (creating.current) return;
    launching.current = '';
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    if (!Number.isSafeInteger(amount) || amount <= 0 || (entry === -1 && (amount <= 100 || amount > settings.customMaximum))) { setMessage(t('marketAmountInvalid')); return; }
    creating.current = true;
    setBusy(true); setMessage('');
    try {
      const freshKey = crypto.randomUUID();
      const entryPayload = { kind: entry === -1 ? 'custom' : 'standard', amount };
      const response = await fetch('/api/public-rooms', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ gameId, entry: entryPayload, options: isLudo ? { player0Color, crownTarget } : {}, idempotencyKey: freshKey }),
      });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      roomMutation.current += 1; cancelledRooms.current.delete(result.room.id);
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
      window.dispatchEvent(new Event('direbet:wallet-changed'));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { creating.current = false; setBusy(false); }
  };

  const openNotifModal = () => {
    setDraftEnabled(alertPrefs.enabled);
    setDraftMinEtb(alertPrefs.minEtb);
    setDraftMaxEtb(alertPrefs.maxEtb);
    setNotifError('');
    setNotifModalOpen(true);
  };

  const saveNotifModal = async () => {
    if (notifSaving) return;
    if (draftMinEtb > draftMaxEtb) {
      setNotifError('Min Birr cannot exceed Max Birr.');
      return;
    }
    setNotifSaving(true);
    setNotifError('');
    try {
      await onSaveAlertPrefs?.({ enabled: draftEnabled, minEtb: draftMinEtb, maxEtb: draftMaxEtb });
      setNotifModalOpen(false);
    } catch (cause) {
      setNotifError(cause instanceof Error ? cause.message : t('onlineDisconnected'));
    } finally {
      setNotifSaving(false);
    }
  };

  const join = async (room: MarketplaceRoom) => {
    launching.current = '';
    if (!token) { setMessage(t('marketTelegramRequired')); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${room.code}/join`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.room) throw new Error(result.error || t('onlineDisconnected'));
      roomMutation.current += 1; cancelledRooms.current.delete(result.room.id);
      setActiveRoom(result.room); setBalance(result.balance ?? balance);
      window.dispatchEvent(new Event('direbet:wallet-changed'));
      setPendingJoin(null);

      if (result.ticket && result.code && result.gameId) {
        launching.current = result.room.id;
        onRoom({ code: result.code, ticket: result.ticket, gameId: result.gameId, publicRoom: result.room });
        return;
      }
      if (['IN_PROGRESS', 'STARTING', 'SETTLING'].includes(result.room.status)) {
        try {
          const sessionRes = await fetch(`/api/public-rooms/${result.room.code}/session`, { headers });
          const sessionResult = await sessionRes.json() as ResponseBody;
          if (sessionRes.ok && sessionResult.ticket && sessionResult.code && sessionResult.gameId) {
            launching.current = result.room.id;
            onRoom({ code: sessionResult.code, ticket: sessionResult.ticket, gameId: sessionResult.gameId, publicRoom: sessionResult.room || result.room });
            return;
          }
        } catch { /* The room card offers an explicit resume action. */ }
      }
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); void loadRooms(); }
    finally { setBusy(false); }
  };

  const resume = async () => {
    if (!token || !activeRoom || launching.current === activeRoom.id) return;
    launching.current = activeRoom.id;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${activeRoom.code}/session`, { headers });
      const result = await response.json() as ResponseBody;
      if (!response.ok || !result.ticket || !result.code || !result.gameId) throw new Error(result.error || t('onlineDisconnected'));
      onRoom({ code: result.code, ticket: result.ticket, gameId: result.gameId, publicRoom: result.room || activeRoom });
    } catch (cause) {
      launching.current = '';
      setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected'));
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!activeRoom) return;
    if (activeRoom.playerCount > 1 && !window.confirm(t('confirmCancelPublicRoom'))) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/public-rooms/${activeRoom.code}/cancel`, { method: 'POST', headers });
      const result = await response.json() as ResponseBody;
      if (!response.ok) throw new Error(result.error || t('onlineDisconnected'));
      roomMutation.current += 1; cancelledRooms.current.add(activeRoom.id);
      setActiveRoom(null); setRooms((items) => items.filter((item) => item.id !== activeRoom.id));
      window.dispatchEvent(new Event('direbet:wallet-changed'));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };

  const createDisabled = entry === 0
    ? busy
    : busy || !token || insufficient || Boolean(activeRoom && ['WAITING', 'FULL', 'STARTING'].includes(activeRoom.status));

  // Inline active room in public lobby

  return <section className={`screen public-lobby-screen ludo-lobby-screen lobby-game-${gameId}`}>
    <header className="public-lobby-header compact-header"><button className="back-button market-back-button" type="button" onClick={onExit}>← {t('home')}</button><span className={`market-connection ${connection}`}><i/>{connection === 'connected' ? t('marketConnected') : connection === 'connecting' ? t('marketConnecting') : t('marketOffline')}</span></header>
    
    {!token && <div className="market-signin-hint" role="status">{t('marketTelegramRequired')}</div>}
    <div className="lobby-split-panels">
      <div className="market-room-browser">
        <div className={`market-section-heading${!loading && !activeRoom && rooms.length === 0 ? ' compact-empty-heading' : ''}`}>
          <div><h2>{t('marketAvailableRooms')} <b>{rooms.length}</b></h2></div>
          <div className="market-heading-actions">
            <button
              className={`market-notif-btn ${alertPrefs.enabled ? 'is-enabled' : ''}`}
              type="button"
              aria-label={t('notifAria')}
              title={t('notifAria')}
              onClick={openNotifModal}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              {alertPrefs.enabled && <i className="notif-active-dot" aria-hidden="true"/>}
            </button>
            <button className="market-refresh" type="button" aria-label={t('marketRefresh')} title={t('marketRefresh')} disabled={refreshing || loading} onClick={() => { setRefreshing(true); void loadRooms().finally(() => setRefreshing(false)); }}>{refreshing ? '…' : '↻'}</button>
          </div>
        </div>
        {(activeRoom || loading || rooms.length > 0) && <div className="public-room-list">
          {activeRoom && ['WAITING', 'FULL', 'STARTING'].includes(activeRoom.status) && (
            <article className="public-room-card my-active-room" style={{ borderColor: '#ffc840', background: 'linear-gradient(115deg, #2b2612ed, #161c2bed)' }}>
              <div className="market-room-primary">
                <span className="market-avatar" style={{ borderColor: '#ffc840', background: '#e5a812', color: '#000', fontWeight: 'bold' }}>👑</span>
                <div className="market-room-player">
                  <strong>{t('marketYou')} (#{activeRoom.code})</strong>
                  <small style={{ color: '#ffc840' }}>⏳ {t('marketWaiting')}</small>
                </div>
                <div className="market-room-stake">
                  <strong>{activeRoom.entryCredits === 0 ? t('marketFree') : formatCredits(activeRoom.entryCredits)}</strong>
                  <small>{activeRoom.entryCredits === 0 ? t('marketNoEntry') : t('marketDemoCredits')}</small>
                </div>
                <div className="market-room-time">
                  <strong style={{ color: '#ffc840' }}>{Math.max(0, Math.ceil((activeRoom.expiresAt - clockNow) / 1000))}s</strong>
                  <small>{t('marketTimeLeft')}</small>
                </div>
                <button
                  className="market-join-button"
                  style={{ background: 'linear-gradient(145deg, #d83a3a, #991b1b)', borderColor: '#ef4444', color: '#fff' }}
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  {busy ? '…' : t('marketCancelRoom')}
                </button>
              </div>
              <div className="market-room-details">
                <span>#{activeRoom.code}</span>
                <span>{gameTitle(activeRoom.gameId)}</span>
                <span>1/{activeRoom.capacity} {t('marketPlayersRequired')}</span>
              </div>
            </article>
          )}
          {activeRoom?.status === 'IN_PROGRESS' && <article className="public-room-card my-active-room" style={{ borderColor: '#ffc840', background: 'linear-gradient(115deg, #2b2612ed, #161c2bed)' }}>
            <div className="market-room-primary">
              <span className="market-avatar" style={{ borderColor: '#ffc840', background: '#e5a812', color: '#000', fontWeight: 'bold' }}>🎮</span>
              <div className="market-room-player"><strong>{t('marketYou')} (#{activeRoom.code})</strong><small style={{ color: '#ffc840' }}>{t('marketInProgress')}</small></div>
              <div className="market-room-stake"><strong>{activeRoom.entryCredits === 0 ? t('marketFree') : formatCredits(activeRoom.entryCredits)}</strong><small>{activeRoom.entryCredits === 0 ? t('marketNoEntry') : t('marketDemoCredits')}</small></div>
              <button className="market-join-button" disabled={busy || !token} onClick={() => void resume()}>{busy ? '…' : t('marketResumeMatch')}</button>
            </div>
          </article>}
          {loading ? <p className="market-loading-text">{t('marketLoading')}</p> : rooms.filter((r) => r.id !== activeRoom?.id).map((room) => <RoomCard key={room.id} room={room} now={clockNow} busy={busy} canJoin={Boolean(token)} onJoin={() => { setMessage(''); setPendingJoin(room); }} t={t}/>)}
        </div>}
      </div>
      <div className="market-create-panel">
        <div className="market-form-heading"><div><h2>{t('marketCreateRoom')}</h2></div><span className="market-capacity">2 {t('marketPlayersRequired')}</span></div>
        {isLudo && <fieldset className="market-option-field"><legend>{t('marketCrownOptions')}</legend><div className="market-crown-options">{([1, 2, 4] as const).map((count) => <button key={count} type="button" aria-pressed={crownTarget === count} className={crownTarget === count ? 'selected' : ''} onClick={() => setCrownTarget(count)}><span>{Array.from({ length: count }, (_, index) => <i key={index}>♛</i>)}</span><small>{t('marketPawnCount').replace('{count}', String(count))}</small></button>)}</div></fieldset>}
        <div className="market-option-heading"><strong>{t('marketEntryAmount')}</strong><small>{t('marketDemoCredits')}</small></div>
        <div className="market-entry-options ludo-entry-options"><button type="button" aria-pressed={entry === 0} className={entry === 0 ? 'selected' : ''} onClick={() => setEntry(0)}><strong>{t('marketFree')}</strong></button>{STANDARD_PAID_AMOUNTS.map((value) => <button key={value} type="button" aria-pressed={entry === value} className={entry === value ? 'selected' : ''} onClick={() => setEntry(value)} disabled={Boolean(token && balance !== null && value > balance)}><strong>{value}</strong></button>)}</div>
        {isLudo && <fieldset className="market-color-field ludo-color-circles"><legend>{t('marketColor')}</legend><button type="button" aria-label={`${t('marketYellow')} vs ${t('marketBlue')}`} aria-pressed={player0Color === 'yellow'} className={`color-choice-yellow ${player0Color === 'yellow' ? 'selected' : ''}`} onClick={() => setPlayer0Color('yellow')}><i className="color-token yellow-token"/><b>VS</b><i className="color-token blue-token"/></button><button type="button" aria-label={`${t('marketGreen')} vs ${t('marketBlue')}`} aria-pressed={player0Color === 'green'} className={`color-choice-green ${player0Color === 'green' ? 'selected' : ''}`} onClick={() => setPlayer0Color('green')}><i className="color-token green-token"/><b>VS</b><i className="color-token blue-token"/></button></fieldset>}
        
        {entry !== 0 && insufficient && <p className="market-message" role="alert">{t('marketLowBalance')}</p>}
        {message && <p className="market-message" role="alert">{message}</p>}
        <button className="primary-button wide market-create-button" disabled={createDisabled} onClick={() => void create()}>
          {entry === 0
            ? `${t('marketStartFreePractice')} · ${t('marketFree')}`
            : busy
              ? t('marketCreating')
              : activeRoom && ['WAITING', 'FULL', 'STARTING'].includes(activeRoom.status)
                ? `⏳ ${t('marketWaiting')} (#${activeRoom.code})`
                : `${t('marketCreateAction')} · ${amount} ${t('etb')}`}
          <span>↗</span>
        </button>
      </div>
    </div>
    {notifModalOpen && (
      <div className="scrim notif-modal-scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !notifSaving && setNotifModalOpen(false)}>
        <section className="notif-settings-modal" role="dialog" aria-modal="true" aria-labelledby="notif-settings-title">
          <div className="notif-modal-head">
            <span className="notif-modal-bell" aria-hidden="true">🔔</span>
            <h2 id="notif-settings-title">{t('notifModalTitle')}</h2>
          </div>
          <p className="notif-modal-desc">{t('notifModalDesc')}</p>
          <label className="notif-toggle-row">
            <span>{t('notifEnableAlerts')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={draftEnabled}
              className={`notif-toggle-switch ${draftEnabled ? 'is-on' : ''}`}
              onClick={() => setDraftEnabled((current) => !current)}
            >
              <i/>
            </button>
          </label>
          <div className="notif-range-grid">
            <label className="notif-range-field">
              <span>{t('notifMinEtb')}</span>
              <select
                className="notif-dropdown"
                value={draftMinEtb}
                onChange={(event) => {
                  const nextMin = Number(event.target.value);
                  setDraftMinEtb(nextMin);
                  if (nextMin > draftMaxEtb) setDraftMaxEtb(nextMin);
                }}
              >
                {ALERT_ETB_OPTIONS.map((value) => (
                  <option key={value} value={value}>{value === 0 ? t('marketFree') : `${value} ${t('etb')}`}</option>
                ))}
              </select>
            </label>
            <label className="notif-range-field">
              <span>{t('notifMaxEtb')}</span>
              <select
                className="notif-dropdown"
                value={draftMaxEtb}
                onChange={(event) => {
                  const nextMax = Number(event.target.value);
                  setDraftMaxEtb(nextMax);
                  if (nextMax < draftMinEtb) setDraftMinEtb(nextMax);
                }}
              >
                {ALERT_ETB_OPTIONS.map((value) => (
                  <option key={value} value={value}>{value === 0 ? t('marketFree') : `${value} ${t('etb')}`}</option>
                ))}
              </select>
            </label>
          </div>
          {notifError && <p className="market-message" role="alert">{notifError}</p>}
          <div className="notif-modal-actions">
            <button className="notif-save-btn" type="button" disabled={notifSaving} onClick={() => void saveNotifModal()}>
              <span aria-hidden="true">💾</span> {notifSaving ? '…' : t('notifSave')}
            </button>
            <button className="notif-cancel-btn" type="button" disabled={notifSaving} onClick={() => setNotifModalOpen(false)}>
              {t('cancelAction')}
            </button>
          </div>
        </section>
      </div>
    )}
    {pendingJoin && <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && setPendingJoin(null)}><section className="bottom-sheet simple-sheet" role="dialog" aria-modal="true" aria-labelledby="market-join-title"><div className="sheet-handle"/><button className="sheet-close" type="button" disabled={busy} onClick={() => setPendingJoin(null)} aria-label={t('close')}><span aria-hidden="true">×</span></button><span className="eyebrow">{t('marketPublicRooms')}</span><h2 id="market-join-title">{t('joinRoom')}</h2><p>{t('marketJoinConfirm').replace('{game}', gameTitle(pendingJoin.gameId)).replace('{amount}', pendingJoin.entryCredits === 0 ? t('marketFree') : `${formatCredits(pendingJoin.entryCredits)} ${t('etb')}`)}</p>{message && <p className="auth-message" role="alert">{message}</p>}<div className="game-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setPendingJoin(null)}>{t('cancelAction')}</button><button className="primary-button" type="button" disabled={busy || !token} onClick={() => void join(pendingJoin)}>{busy ? t('onlineConnecting') : t('joinRoom')}</button></div></section></div>}
  </section>;
}

function RoomCard({ room, now, busy, canJoin, onJoin, t }: { room: MarketplaceRoom; now: number; busy: boolean; canJoin: boolean; onJoin: () => void; t: Translator }) {
  const seconds = Math.max(0, Math.ceil((room.expiresAt - now) / 1000));
  const target = room.options.crownTarget === 1 || room.options.crownTarget === 2 || room.options.crownTarget === 4 ? room.options.crownTarget : 4;
  const pair = room.options.player0Color === 'green' ? t('marketGreenVsBlue') : `${t('marketYellow')} vs ${t('marketBlue')}`;
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
        {room.viewerIsCreator && ['WAITING', 'FULL', 'STARTING'].includes(room.status) && (
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
