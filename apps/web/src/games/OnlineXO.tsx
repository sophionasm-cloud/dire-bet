import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { winningLine, type XOState } from '@dire-bet/engines/xo';
import { type LudoState } from '@dire-bet/engines/ludo';
import type { CheckersState } from '@dire-bet/engines/checkers';
import { viewPoker, type Card, type PokerAction, type Suit } from '@dire-bet/engines/poker';
import type { GameId } from '@dire-bet/shared';
import type { TranslationKey } from '../i18n';
import type { RoomConfig } from './marketplaceTypes';
import { TraditionalLudoBoard, type LudoBoardColor } from './TraditionalLudoBoard';
import { LudoDie, useLudoTurnClock } from './LudoDie';
import { CheckersRoom, type CheckersSnapshot } from './CheckersRoom';
import { MatchResultModal } from './MatchResultModal';

export type { RoomConfig } from './marketplaceTypes';

type Translator = (key: TranslationKey) => string;
type Props = { t: Translator; token: string | null };
type RoomPlayer = { id: number; name: string; mark: 'X' | 'O' | null; online: boolean };
type PokerPublic = ReturnType<typeof viewPoker>;
type RoomGame = XOState | LudoState | CheckersState | PokerPublic;
type RoomSnapshot = { type: 'state'; code: string; gameId: GameId; status: 'waiting'|'active'|'finished'|'cancelled'; players: RoomPlayer[]; game: RoomGame; you: 'X'|'O'|null; seat: number; matchId?: string | null; terminal?: { winner: number | 'draw'; reason: 'resign' | 'draw' | 'timeout' } | null; drawOfferBy?: number | null; turnDeadline?: number | null; serverTime?: number; publicRoom?: { id: string; entryCredits: number; payoutCredits?: number; options: Record<string, unknown> } };
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
  const walletRefresh = useRef('');
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

  useEffect(() => {
    if (!snapshot || (snapshot.status !== 'finished' && snapshot.status !== 'cancelled')) return;
    const key = `${snapshot.code}:${snapshot.status}`;
    if (walletRefresh.current === key) return;
    walletRefresh.current = key;
    window.dispatchEvent(new Event('direbet:wallet-changed'));
  }, [snapshot]);

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
  const result = snapshot ? resultCopy(snapshot.gameId, snapshot.game, snapshot.seat, snapshot.you, t, snapshot.terminal) : '';
  const statusText = snapshot?.status === 'waiting' ? t('waitingForPlayer') : snapshot?.status === 'active' ? (isMyTurn(snapshot) ? t('yourTurn') : t('opponent')) : '';
  const clockGame = snapshot?.gameId === 'ludo' ? snapshot.game as LudoState : null;
  const outcome = useMemo(() => {
    if (!snapshot) return null;
    if (snapshot.terminal) {
      if (snapshot.terminal.winner === 'draw') return { isWinner: false, isDraw: true };
      return { isWinner: snapshot.terminal.winner === snapshot.seat, isDraw: false };
    }
    if (snapshot.gameId === 'xo') {
      const winner = (snapshot.game as XOState).winner;
      if (winner === 'draw') return { isWinner: false, isDraw: true };
      if (winner) return { isWinner: winner === snapshot.you, isDraw: false };
      return null;
    }
    if (snapshot.gameId === 'ludo') {
      const winner = (snapshot.game as LudoState).winner;
      if (winner !== null && winner !== undefined) return { isWinner: winner === snapshot.seat, isDraw: false };
      return null;
    }
    if (snapshot.gameId === 'checkers') {
      const winner = (snapshot.game as CheckersState).winner;
      if (winner !== null && winner !== undefined) return { isWinner: winner === snapshot.seat, isDraw: false };
      return null;
    }
    const pokerWinner = (snapshot.game as PokerPublic).winner;
    if (pokerWinner === 'split') return { isWinner: false, isDraw: true };
    if (pokerWinner !== null && pokerWinner !== undefined) return { isWinner: pokerWinner === snapshot.seat, isDraw: false };
    return null;
  }, [snapshot]);

  const currentUserName = snapshot?.players[snapshot.seat]?.name || t('you');
  const entryCredits = snapshot?.publicRoom?.entryCredits || room.publicRoom?.entryCredits || 0;
  const payoutCredits = snapshot?.publicRoom?.payoutCredits || room.publicRoom?.payoutCredits || (entryCredits > 0 ? Math.round(entryCredits * 2 * 0.9) : 0);
  const isMatchFinished = snapshot?.status === 'finished' && outcome !== null;

  const turnSeconds = useLudoTurnClock(
    clockGame ? `${clockGame.turn}-${clockGame.lastEvent}-${clockGame.lastMove?.player ?? ''}-${clockGame.lastMove?.token ?? ''}` : 'inactive',
    snapshot?.turnDeadline ?? null,
    snapshot?.serverTime ?? null,
    snapshot?.status === 'active',
  );
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
    const playerZeroColor = roomLudoColor(roomMeta.options.player0Color);
    const colorAt = (seat: number): LudoBoardColor => seat === 0 ? playerZeroColor : oppositeLudoColor(playerZeroColor);
    const notice = snapshot.status === 'finished' ? result : state.lastEvent === 'capture' ? t('ludoCaptureNotice') : state.lastEvent === 'home' ? t('ludoHomeNotice') : state.turn === snapshot.seat ? (state.dice === null ? t('yourTurn') : `${state.lastDice ? `${state.lastDice} · ` : ''}${t('selectToken')}`) : t('marketWaitingTurn');
    const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
    const betText = roomMeta.entryCredits ? `${roomMeta.entryCredits} ${t('marketDemoCredits')}` : t('marketFree');
    return <section className="online-room-screen public-ludo-shell ludo-room-layout">
      <header className="ludo-room-topbar">
        <strong className="ludo-room-pill">♙ {t('marketRoomId')} #{room.code}</strong>
        <span className={`connection-pill ${connection}`}><i/>{connection === 'connected' ? t('onlineConnected') : connection === 'connecting' ? t('onlineConnecting') : t('onlineDisconnected')}</span>
        <div className="ludo-topbar-actions">
          <button className="ludo-fullscreen" type="button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
          <button className="ludo-leave" type="button" onClick={onExit}>↗ {t('exitGame')}</button>
        </div>
      </header>
      <div className="ludo-match-header">
        <LudoPlayerPanel player={snapshot.players[0]} seat={0} color={colorAt(0)} crownTarget={state.crownTarget ?? 4} active={state.turn === 0 && snapshot.status === 'active' && state.winner === null} own={snapshot.seat === 0} finished={state.tokens[0].filter((position) => position === 57).length} t={t}/>
        <div className="ludo-bet-card">
          <span className="ludo-bet-label">{roomMeta.entryCredits ? t('marketEntry') : 'Mode'}</span>
          <strong className="ludo-bet-amount">{betText}</strong>
          <span className="ludo-bet-timer">◷ {turnSeconds}s</span>
        </div>
        <LudoPlayerPanel player={snapshot.players[1]} seat={1} color={colorAt(1)} crownTarget={state.crownTarget ?? 4} active={state.turn === 1 && snapshot.status === 'active' && state.winner === null} own={snapshot.seat === 1} finished={state.tokens[1].filter((position) => position === 57).length} t={t}/>
      </div>
      <div className="ludo-board-stage">
        {snapshot.status === 'active' ? <OnlineLudo game={state} seat={snapshot.seat} playerZeroColor={playerZeroColor} notice={notice} t={t} send={send}/> : <div className="ludo-game-preparing" role="status">{t('marketPreparingGame')}</div>}
        {snapshot.status === 'cancelled' && <p className="online-error" role="alert">{t('onlineDisconnected')}</p>}
      </div>
      {error && <p className="online-error" role="status">{error}</p>}
      {connection === 'disconnected' && <button className="secondary-button wide ludo-reconnect" onClick={() => void reconnect()}>{t('reconnect')}<span>↻</span></button>}
      <MatchResultModal
        isOpen={Boolean(isMatchFinished && outcome)}
        isWinner={Boolean(outcome?.isWinner)}
        isDraw={Boolean(outcome?.isDraw)}
        playerName={currentUserName}
        entryCredits={entryCredits}
        payoutCredits={payoutCredits}
        onExit={onExit}
        t={t}
      />
    </section>;
  }
  return <section className="screen online-room-screen">
    <button className="back-button" onClick={onExit}>← {t('matches')}</button>
    <div className="practice-heading"><div><span className="eyebrow">{t('onlineMatches')} · {gameTitle(room.gameId)}</span><h1>{t('roomCodeLabel')}</h1></div><span className={`connection-pill ${connection}`}><i/>{connection === 'connected' ? t('onlineConnected') : connection === 'connecting' ? t('onlineConnecting') : t('onlineDisconnected')}</span></div>
    <div className="room-code-card"><strong>{room.code}</strong><div><button className="secondary-button" onClick={() => void copy()}>{t('copyCode')}</button><button className="primary-button" onClick={() => void share()}>{t('shareInvite')}</button></div></div>
    <p className="practice-note">{t('freeRoomNotice')}</p>
    {snapshot && <div className="room-seats">{snapshot.players.map((player, index) => <div className="room-seat" key={player.id}><i className={`player-dot ${player.mark === 'X' || (player.mark === null && index === 0) ? 'red-dot' : 'blue-dot'} ${player.online ? 'online' : ''}`}/><span><strong>{player.name}</strong><small>{player.mark ? `${player.mark === snapshot.you ? t('you') : t('opponent')} · ${player.mark}` : player.id === snapshot.players[snapshot.seat]?.id ? t('you') : t('opponent')}</small></span><b>{player.mark || (player.online ? '●' : '·')}</b></div>)}{snapshot.status === 'waiting' && snapshot.players.length < 2 && <div className="room-seat waiting-seat"><span className="seat-placeholder">＋</span><span><strong>{t('waitingForPlayer')}</strong><small>{t('shareInvite')}</small></span></div>}</div>}
    {snapshot?.status === 'active' && <>
      <div className="online-game-status" aria-live="polite">{statusText}{snapshot.gameId === 'ludo' && <span className="ludo-turn-clock">◷ {turnSeconds}s</span>}</div>
      {snapshot.gameId === 'xo' && <XOBoard game={snapshot.game as XOState} enabled={isMyTurn(snapshot)} winning={winning} onMove={(index) => send({ type: 'move', index })} />}
      {snapshot.gameId === 'ludo' && <OnlineLudo game={snapshot.game as LudoState} seat={snapshot.seat} playerZeroColor={roomLudoColor(snapshot.publicRoom?.options.player0Color)} t={t} send={send} />}
      {snapshot.gameId === 'poker' && <OnlinePoker game={snapshot.game as PokerPublic} seat={snapshot.seat} t={t} send={send} />}
    </>}
    
    {snapshot?.status === 'cancelled' && <p className="online-error">{t('onlineDisconnected')}</p>}
    {connection === 'disconnected' && <button className="secondary-button wide" onClick={() => void reconnect()}>{t('reconnect')}<span>↻</span></button>}
    {error && <p className="online-error" role="status">{error}</p>}
    {gameComplete && !result && <p className="online-error">{t('matchFinished')}</p>}
    <MatchResultModal
      isOpen={Boolean(isMatchFinished && outcome)}
      isWinner={Boolean(outcome?.isWinner)}
      isDraw={Boolean(outcome?.isDraw)}
      playerName={currentUserName}
      entryCredits={entryCredits}
      payoutCredits={payoutCredits}
      onExit={onExit}
      t={t}
    />
  </section>;
}

