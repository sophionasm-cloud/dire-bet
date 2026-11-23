import { useEffect, useMemo, useRef, useState } from 'react';
import { applyCheckerMove, botCheckerMove, legalCheckerMoves, newCheckersGame, type CheckerPlayer, type CheckersState } from '@dire-bet/engines/checkers';
import type { TranslationKey } from '../i18n';
import { MatchResultModal } from './MatchResultModal';
import type { RoomConfig } from './marketplaceTypes';

export type CheckersTranslator = (key: TranslationKey) => string;
export type CheckersTerminal = { winner: number | 'draw'; reason: 'resign' | 'draw' | 'timeout' } | null;
export type CheckersPlayerInfo = { name: string; online: boolean; bot?: boolean };
export type CheckersSnapshot = {
  code: string;
  status: 'waiting' | 'active' | 'finished' | 'cancelled';
  players: { id: number; name: string; online: boolean }[];
  game: CheckersState;
  seat: number;
  matchId: string | null;
  terminal: CheckersTerminal;
  drawOfferBy: number | null;
  publicRoom?: { id: string; entryCredits: number; options: Record<string, unknown> };
};

type SoundKind = 'move' | 'capture' | 'king' | 'win' | 'lose' | 'draw';
let audioContext: AudioContext | null = null;

export function playCheckersSound(kind: SoundKind, enabled: boolean): void {
  if (!enabled) return;
  try {
    const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    audioContext ??= new AudioCtor();
    const context = audioContext;
    if (context.state === 'suspended') void context.resume();
    const notes = kind === 'capture' ? [196, 146] : kind === 'king' ? [440, 660, 880] : kind === 'win' ? [523, 659, 784, 1046] : kind === 'lose' ? [330, 247, 196] : kind === 'draw' ? [392, 392] : [320];
    const start = context.currentTime;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = kind === 'capture' ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.085;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.055, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.17);
    });
  } catch {
    // Audio is optional and may be blocked until the first user gesture.
  }
}

export function useCheckersTurnClock(resetKey: string, active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const id = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [resetKey, active]);
  return seconds;
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function countPieces(board: CheckersState['board'], player: CheckerPlayer): { pieces: number; kings: number } {
  let pieces = 0;
  let kings = 0;
  for (const piece of board) {
    if (piece?.player !== player) continue;
    pieces++;
    if (piece.king) kings++;
  }
  return { pieces, kings };
}

