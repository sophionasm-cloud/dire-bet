import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { winningLine, type XOState } from '@dire-bet/engines/xo';
import { type LudoState } from '@dire-bet/engines/ludo';
import type { CheckersState } from '@dire-bet/engines/checkers';
import { viewPoker, type Card, type PokerAction, type Suit } from '@dire-bet/engines/poker';
import type { GameId } from '@dire-bet/shared';
import type { TranslationKey } from '../i18n';
import type { RoomConfig } from './marketplaceTypes';
import { TraditionalLudoBoard } from './TraditionalLudoBoard';
import { LudoDie, useLudoTurnClock } from './LudoDie';
import { CheckersRoom, type CheckersSnapshot } from './CheckersRoom';

export type { RoomConfig } from './marketplaceTypes';

type Translator = (key: TranslationKey) => string;
type Props = { t: Translator; token: string | null };
type RoomPlayer = { id: number; name: string; mark: 'X' | 'O' | null; online: boolean };
type PokerPublic = ReturnType<typeof viewPoker>;
type RoomGame = XOState | LudoState | CheckersState | PokerPublic;
type RoomSnapshot = { type: 'state'; code: string; gameId: GameId; status: 'waiting'|'active'|'finished'|'cancelled'; players: RoomPlayer[]; game: RoomGame; you: 'X'|'O'|null; seat: number; matchId?: string | null; terminal?: { winner: number | 'draw'; reason: 'resign' | 'draw' } | null; drawOfferBy?: number | null; publicRoom?: { id: string; entryCredits: number; commissionBps: number; options: Record<string, unknown> } };
type ApiResult = { code?: string; ticket?: string; gameId?: GameId; error?: string };