function XOBoard({ game, enabled, winning, onMove }: { game: XOState; enabled: boolean; winning: number[]; onMove: (index: number) => void }) {
  return <div className="xo-board online-xo-board" role="grid" aria-label="XO">{game.board.map((cell, index) => <button key={index} role="gridcell" className={`xo-cell ${cell ? `mark-${cell.toLowerCase()}` : ''} ${winning.includes(index) ? 'winning-cell' : ''}`} disabled={!enabled || Boolean(cell)} onClick={() => onMove(index)} aria-label={`XO ${index + 1}${cell ? ` ${cell}` : ''}`}>{cell === 'X' ? <span className="x-mark">×</span> : cell === 'O' ? <span className="o-mark">○</span> : ''}</button>)}</div>;
}

function OnlineLudo({ game, seat, playerZeroColor, notice, t, send }: { game: LudoState; seat: number; playerZeroColor: LudoBoardColor; notice?: string; t: Translator; send: (payload: unknown) => void }) {
  const colorFor = (player: number) => player === 0 ? playerZeroColor : oppositeLudoColor(playerZeroColor);
  const canRoll = game.turn === seat && game.dice === null && game.winner === null;
  const statusLabel = game.winner !== null
    ? (game.winner === seat ? t('gameWinTitle') : t('gameLossTitle'))
    : (notice || (game.dice !== null && game.turn === seat ? t('selectToken') : t('marketWaitingTurn')));
  return <>
    <TraditionalLudoBoard game={game} seat={seat} playerZeroColor={playerZeroColor} onMove={(token) => send({ type: 'move', token })}/>
    <LudoDie value={game.lastDice} rollVersion={game.rollVersion} color={colorFor(game.turn)} canRoll={canRoll} onRoll={() => send({ type: 'roll' })} rollLabel={t('rollDice')} statusLabel={statusLabel}/>
  </>;
}

