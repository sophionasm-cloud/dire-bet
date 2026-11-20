import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameId } from '@dire-bet/shared';
import type { MarketplaceRoom, MarketplaceSettings, PublicRoomStatus } from '../games/marketplaceTypes';

type Props = { token: string | null };
type Stats = { total: number; active: number; waiting: number; full: number; inProgress: number; completed: number; cancelled: number; expired: number; realVolumeEtb: number; averagePlayers: number };
type Audit = { adminId: number; action: string; entityId: string | null; detail: Record<string, unknown>; createdAt: number };
type RoomEvent = { type: string; actorId: number | null; detail: Record<string, unknown>; createdAt: number };
type AdminData = { stats: Stats; settings: MarketplaceSettings; rooms: MarketplaceRoom[]; audit: Audit[] };
type Detail = { room: MarketplaceRoom; events: RoomEvent[] };
type ErrorBody = { error?: string };

const games: { id: GameId | ''; name: string }[] = [
  { id: '', name: 'All games' }, { id: 'ludo', name: 'Ludo' }, { id: 'checkers', name: 'Checkers' }, { id: 'poker', name: 'Texas Hold’em' }, { id: 'xo', name: 'XO' },
];

export default function RoomManagement({ token }: Props) {
  const [filter, setFilter] = useState<GameId | ''>('');
  const [data, setData] = useState<AdminData | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [standardText, setStandardText] = useState('10, 20, 30, 50, 100, 200, 300, 400, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000');
  const [maximumText, setMaximumText] = useState('1000');
  const [waitingText, setWaitingText] = useState('30');
  const [customEnabled, setCustomEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!token) { setLoading(false); setError('Sign in with the owner Telegram account to view room management.'); return; }
    setLoading(true); setError('');
    try {
      const query = filter ? `?gameId=${filter}` : '';
      const response = await fetch(`/api/admin/public-rooms${query}`, { headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json() as AdminData & ErrorBody;
      if (!response.ok) throw new Error(result.error || 'Room management is not available.');
      setData(result);
      setStandardText(result.settings.standardAmounts.join(', '));
      setMaximumText(String(result.settings.customMaximum));
      setWaitingText(String(result.settings.waitingSeconds));
      setCustomEnabled(result.settings.customEnabled);
      setNotice('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Room information could not be loaded.'); }
    finally { setLoading(false); }
  }, [filter, token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId || !token) { setDetail(null); return; }
    let live = true;
    fetch(`/api/admin/public-rooms/${selectedId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const result = await response.json() as Detail & ErrorBody;
        if (!response.ok) throw new Error(result.error || 'Room details could not be loaded.');
        if (live) setDetail(result);
      })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : 'Room details could not be loaded.'); });
    return () => { live = false; };
  }, [selectedId, token]);

  const save = async () => {
    if (!token) return;
    const standardAmounts = standardText.split(',').map((value) => Number(value.trim()));
    const customMaximum = Number(maximumText);
    const waitingSeconds = Number(waitingText);
    if (standardAmounts.some((value) => !Number.isSafeInteger(value)) || !Number.isSafeInteger(customMaximum) || !Number.isSafeInteger(waitingSeconds)) {
      setError('Use whole numbers for entry amounts, the maximum and waiting time.'); return;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/admin/public-rooms/settings', {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ standardAmounts, customEnabled, customMaximum, waitingSeconds }),
      });
      const result = await response.json() as { settings?: MarketplaceSettings } & ErrorBody;
      if (!response.ok || !result.settings) throw new Error(result.error || 'Settings could not be saved.');
      setNotice('Room settings saved. New rooms have no platform commission.');
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Settings could not be saved.'); }
    finally { setSaving(false); }
  };

  const cancel = async (room: MarketplaceRoom) => {
    if (!token || !window.confirm(`Cancel room ${room.code}? Any held wallet funds will be returned. The game result will not be changed.`)) return;
    setError(''); setNotice('');
    try {
      const response = await fetch(`/api/admin/public-rooms/${room.code}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const result = await response.json() as ErrorBody;
      if (!response.ok) throw new Error(result.error || 'Room could not be cancelled.');
      setNotice(`Room ${room.code} cancelled; held wallet funds were returned.`);
      setSelectedId(''); setDetail(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Room could not be cancelled.'); }
  };

  const activeRooms = useMemo(() => data?.rooms || [], [data]);
  if (loading && !data) return <div className="room-admin-state" role="status">Loading room activity…</div>;
  if (error && !data) return <section className="room-admin-state"><p role="alert">{error}</p><p>Room controls only open for the configured Super Admin Telegram account.</p><button className="secondary-button" onClick={() => void load()}>Try again ↻</button></section>;
  if (!data) return <div className="room-admin-state">Room data is not available.</div>;

  return <div className="room-management">
    {error && <p className="room-admin-error" role="alert">{error}</p>}
    {notice && <p className="room-admin-notice" role="status">{notice}</p>}
    <div className="room-management-heading"><div><h2>ROOM MANAGEMENT</h2><p>ETB totals include completed real-money rooms only. Free and legacy preview rooms are excluded.</p></div><label>Game filter<select value={filter} onChange={(event) => setFilter(event.target.value as GameId | '')}>{games.map((game) => <option key={game.id || 'all'} value={game.id}>{game.name}</option>)}</select></label></div>

    <div className="room-admin-metrics">
      <Metric label="Active rooms" value={data.stats.active}/><Metric label="Waiting" value={data.stats.waiting}/><Metric label="Full" value={data.stats.full}/><Metric label="Games running" value={data.stats.inProgress}/><Metric label="Completed" value={data.stats.completed}/><Metric label="Expired / cancelled" value={`${data.stats.expired} / ${data.stats.cancelled}`}/>
    </div>
    <div className="room-simulated-summary"><span>REAL ROOM VOLUME <strong>{formatCredits(data.stats.realVolumeEtb)} ETB</strong></span><span>COMPLETED ROOMS <strong>{data.stats.completed}</strong></span><span>AVERAGE PLAYERS PER ROOM <strong>{data.stats.averagePlayers}</strong></span></div>

    <section className="room-admin-section"><div className="room-admin-section-head"><div><span className="staff-label">MARKETPLACE</span><h3>Room activity</h3></div><button className="staff-link-button" onClick={() => void load()} disabled={loading}>Refresh ↻</button></div>
      <div className="room-admin-table-wrap"><table className="room-admin-table"><thead><tr><th>Room</th><th>Game</th><th>Creator</th><th>Players</th><th>Entry each</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>{activeRooms.length ? activeRooms.map((room) => <tr key={room.id}><td><strong>{room.code}</strong></td><td>{gameTitle(room.gameId)}</td><td>{room.creatorName}</td><td>{room.playerCount}/{room.capacity}</td><td>{room.walletKind === 'real' && room.entryCredits ? `${room.entryCredits} ETB` : 'FREE'}</td><td><span className={`room-admin-status ${room.status.toLowerCase()}`}>{room.status}</span></td><td>{new Date(room.createdAt).toLocaleString()}</td><td><button className="room-admin-view" onClick={() => setSelectedId(room.id)}>Details</button></td></tr>) : <tr><td colSpan={8}>No rooms match this filter.</td></tr>}</tbody></table></div>
    </section>

    <section className="room-admin-section room-settings-section"><div className="room-admin-section-head"><div><span className="staff-label">SUPER ADMIN ONLY</span><h3>Room settings</h3></div><span className="room-admin-status waiting">NEW ROOMS ONLY</span></div>
      <div className="room-setting-grid"><label>Standard ETB entries<input value={standardText} onChange={(event) => setStandardText(event.target.value)} placeholder="10, 20, 50, 100"/><small>Comma-separated whole-birr amounts.</small></label><label>Custom maximum<input inputMode="numeric" value={maximumText} onChange={(event) => setMaximumText(event.target.value.replace(/\D/g, '').slice(0, 6))}/><small>Custom entries must be above 100 ETB.</small></label><label>Waiting time (seconds)<input type="number" min="15" max="180" step="1" value={waitingText} onChange={(event) => setWaitingText(event.target.value)}/><small>Default is 30 seconds.</small></label></div>
      <label className="room-custom-toggle"><input type="checkbox" checked={customEnabled} onChange={(event) => setCustomEnabled(event.target.checked)}/>Allow custom ETB entries</label>
      <button className="primary-button" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save room settings'}<span>→</span></button>
    </section>

    <section className="room-admin-section"><div className="room-admin-section-head"><div><span className="staff-label">AUDIT</span><h3>Administrator actions</h3></div></div>
      {data.audit.length ? <div className="room-audit-list">{data.audit.slice(0, 12).map((event, index) => <article key={`${event.createdAt}-${index}`}><div><strong>{event.action.replaceAll('_', ' ')}</strong><small>{event.entityId || 'Marketplace settings'} · admin {event.adminId}</small></div><time>{new Date(event.createdAt).toLocaleString()}</time></article>)}</div> : <p className="room-admin-muted">No room setting or cancellation actions yet.</p>}
    </section>

    {detail && <div className="room-detail-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && (setDetail(null), setSelectedId(''))}><section className="room-detail-panel" role="dialog" aria-modal="true" aria-labelledby="room-detail-title"><header><div><span className="staff-label">ROOM DETAILS</span><h3 id="room-detail-title">#{detail.room.code}</h3></div><button className="staff-link-button" onClick={() => { setDetail(null); setSelectedId(''); }} aria-label="Close room details">Close</button></header><p>{gameTitle(detail.room.gameId)} · {detail.room.creatorName} · {detail.room.playerCount}/{detail.room.capacity} · {statusLabel(detail.room.status)}</p><div className="room-admin-settlement"><span>Entry per player <strong>{detail.room.walletKind === 'real' ? `${detail.room.entryCredits} ETB` : 'FREE'}</strong></span><span>Pool <strong>{detail.room.walletKind === 'real' ? `${formatCredits(detail.room.poolCredits)} ETB` : 'Not applicable'}</strong></span><span>Winner payout <strong>{detail.room.walletKind === 'real' ? `${formatCredits(detail.room.payoutCredits)} ETB` : 'Not applicable'}</strong></span></div><h4>Participants</h4><div className="room-detail-players">{detail.room.players.map((player) => <div key={player.seat}><span>{player.avatar}</span><strong>{player.name}</strong><small>Seat {player.seat + 1}</small></div>)}</div><h4>Room history</h4>{detail.events.length ? <ol className="room-event-list">{detail.events.map((event, index) => <li key={`${event.type}-${index}`}><strong>{event.type.replaceAll('_', ' ')}</strong><small>{new Date(event.createdAt).toLocaleString()}</small><code>{JSON.stringify(event.detail)}</code></li>)}</ol> : <p className="room-admin-muted">No events recorded.</p>}{!['COMPLETED','CANCELLED','EXPIRED','STARTING','SETTLING'].includes(detail.room.status) && <button className="room-danger-button" onClick={() => void cancel(detail.room)}>Cancel room and return held funds</button>}</section></div>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string | number }) { return <article><span>{label}</span><strong>{value}</strong></article>; }
function gameTitle(id: GameId): string { return id === 'poker' ? 'Texas Hold’em' : id === 'xo' ? 'XO' : id === 'ludo' ? 'Ludo' : 'Checkers'; }
function formatCredits(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value); }
function statusLabel(status: PublicRoomStatus): string { return status.replaceAll('_', ' '); }