export function OnlineMatches({ t, token, onRoom }: Props & { onRoom: (room: RoomConfig) => void }) {
  const [code, setCode] = useState('');
  const [gameId, setGameId] = useState<GameId>('xo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestRoom = async (url: string, body: unknown) => {
    if (!token) { setError(t('onlineRequiresTelegram')); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const result = await response.json() as ApiResult;
      if (!response.ok || !result.code || !result.ticket) throw new Error(result.error || t('onlineDisconnected'));
      onRoom({ code: result.code, ticket: result.ticket, gameId: result.gameId || gameId });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
    finally { setBusy(false); }
  };
  const create = () => requestRoom('/api/rooms', { gameId });
  const join = (event: FormEvent) => { event.preventDefault(); const value = code.trim().toUpperCase(); if (value) void requestRoom(`/api/rooms/${encodeURIComponent(value)}/join`, {}); };
  return <section className="screen online-matches">
    <span className="eyebrow">{t('onlineMatches')}</span><h1>{t('matchesTitle')}</h1><p>{t('matchesHelp')}</p>
    <label className="online-game-select"><span>{t('chooseGame')}</span><select value={gameId} onChange={(event) => setGameId(event.target.value as GameId)}><option value="xo">XO</option><option value="ludo">Ludo</option><option value="checkers">Checkers</option><option value="poker">Texas Hold’em</option></select></label>
    <div className="online-game-card"><div className="online-xo-mark">{gameSymbol(gameId)}</div><div><strong>{gameTitle(gameId)}</strong><small>{t('freeRoomNotice')}</small></div></div>
    <button className="primary-button wide" disabled={busy || !token} onClick={() => void create()}>{busy ? t('onlineConnecting') : t('createPrivateRoom')}<span>＋</span></button>
    {!token && <p className="online-hint">{t('onlineRequiresTelegram')}</p>}
    <div className="room-divider"><span>{t('joinByCode')}</span></div>
    <form className="join-room-form" onSubmit={join}><label><span>{t('enterRoomCode')}</span><input value={code} onChange={(event) => setCode(event.target.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase())} placeholder="ABC234" maxLength={6} autoCapitalize="characters" autoComplete="off" /></label><button className="secondary-button" type="submit" disabled={busy || !token || code.length !== 6}>{t('joinRoom')}<span>→</span></button></form>
    {error && <p className="online-error" role="alert">{error}</p>}
  </section>;
}

export function OnlineRoom({ room, token, t, onExit }: Props & { room: RoomConfig; onExit: () => void }) {
  const [ticket, setTicket] = useState(room.ticket);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connection, setConnection] = useState<'connecting'|'connected'|'disconnected'>('connecting');
  const [error, setError] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const winning = useMemo(() => snapshot?.gameId === 'xo' ? winningLine((snapshot.game as XOState).board) : [], [snapshot]);

  useEffect(() => {
    setConnection('connecting'); setError('');
    const socketUrl = new URL(`/ws/room/${room.code}`, location.href);
    socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socketUrl.searchParams.set('ticket', ticket);
    const socket = new WebSocket(socketUrl);
    socketRef.current = socket;
    socket.onopen = () => setConnection('connected');
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as RoomSnapshot | { type: 'error'; error: string };
        if (message.type === 'state') setSnapshot(message);
        if (message.type === 'error') setError(message.error);
      } catch { setError(t('onlineDisconnected')); }
    };
    socket.onerror = () => setConnection('disconnected');
    socket.onclose = () => setConnection('disconnected');
    return () => { if (socketRef.current === socket) socketRef.current = null; socket.close(1000, 'Leaving room'); };
  }, [room.code, ticket, t]);

  const send = useCallback((payload: unknown) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(payload)); }, []);
  const reconnect = async () => {
    if (!token) { setError(t('onlineRequiresTelegram')); return; }
    try {
      const response = await fetch('/api/ws-ticket', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ code: room.code }) });
      const result = await response.json() as ApiResult;
      if (!response.ok || !result.ticket) throw new Error(result.error || t('onlineDisconnected'));
      setTicket(result.ticket); setError(''); setConnection('connecting');
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('onlineDisconnected')); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(room.code); setError(''); } catch { setError(room.code); } };
  const share = async () => {
    const link = `https://t.me/Dire_Bet_bot?start=room_${room.code}`;
    try { if (navigator.share) await navigator.share({ title: `DIRE BET ${gameTitle(room.gameId)}`, text: t('freeRoomNotice'), url: link }); else { await navigator.clipboard.writeText(link); setError(''); } }
    catch { setError(link); }
  };
  const gameComplete = snapshot ? isFinished(snapshot.gameId, snapshot.game) : false;
  const result = snapshot ? resultCopy(snapshot.gameId, snapshot.game, snapshot.seat, snapshot.you, t) : '';
  const statusText = snapshot?.status === 'waiting' ? t('waitingForPlayer') : snapshot?.status === 'active' ? (isMyTurn(snapshot) ? t('yourTurn') : t('opponent')) : '';
  const clockGame = snapshot?.gameId === 'ludo' ? snapshot.game as LudoState : null;
  const turnSeconds = useLudoTurnClock(clockGame ? `${clockGame.turn}-${clockGame.lastEvent}-${clockGame.lastMove?.player ?? ''}-${clockGame.lastMove?.token ?? ''}` : 'inactive');
  if (room.gameId === 'checkers') {
    const checkersSnapshot: CheckersSnapshot | null = snapshot && snapshot.gameId === 'checkers' ? {
      code: snapshot.code,
      status: snapshot.status,
      players: snapshot.players,
      game: snapshot.game as CheckersState,
      seat: snapshot.seat,
      matchId: snapshot.matchId ?? null,
      terminal: snapshot.terminal ?? null,
      drawOfferBy: snapshot.drawOfferBy ?? null,
      publicRoom: snapshot.publicRoom,
    } : null;
    return <CheckersRoom snapshot={checkersSnapshot} room={room} connection={connection} error={error} t={t} send={send} onReconnect={() => void reconnect()} onExit={onExit} onCopy={() => void copy()} onShare={() => void share()} />;
  }
  if (snapshot?.gameId === 'ludo' && snapshot.publicRoom) {
    const state = snapshot.game as LudoState;
    const roomMeta = snapshot.publicRoom;
    const playerZeroColor = roomMeta.options.player0Color === 'white' ? 'white' : 'blue';
    const colorAt = (seat: number): 'red'|'yellow' => {
      const storedColor = seat === 0 ? playerZeroColor : playerZeroColor === 'blue' ? 'white' : 'blue';
      return storedColor === 'blue' ? 'red' : 'yellow';
    };
    const notice = state.lastEvent === 'capture' ? t('ludoCaptureNotice') : state.lastEvent === 'home' ? t('ludoHomeNotice') : state.winner !== null ? result : state.turn === snapshot.seat ? (state.dice === null ? t('yourTurn') : t('selectToken')) : t('marketWaitingTurn');
    const fee = Math.floor(roomMeta.entryCredits * 2 * roomMeta.commissionBps / 10_000);
    const payout = roomMeta.entryCredits * 2 - fee;
    const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
    return <section className="online-room-screen public-ludo-shell ludo-room-layout">
      <header className="ludo-room-topbar"><div className="ludo-brand"><span className="ludo-brand-crown">♛</span><strong>DIRE <b>BET</b></strong></div><span className="ludo-game-label"><i>⚄</i> Ludo</span><strong className="ludo-room-pill">♙ {t('marketRoomId')} #{room.code}</strong><span className={`connection-pill ${connection}`}><i/>{connection === 'connected' ? t('onlineConnected') : connection === 'connecting' ? t('onlineConnecting') : t('onlineDisconnected')}</span><button className="ludo-fullscreen" type="button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button><button className="ludo-leave" type="button" onClick={onExit}>↗ {t('exitGame')}</button></header>
      <div className="ludo-notification" role="status" aria-live="polite"><span>✦</span><strong>{notice}</strong></div>
      <div className="ludo-match-meta"><span>{roomMeta.entryCredits ? `${roomMeta.entryCredits} ${t('marketDemoCredits')} · ${t('marketPerPlayer').toLowerCase()}` : t('marketFree')}</span><small>{t('marketSimulationNote')}</small></div>
      <div className="ludo-two-player-layout">
        {[0, 1].map((seat) => <LudoPlayerPanel key={seat} player={snapshot.players[seat]} seat={seat} color={colorAt(seat)} active={state.turn === seat && snapshot.status === 'active' && state.winner === null} own={snapshot.seat === seat} finished={state.tokens[seat].filter((position) => position === 57).length} seconds={turnSeconds} t={t}/>) }
        <div className="ludo-board-stage">
          {snapshot.status === 'active' ? <OnlineLudo game={state} seat={snapshot.seat} playerZeroColor={playerZeroColor} t={t} send={send}/> : <div className="ludo-game-preparing" role="status">{t('marketPreparingGame')}</div>}
          {snapshot.status === 'finished' && <div className="ludo-result-banner"><strong>{result}</strong><span>{t('matchFinished')}</span></div>}
          {snapshot.status === 'cancelled' && <p className="online-error" role="alert">{t('onlineDisconnected')}</p>}
        </div>
      </div>
      {error && <p className="online-error" role="status">{error}</p>}
      {connection === 'disconnected' && <button className="secondary-button wide ludo-reconnect" onClick={() => void reconnect()}>{t('reconnect')}<span>↻</span></button>}
    </section>;
  }
  return <section className="screen online-room-screen">
    <button className="back-button" onClick={onExit}>← {t('matches')}</button>
    <div className="practice-heading"><div><span className="eyebrow">{t('onlineMatches')} · {gameTitle(room.gameId)}</span><h1>{t('roomCodeLabel')}</h1></div><span className={`connection-pill ${connection}`}><i/>{connection === 'connected' ? t('onlineConnected') : connection === 'connecting' ? t('onlineConnecting') : t('onlineDisconnected')}</span></div>
    <div className="room-code-card"><strong>{room.code}</strong><div><button className="secondary-button" onClick={() => void copy()}>{t('copyCode')}</button><button className="primary-button" onClick={() => void share()}>{t('shareInvite')}</button></div></div>
    <p className="practice-note">{t('freeRoomNotice')}</p>
    {snapshot && <div className="room-seats">{snapshot.players.map((player, index) => <div className="room-seat" key={player.id}><i className={`player-dot ${player.mark === 'X' || (player.mark === null && index === 0) ? 'red-dot' : 'blue-dot'} ${player.online ? 'online' : ''}`}/><span><strong>{player.name}</strong><small>{player.mark ? `${player.mark === snapshot.you ? t('you') : t('opponent')} · ${player.mark}` : player.id === snapshot.players[snapshot.seat]?.id ? t('you') : t('opponent')}</small></span><b>{player.mark || (player.online ? '●' : '·')}</b></div>)}{snapshot.status === 'waiting' && snapshot.players.length < 2 && <div className="room-seat waiting-seat"><span className="seat-placeholder">＋</span><span><strong>{t('waitingForPlayer')}</strong><small>{t('shareInvite')}</small></span></div>}</div>}
    {snapshot?.status === 'active' && <>
      <div className="online-game-status" aria-live="polite">{statusText}</div>
      {snapshot.gameId === 'xo' && <XOBoard game={snapshot.game as XOState} enabled={isMyTurn(snapshot)} winning={winning} onMove={(index) => send({ type: 'move', index })} />}
      {snapshot.gameId === 'ludo' && <OnlineLudo game={snapshot.game as LudoState} seat={snapshot.seat} playerZeroColor={snapshot.publicRoom?.options.player0Color === 'white' ? 'white' : 'blue'} t={t} send={send} />}
      {snapshot.gameId === 'poker' && <OnlinePoker game={snapshot.game as PokerPublic} seat={snapshot.seat} t={t} send={send} />}
    </>}
    {snapshot?.status === 'finished' && <div className="practice-result"><strong>{result}</strong><span>{t('matchFinished')}</span></div>}
    {snapshot?.status === 'cancelled' && <p className="online-error">{t('onlineDisconnected')}</p>}
    {connection === 'disconnected' && <button className="secondary-button wide" onClick={() => void reconnect()}>{t('reconnect')}<span>↻</span></button>}
    {error && <p className="online-error" role="status">{error}</p>}
    {gameComplete && !result && <p className="online-error">{t('matchFinished')}</p>}
  </section>;
}