export function CheckersBoard({ game, seat, enabled, onMove }: {
  game: CheckersState;
  seat: number;
  enabled: boolean;
  onMove: (from: number, to: number) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const canPlay = enabled && !pending && game.winner === null && game.turn === seat;
  const moves = useMemo(() => canPlay ? legalCheckerMoves(game) : [], [game, canPlay]);
  const selectedMoves = selected === null ? [] : moves.filter((move) => move.from === selected);
  const destinations = new Set(selectedMoves.map((move) => move.to));
  const selectable = new Set(moves.map((move) => move.from));

  useEffect(() => {
    setSelected(game.chain !== null && game.turn === seat && canPlay ? game.chain : null);
  }, [game.turn, game.moveCount, game.chain, seat, canPlay]);

  useEffect(() => {
    setPending(false);
  }, [game.moveCount, game.turn]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPending(false), 2500);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const choose = (index: number) => {
    if (!canPlay) return;
    if (selected !== null && selectedMoves.some((move) => move.to === index)) {
      setPending(true);
      setSelected(null);
      onMove(selected, index);
      return;
    }
    const piece = game.board[index];
    if (piece && piece.player === game.turn && selectable.has(index)) {
      setSelected(index);
      return;
    }
    setSelected(null);
  };

  return <div className="checkers-board-frame">
    <div className="checkers-board-grain" aria-hidden="true" />
    <div className="checkers-board" role="grid" aria-label="Checkers board">
      {game.board.map((piece, index) => {
        const row = Math.floor(index / 8);
        const column = index % 8;
        const dark = (row + column) % 2 === 1;
        const isSelected = selected === index;
        const isDestination = destinations.has(index);
        const lastFrom = game.lastMove?.from === index;
        const lastTo = game.lastMove?.to === index;
        const captured = game.lastMove?.captured === index;
        const label = `Row ${row + 1}, column ${column + 1}${piece ? `, ${piece.player === seat ? 'your' : 'opponent'} ${piece.king ? 'king' : 'piece'}` : ''}${isDestination ? ', legal move' : ''}`;
        return <button
          key={index}
          type="button"
          role="gridcell"
          className={`checkers-square ${dark ? 'dark' : 'light'}${isSelected ? ' selected' : ''}${isDestination ? ' destination' : ''}${lastFrom ? ' last-from' : ''}${lastTo ? ' last-to' : ''}${captured ? ' captured' : ''}`}
          disabled={!dark || !canPlay}
          onClick={() => choose(index)}
          aria-label={label}
        >
          {piece && <span className={`checkers-piece player-${piece.player}${piece.king ? ' king' : ''}`} aria-hidden="true"><i /><b>{piece.king ? '♛' : ''}</b></span>}
          {isDestination && <span className="checkers-destination" aria-hidden="true" />}
          {captured && <span className="checkers-captured-mark" aria-hidden="true">×</span>}
        </button>;
      })}
    </div>
    <span className="checkers-corner top-left" aria-hidden="true" />
    <span className="checkers-corner top-right" aria-hidden="true" />
    <span className="checkers-corner bottom-left" aria-hidden="true" />
    <span className="checkers-corner bottom-right" aria-hidden="true" />
  </div>;
}

export function CheckersPlayerPanel({ player, seat, color, own, active, pieces, kings, seconds, t, waiting = false }: {
  player?: CheckersPlayerInfo;
  seat: number;
  color: 'ivory' | 'graphite';
  own: boolean;
  active: boolean;
  pieces: number;
  kings: number;
  seconds: number;
  t: CheckersTranslator;
  waiting?: boolean;
}) {
  const name = player?.name || (waiting ? t('waitingForPlayer') : seat === 0 ? t('you') : t('opponent'));
  const status = player?.bot ? t('bot') : player?.online ? t('onlineConnected') : waiting ? t('waitingForPlayer') : t('onlineConnecting');
  return <article className={`checkers-player-panel ${color}${active ? ' turn-active' : ''}${own ? ' is-you' : ''}`}>
    <span className={`checkers-avatar ${color}`}>{player?.bot ? '✦' : (player?.name?.trim().slice(0, 1).toUpperCase() || (seat === 0 ? '1' : '2'))}</span>
    <div className="checkers-player-copy">
      <strong>{name}{own && name !== t('you') ? ` · ${t('you')}` : ''}</strong>
      <small><i className={`checkers-online-dot${player?.online ? ' online' : ''}`} />{status} · {color === 'ivory' ? t('checkersIvory') : t('checkersGraphite')}</small>
      {active && <span className="checkers-turn-clock">◷ {formatClock(seconds)}</span>}
    </div>
    <div className="checkers-piece-count">
      <strong>{pieces}</strong>
      <small>{t('checkersPieces')}</small>
      {kings > 0 && <em>{kings} {t('checkersKings')}</em>}
    </div>
    <span className={`checkers-turn-label${active ? ' visible' : ''}`}>{active ? (own ? t('yourTurn') : player?.bot ? t('botTurn') : t('checkersOpponentTurn')) : t('marketWaiting')}</span>
  </article>;
}

export function CheckersActionBar({ t, sound, onSound, drawOfferBy, seat, active, onOfferDraw, onAcceptDraw, onDeclineDraw, onResign }: {
  t: CheckersTranslator;
  sound: boolean;
  onSound: () => void;
  drawOfferBy: number | null;
  seat: number;
  active: boolean;
  onOfferDraw: () => void;
  onAcceptDraw: () => void;
  onDeclineDraw: () => void;
  onResign: () => void;
}) {
  const incoming = drawOfferBy !== null && drawOfferBy !== seat;
  const outgoing = drawOfferBy === seat;
  return <div className="checkers-action-bar">
    {incoming && <div className="checkers-draw-offer" role="status"><span>{t('checkersDrawOffer')}</span><button type="button" className="checkers-accept" onClick={onAcceptDraw}>{t('checkersAcceptDraw')}</button><button type="button" className="checkers-decline" onClick={onDeclineDraw}>{t('checkersDeclineDraw')}</button></div>}
    {outgoing && <div className="checkers-draw-note" role="status">{t('checkersDrawSent')}</div>}
    <div className="checkers-action-buttons">
      <button type="button" className="checkers-tool" aria-pressed={sound} onClick={onSound}><span aria-hidden="true">{sound ? '♪' : '♪̸'}</span>{sound ? t('checkersSoundOn') : t('checkersSoundOff')}</button>
      <CheckersHelp t={t} />
      <button type="button" className="checkers-tool" disabled={!active || incoming || outgoing} onClick={onOfferDraw}>{t('checkersOfferDraw')}</button>
      <button type="button" className="checkers-tool danger" disabled={!active} onClick={onResign}>{t('checkersResign')}</button>
    </div>
  </div>;
}

export function CheckersHelp({ t }: { t: CheckersTranslator }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="checkers-tool" onClick={() => setOpen(true)}>{t('howToPlay')}</button>
    {open && <div className="checkers-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <section className="checkers-modal" role="dialog" aria-modal="true" aria-labelledby="checkers-rules-title">
        <header><h2 id="checkers-rules-title">{t('howToPlay')}</h2><button type="button" className="checkers-modal-close" onClick={() => setOpen(false)} aria-label={t('close')}>×</button></header>
        <p>{t('checkersRulesText')}</p>
        <p>{t('checkersMandatoryCapture')}</p>
        <button type="button" className="primary-button wide" onClick={() => setOpen(false)}>{t('close')}</button>
      </section>
    </div>}
  </>;
}

function resultText(snapshot: CheckersSnapshot, t: CheckersTranslator): string {
  if (snapshot.terminal) {
    if (snapshot.terminal.winner === 'draw') return t('checkersDrawAgreed');
    if (snapshot.terminal.reason === 'resign') return snapshot.terminal.winner === snapshot.seat ? t('checkersOpponentResigned') : t('checkersYouResigned');
    return snapshot.terminal.winner === snapshot.seat ? t('gameWinTitle') : t('gameLossTitle');
  }
  if (snapshot.game.winner !== null) return snapshot.game.winner === snapshot.seat ? t('gameWinTitle') : t('gameLossTitle');
  return '';
}

function stakeText(snapshot: CheckersSnapshot | null, t: CheckersTranslator): string {
  if (!snapshot?.publicRoom) return t('marketFree');
  return snapshot.publicRoom.entryCredits > 0 ? `${snapshot.publicRoom.entryCredits} ${t('marketDemoCredits')}` : t('marketFree');
}

export function CheckersRoom({ snapshot, room, connection, error, t, send, onReconnect, onExit, onCopy, onShare }: {
  snapshot: CheckersSnapshot | null;
  room: RoomConfig;
  connection: 'connecting' | 'connected' | 'disconnected';
  error: string;
  t: CheckersTranslator;
  send: (payload: unknown) => void;
  onReconnect: () => void;
  onExit: () => void;
  onCopy: () => void;
  onShare: () => void;
}) {
  const [sound, setSound] = useState(() => localStorage.getItem('direbet.checkers.sound') !== 'false');
  const game = snapshot?.game ?? newCheckersGame(1);
  const seat = snapshot?.seat ?? 0;
  const status = snapshot?.status ?? 'waiting';
  const terminal = snapshot?.terminal ?? null;
  const drawOfferBy = snapshot?.drawOfferBy ?? null;
  const active = status === 'active' && game.winner === null && terminal === null;
  const turnSeconds = useCheckersTurnClock(`${game.turn}-${game.moveCount}`, active);
  const ivory = countPieces(game.board, 0);
  const graphite = countPieces(game.board, 1);
  const result = snapshot ? resultText(snapshot, t) : '';
  const soundKey = useRef<string | null>(null);
  const lastMove = game.lastMove;
  const notice = snapshot === null
    ? t('onlineConnecting')
    : status === 'cancelled'
      ? t('onlineDisconnected')
      : status === 'waiting'
        ? t('waitingForPlayer')
        : terminal || game.winner !== null
          ? result
          : game.chain !== null
            ? t('checkersContinueJump')
            : game.turn === seat
              ? t('yourTurn')
              : t('checkersOpponentTurn');
  const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    localStorage.setItem('direbet.checkers.sound', String(next));
    if (next) playCheckersSound('move', true);
  };
  const topPlayer: CheckersPlayerInfo | undefined = snapshot?.players[1] ? { name: snapshot.players[1].name, online: snapshot.players[1].online } : undefined;
  const bottomPlayer: CheckersPlayerInfo | undefined = snapshot?.players[0] ? { name: snapshot.players[0].name, online: snapshot.players[0].online } : undefined;

  useEffect(() => {
    if (!snapshot) return;
    const terminalKey = snapshot.terminal ? `${snapshot.terminal.winner}-${snapshot.terminal.reason}` : '';
    const key = `${snapshot.game.moveCount}:${snapshot.game.lastMove?.from ?? ''}:${snapshot.game.lastMove?.to ?? ''}:${terminalKey}:${snapshot.status}`;
    if (soundKey.current === null) { soundKey.current = key; return; }
    if (soundKey.current === key) return;
    soundKey.current = key;
    if (snapshot.terminal) {
      playCheckersSound(snapshot.terminal.winner === 'draw' ? 'draw' : snapshot.terminal.winner === snapshot.seat ? 'win' : 'lose', sound);
      return;
    }
    if (snapshot.status === 'finished' && snapshot.game.winner !== null) {
      playCheckersSound(snapshot.game.winner === snapshot.seat ? 'win' : 'lose', sound);
      return;
    }
    if (lastMove) playCheckersSound(lastMove.promoted ? 'king' : lastMove.captured !== null ? 'capture' : 'move', sound);
  }, [snapshot, sound, lastMove]);

  return <section className="checkers-room-layout">
    <header className="checkers-topbar">
      <div className="checkers-brand"><span>♛</span><strong>DIRE <b>BET</b></strong></div>
      <span className="checkers-game-label"><i>●</i> Checkers</span>
      <strong className="checkers-room-pill">{t('marketRoomId')} #{snapshot?.code || room.code}</strong>
      <span className={`connection-pill ${connection}`}><i />{connection === 'connected' ? t('onlineConnected') : connection === 'connecting' ? t('onlineConnecting') : t('onlineDisconnected')}</span>
      <button type="button" className="checkers-top-button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
      <button type="button" className="checkers-top-button leave" onClick={onExit}>↗ {t('exitGame')}</button>
    </header>
    <div className="checkers-notification" role="status" aria-live="polite"><span>✦</span><strong>{notice}</strong></div>
    <div className="checkers-meta">
      <span>{t('checkersStake')} <strong>{stakeText(snapshot, t)}</strong></span>
      <span>{t('checkersMatchId')} <strong>#{snapshot?.matchId || room.code}</strong></span>
      <span>{t('checkersTurnClock')} <strong>{formatClock(turnSeconds)}</strong></span>
      <small>{snapshot?.publicRoom ? t('marketSimulationNote') : t('freeRoomNotice')}</small>
    </div>
    <div className="checkers-arena">
      <CheckersPlayerPanel player={topPlayer} seat={1} color="graphite" own={seat === 1} active={active && game.turn === 1} pieces={graphite.pieces} kings={graphite.kings} seconds={turnSeconds} t={t} waiting={!topPlayer} />
      <div className="checkers-board-stage">
        <CheckersBoard game={game} seat={seat} enabled={active} onMove={(from, to) => send({ type: 'move', from, to })} />
        {snapshot === null && <div className="checkers-waiting-card" role="status"><span>{t('onlineConnecting')}</span><strong>#{room.code}</strong></div>}
        {snapshot?.status === 'waiting' && <div className="checkers-waiting-card" role="status"><span>{t('waitingForPlayer')}</span><strong>#{snapshot.code}</strong><div><button type="button" onClick={onCopy}>{t('copyCode')}</button><button type="button" onClick={onShare}>{t('shareInvite')}</button></div><small>{t('freeRoomNotice')}</small></div>}
        <MatchResultModal
          isOpen={status === 'finished' && Boolean(terminal || game.winner !== null)}
          isWinner={Boolean((terminal && terminal.winner === seat) || (!terminal && game.winner === seat))}
          isDraw={Boolean(terminal?.winner === 'draw')}
          playerName={snapshot?.players[seat]?.name || t('you')}
          entryCredits={snapshot?.publicRoom?.entryCredits || 0}
          payoutCredits={snapshot?.publicRoom?.payoutCredits || ((snapshot?.publicRoom?.entryCredits || 0) > 0 ? Math.round((snapshot?.publicRoom?.entryCredits || 0) * 2 * 0.9) : 0)}
          onExit={onExit}
          t={t}
        />
      </div>
      <CheckersPlayerPanel player={bottomPlayer} seat={0} color="ivory" own={seat === 0} active={active && game.turn === 0} pieces={ivory.pieces} kings={ivory.kings} seconds={turnSeconds} t={t} />
      <CheckersActionBar t={t} sound={sound} onSound={toggleSound} drawOfferBy={drawOfferBy} seat={seat} active={active} onOfferDraw={() => send({ type: 'draw-offer' })} onAcceptDraw={() => send({ type: 'draw-accept' })} onDeclineDraw={() => send({ type: 'draw-decline' })} onResign={() => { if (window.confirm(t('checkersResignConfirm'))) send({ type: 'resign' }); }} />
    </div>
    {error && <p className="online-error" role="status">{error}</p>}
    {connection === 'disconnected' && <button type="button" className="secondary-button wide checkers-reconnect" onClick={onReconnect}>{t('reconnect')}<span>↻</span></button>}
  </section>;
}

export function CheckersPractice({ t, onExit, reduceEffects = false }: { t: CheckersTranslator; onExit: () => void; reduceEffects?: boolean }) {
  const [game, setGame] = useState(() => newCheckersGame(1));
  const [terminal, setTerminal] = useState<CheckersTerminal>(null);
  const [sound, setSound] = useState(() => localStorage.getItem('direbet.checkers.sound') !== 'false');
  const active = terminal === null && game.winner === null;
  const turnSeconds = useCheckersTurnClock(`${game.turn}-${game.moveCount}`, active);
  const ivory = countPieces(game.board, 0);
  const graphite = countPieces(game.board, 1);
  const soundKey = useRef<string | null>(null);
  const lastMove = game.lastMove;

  useEffect(() => {
    if (!active || game.turn !== 1) return;
    const timer = window.setTimeout(() => {
      setGame((current) => {
        if (current.winner !== null || current.turn !== 1) return current;
        const move = botCheckerMove(current);
        return move ? applyCheckerMove(current, move.from, move.to) : current;
      });
    }, reduceEffects ? 180 : 700);
    return () => window.clearTimeout(timer);
  }, [game, active, reduceEffects]);

  useEffect(() => {
    const key = `${game.moveCount}:${game.lastMove?.from ?? ''}:${game.lastMove?.to ?? ''}:${terminal ? `${terminal.winner}-${terminal.reason}` : ''}`;
    if (soundKey.current === null) { soundKey.current = key; return; }
    if (soundKey.current === key) return;
    soundKey.current = key;
    if (terminal) {
      playCheckersSound(terminal.winner === 'draw' ? 'draw' : terminal.winner === 1 ? 'lose' : 'win', sound);
      return;
    }
    if (game.winner !== null) {
      playCheckersSound(game.winner === 0 ? 'win' : 'lose', sound);
      return;
    }
    if (lastMove) playCheckersSound(lastMove.promoted ? 'king' : lastMove.captured !== null ? 'capture' : 'move', sound);
  }, [game, terminal, sound, lastMove]);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    localStorage.setItem('direbet.checkers.sound', String(next));
    if (next) playCheckersSound('move', true);
  };
  const result = terminal
    ? terminal.winner === 'draw' ? t('checkersDrawAgreed') : terminal.winner === 1 ? t('checkersYouResigned') : t('gameWinTitle')
    : game.winner === 0 ? t('gameWinTitle') : game.winner === 1 ? t('gameLossTitle') : '';
  const notice = result || (game.chain !== null ? t('checkersContinueJump') : game.turn === 0 ? t('yourTurn') : t('botTurn'));
  const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
  const restart = () => { setGame(newCheckersGame(1)); setTerminal(null); soundKey.current = null; };

  return <section className="checkers-room-layout practice-checkers-shell">
    <header className="checkers-topbar">
      <div className="checkers-brand"><span>♛</span><strong>DIRE <b>BET</b></strong></div>
      <span className="checkers-game-label"><i>●</i> Checkers</span>
      <strong className="checkers-room-pill">{t('freePractice')} · {t('bot')}</strong>
      <span className="connection-pill connected"><i />{t('bot')}</span>
      <button type="button" className="checkers-top-button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
      <button type="button" className="checkers-top-button leave" onClick={onExit}>← {t('home')}</button>
    </header>
    <div className="checkers-notification" role="status" aria-live="polite"><span>✦</span><strong>{notice}</strong></div>
    <div className="checkers-meta">
      <span>{t('checkersStake')} <strong>{t('freePractice')}</strong></span>
      <span>{t('checkersMatchId')} <strong>{t('bot')}</strong></span>
      <span>{t('checkersTurnClock')} <strong>{formatClock(turnSeconds)}</strong></span>
      <small>{t('freeRoomNotice')}</small>
    </div>
    <div className="checkers-arena">
      <CheckersPlayerPanel player={{ name: t('bot'), online: true, bot: true }} seat={1} color="graphite" own={false} active={active && game.turn === 1} pieces={graphite.pieces} kings={graphite.kings} seconds={turnSeconds} t={t} />
      <div className="checkers-board-stage">
        <CheckersBoard game={game} seat={0} enabled={active && !terminal} onMove={(from, to) => setGame((current) => { try { return applyCheckerMove(current, from, to); } catch { return current; } })} />
        {(terminal || game.winner !== null) && result && <div className="checkers-result-banner"><strong>{result}</strong><span>{t('matchFinished')}</span><button type="button" className="primary-button" onClick={restart}>{t('practiceAgain')} ↻</button></div>}
      </div>
      <CheckersPlayerPanel player={{ name: t('you'), online: true }} seat={0} color="ivory" own active={active && game.turn === 0} pieces={ivory.pieces} kings={ivory.kings} seconds={turnSeconds} t={t} />
      <CheckersActionBar t={t} sound={sound} onSound={toggleSound} drawOfferBy={null} seat={0} active={active} onOfferDraw={() => setTerminal({ winner: 'draw', reason: 'draw' })} onAcceptDraw={() => undefined} onDeclineDraw={() => undefined} onResign={() => { if (window.confirm(t('checkersResignConfirm'))) setTerminal({ winner: 1, reason: 'resign' }); }} />
    </div>
  </section>;
}