function LudoPlayerPanel({ player, seat, color, crownTarget, active, own, finished, t }: { player?: RoomPlayer; seat: number; color: LudoBoardColor; crownTarget: number; active: boolean; own: boolean; finished: number; t: Translator }) {
  const name = player?.name || t('marketPlayer');
  return <article className={`ludo-player-panel ${color} ${active ? 'turn-active' : ''}`}>
    <div className="ludo-player-top">
      <span className={`ludo-player-avatar ${color}`}>{player?.name?.trim().slice(0, 1).toUpperCase() || (seat === 0 ? '1' : '2')}</span>
      <div className="ludo-player-copy">
        <strong>{name}{own ? ` · ${t('marketYou')}` : ''}</strong>
        <small><i className={`player-online-dot ${player?.online ? 'online' : ''}`}/>{player?.online ? t('onlineConnected') : t('marketConnecting')} · {finished}/{crownTarget}</small>
      </div>
    </div>
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

function resultCopy(id: GameId, state: RoomGame, seat: number, you: 'X'|'O'|null, t: Translator, terminal?: { winner: number | 'draw'; reason: string } | null): string {
  if (terminal) return terminal.winner === 'draw' ? t('gameSplitTitle') : terminal.winner === seat ? t('gameWinTitle') : t('gameLossTitle');
  if (id === 'xo') { const winner = (state as XOState).winner; return winner === 'draw' ? t('gameSplitTitle') : winner ? winner === you ? t('gameWinTitle') : t('gameLossTitle') : ''; }
  if (id === 'ludo') return (state as LudoState).winner === seat ? t('gameWinTitle') : t('gameLossTitle');
  if (id === 'checkers') return (state as CheckersState).winner === seat ? t('gameWinTitle') : t('gameLossTitle');
  const winner = (state as PokerPublic).winner; return winner === 'split' ? t('gameSplitTitle') : winner === seat ? t('gameWinTitle') : t('gameLossTitle');
}

function roomLudoColor(value: unknown): LudoBoardColor {
  if (value === 'white') return 'yellow';
  if (value === 'blue') return 'red';
  return value === 'red' || value === 'yellow' || value === 'green' ? value : 'red';
}
function oppositeLudoColor(color: LudoBoardColor): LudoBoardColor { return color === 'red' ? 'yellow' : color === 'yellow' ? 'red' : color === 'green' ? 'blue' : 'green'; }
function ludoColorName(color: LudoBoardColor, t: Translator): string {
  return color === 'red' ? t('marketRed') : color === 'yellow' ? t('marketYellow') : color === 'green' ? t('marketGreen') : t('marketBlue');
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