function XOBoard({ game, enabled, winning, onMove }: { game: XOState; enabled: boolean; winning: number[]; onMove: (index: number) => void }) {
  return <div className="xo-board online-xo-board" role="grid" aria-label="XO">{game.board.map((cell, index) => <button key={index} role="gridcell" className={`xo-cell ${cell ? `mark-${cell.toLowerCase()}` : ''} ${winning.includes(index) ? 'winning-cell' : ''}`} disabled={!enabled || Boolean(cell)} onClick={() => onMove(index)} aria-label={`XO ${index + 1}${cell ? ` ${cell}` : ''}`}>{cell === 'X' ? <span className="x-mark">×</span> : cell === 'O' ? <span className="o-mark">○</span> : ''}</button>)}</div>;
}

function OnlineLudo({ game, seat, playerZeroColor, t, send }: { game: LudoState; seat: number; playerZeroColor: 'blue'|'white'; t: Translator; send: (payload: unknown) => void }) {
  const colorFor = (player: number) => {
    const storedColor = player === 0 ? playerZeroColor : playerZeroColor === 'blue' ? 'white' : 'blue';
    return storedColor === 'blue' ? 'red' : 'yellow';
  };
  const canRoll = game.turn === seat && game.dice === null && game.winner === null;
  return <>
    <TraditionalLudoBoard game={game} seat={seat} playerZeroColor={playerZeroColor} onMove={(token) => send({ type: 'move', token })}/>
    <div className="ludo-controls-wrap"><LudoDie value={game.lastDice} rollVersion={game.rollVersion} color={colorFor(game.turn)} canRoll={canRoll} onRoll={() => send({ type: 'roll' })} rollLabel={t('rollDice')}/>
      {!canRoll && <div className="ludo-waiting-turn" role="status">{game.winner === null ? (game.dice !== null && game.turn === seat ? t('selectToken') : t('marketWaitingTurn')) : game.winner === seat ? t('gameWinTitle') : t('gameLossTitle')}</div>}
    </div>
  </>;
}

function LudoPlayerPanel({ player, seat, color, active, own, finished, seconds, t }: { player?: RoomPlayer; seat: number; color: 'red'|'yellow'; active: boolean; own: boolean; finished: number; seconds: number; t: Translator }) {
  const name = player?.name || t('marketPlayer');
  return <article className={`ludo-player-panel ${color} ${active ? 'turn-active' : ''}`}>
    <span className={`ludo-player-avatar ${color}`}>{player?.name?.trim().slice(0, 1).toUpperCase() || (seat === 0 ? '1' : '2')}</span>
    <div className="ludo-player-copy"><strong>{name}{own ? ` · ${t('marketYou')}` : ''}</strong><small><i className={`player-online-dot ${player?.online ? 'online' : ''}`}/>{player?.online ? t('onlineConnected') : t('marketConnecting')} · {color === 'red' ? t('marketRed') : t('marketYellow')}</small>{active && <span className="ludo-turn-clock">◷ {seconds}s</span>}</div>
    <span className={`ludo-player-score ${color}`}>{finished}/4</span>
    <span className={`ludo-turn-label ${active ? 'visible' : ''}`}>{active ? t('yourTurn') : t('marketWaiting')}</span>
  </article>;
}

function OnlinePoker({ game, seat, t, send }: { game: PokerPublic; seat: number; t: Translator; send: (payload: unknown) => void }) {
  const player = game.players[seat]; const opponent = game.players[seat === 0 ? 1 : 0];
  const call = Math.max(0, game.currentBet - game.bets[seat]);
  const canRaise = player.stack + game.bets[seat] >= game.currentBet + game.minRaise;
  const actions: PokerAction[] = game.turn !== seat || game.street === 'showdown' || game.street === 'folded' ? [] : [{ type: 'fold' }, ...(call ? [{ type: 'call' } as const] : [{ type: 'check' } as const]), ...(canRaise ? [{ type: 'raise', to: game.currentBet + game.minRaise } as const] : []), ...(player.stack + game.bets[seat] > game.currentBet ? [{ type: 'all-in' } as const] : [])];
  return <>
    <div className="poker-table">
      <div className="poker-opponent"><span className="bot-avatar">✦</span><div><strong>{t('opponent')}</strong><small>{opponent.stack} {t('pokerChips')}</small></div><div className="poker-cards">{opponent.hole ? opponent.hole.map((card, index) => <PlayingCard card={card} key={index}/>) : <><PlayingCard card={null}/><PlayingCard card={null}/></>}</div></div>
      <div className="poker-pot"><span>{t('pokerPot')}</span><strong>{game.pot || game.resultPot}</strong><small>{t('pokerChips')}</small></div>
      <div className="poker-community"><span>{t('pokerBoard')}</span><div>{game.board.map((card, index) => <PlayingCard card={card} key={index}/>)}{Array.from({ length: 5 - game.board.length }, (_, index) => <span className="playing-card card-empty" key={`empty-${index}`}/>)}</div></div>
      <div className="poker-opponent poker-you"><span className="player-avatar">Y</span><div><strong>{t('you')}</strong><small>{player.stack} {t('pokerChips')}</small></div><div className="poker-cards">{(player.hole || []).map((card, index) => <PlayingCard card={card} key={index}/>)}</div></div>
    </div>
    <p className="practice-note">{t('freeTableNote')}</p>
    <div className="poker-actions">{actions.map((action) => <button key={action.type} className={action.type === 'call' || action.type === 'check' ? 'primary-button' : 'secondary-button'} onClick={() => send({ type: 'action', action })}>{pokerActionLabel(action, t)}</button>)}</div>
  </>;
}

function isMyTurn(snapshot: RoomSnapshot): boolean {
  if (snapshot.status !== 'active') return false;
  if (snapshot.gameId === 'xo') return snapshot.you !== null && (snapshot.game as XOState).turn === snapshot.you && (snapshot.game as XOState).winner === null;
  if (snapshot.gameId === 'ludo') return (snapshot.game as LudoState).turn === snapshot.seat && (snapshot.game as LudoState).winner === null;
  if (snapshot.gameId === 'checkers') return (snapshot.game as CheckersState).turn === snapshot.seat && (snapshot.game as CheckersState).winner === null;
  return (snapshot.game as PokerPublic).turn === snapshot.seat;
}

function isFinished(id: GameId, state: RoomGame): boolean {
  if (id === 'xo') return (state as XOState).winner !== null;
  if (id === 'ludo') return (state as LudoState).winner !== null;
  if (id === 'checkers') return (state as CheckersState).winner !== null;
  const poker = state as PokerPublic; return poker.street === 'showdown' || poker.street === 'folded';
}

function resultCopy(id: GameId, state: RoomGame, seat: number, you: 'X'|'O'|null, t: Translator): string {
  if (id === 'xo') { const winner = (state as XOState).winner; return winner === 'draw' ? t('gameSplitTitle') : winner ? winner === you ? t('gameWinTitle') : t('gameLossTitle') : ''; }
  if (id === 'ludo') return (state as LudoState).winner === seat ? t('gameWinTitle') : t('gameLossTitle');
  if (id === 'checkers') return (state as CheckersState).winner === seat ? t('gameWinTitle') : t('gameLossTitle');
  const winner = (state as PokerPublic).winner; return winner === 'split' ? t('gameSplitTitle') : winner === seat ? t('gameWinTitle') : t('gameLossTitle');
}

function gameTitle(id: GameId): string { return id === 'poker' ? 'Texas Hold’em' : id === 'xo' ? 'XO' : id === 'ludo' ? 'Ludo' : 'Checkers'; }
function gameSymbol(id: GameId): string { return id === 'xo' ? '× ○' : id === 'ludo' ? '⚄' : id === 'checkers' ? '♛' : '♠'; }

function ringPoint(index: number): React.CSSProperties { const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 52; return { left: `${50 + Math.cos(angle) * 38}%`, top: `${50 + Math.sin(angle) * 38}%` }; }
function tokenPoint(position: number, token: number, player: 0 | 1): React.CSSProperties {
  if (position === -1) { const base = player === 0 ? { x: 28, y: 69 } : { x: 72, y: 31 }; return { left: `${base.x + (token % 2) * 6}%`, top: `${base.y + Math.floor(token / 2) * 6}%` }; }
  const progress = position < 52 ? position : 52; const angle = -Math.PI / 2 + (Math.PI * 2 * ((progress + player * 26) % 52)) / 52; const radius = position < 52 ? 38 : Math.max(4, 28 - (position - 52) * 5);
  return { left: `${50 + Math.cos(angle) * radius}%`, top: `${50 + Math.sin(angle) * radius}%` };
}

function PlayingCard({ card }: { card: Card | null }) {
  if (!card) return <span className="playing-card card-back" aria-hidden="true">✦</span>;
  const symbols: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
  const rank = card.rank === 14 ? 'A' : card.rank === 13 ? 'K' : card.rank === 12 ? 'Q' : card.rank === 11 ? 'J' : String(card.rank);
  return <span className={`playing-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red-suit' : ''}`}><b>{rank}</b><i>{symbols[card.suit]}</i></span>;
}
function pokerActionLabel(action: PokerAction, t: Translator): string {
  if (action.type === 'fold') return t('pokerFold'); if (action.type === 'check') return t('pokerCheck'); if (action.type === 'call') return t('pokerCall'); if (action.type === 'all-in') return t('pokerAllIn'); return `${t('pokerRaiseTo')} ${action.to}`;
}
