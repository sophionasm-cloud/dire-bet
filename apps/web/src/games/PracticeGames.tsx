import { useEffect, useState } from 'react';
import { botLudoToken, initLudo, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyPokerAction, botPokerAction, initTexasHoldem, legalPokerActions, type Card, type PokerAction, type PokerState, type Suit } from '@dire-bet/engines/poker';
import type { TranslationKey } from '../i18n';
import { TraditionalLudoBoard } from './TraditionalLudoBoard';
import { LudoDie, useLudoTurnClock } from './LudoDie';

export { CheckersPractice } from './CheckersRoom';

type Translator = (key: TranslationKey) => string;
type PracticeProps = { t: Translator; onExit: () => void; reduceEffects: boolean };

export function LudoPractice({ t, onExit, reduceEffects }: PracticeProps) {
  const [state, setState] = useState<LudoState>(() => initLudo());
  useEffect(() => {
    if (state.turn !== 1 || state.winner !== null) return;
    const timer = window.setTimeout(() => setState((current) => {
      if (current.turn !== 1 || current.winner !== null) return current;
      if (current.dice === null) return rollLudo(current, Math.floor(Math.random() * 6) + 1);
      const token = botLudoToken(current);
      return token === null ? current : moveLudo(current, token);
    }), reduceEffects ? 180 : state.dice === null && state.lastEvent !== 'extra-roll' ? 580 : 1050);
    return () => window.clearTimeout(timer);
  }, [state, reduceEffects]);

  const turnCopy = state.winner !== null ? outcome(state.winner, t) : state.turn === 0 ? (state.dice === null ? t('yourTurn') : t('selectToken')) : t('botTurn');
  const turnSeconds = useLudoTurnClock(`${state.turn}-${state.lastEvent}-${state.lastMove?.player ?? ''}-${state.lastMove?.token ?? ''}`);
  const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
  const banner = state.lastEvent === 'capture' ? t('ludoCaptureNotice') : state.lastEvent === 'home' ? t('ludoHomeNotice') : state.winner !== null ? outcome(state.winner, t) : turnCopy;
  return <section className="screen practice-screen practice-ludo-shell ludo-room-layout">
    <header className="ludo-room-topbar">
      <div className="ludo-brand"><span className="ludo-brand-crown">♛</span><strong>DIRE <b>BET</b></strong></div>
      <span className="ludo-game-label"><i>⚄</i> Ludo</span>
      <strong className="ludo-room-pill">{t('freePractice')} · {t('bot')}</strong>
      <span className="connection-pill connected"><i/>{t('bot')}</span>
      <button className="ludo-fullscreen" type="button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
      <button className="ludo-leave" type="button" onClick={onExit}>← {t('home')}</button>
    </header>
    <div className="ludo-notification" role="status" aria-live="polite"><span>✦</span><strong>{banner}</strong></div>
    <div className="ludo-match-meta practice-ludo-meta"><span>{t('ludoRuleText')}</span></div>
    <div className="ludo-two-player-layout">
      <PracticeLudoPlayerPanel name={t('you')} color="yellow" active={state.turn === 0 && state.winner === null} finished={state.tokens[0].filter((position) => position === 57).length} seconds={turnSeconds} t={t}/>
      <div className="ludo-board-stage"><TraditionalLudoBoard game={state} seat={0} playerZeroColor="white" onMove={(token) => setState((current) => moveLudo(current, token))}/></div>
      <PracticeLudoPlayerPanel name={t('bot')} color="red" active={state.turn === 1 && state.winner === null} finished={state.tokens[1].filter((position) => position === 57).length} seconds={turnSeconds} t={t} bot/>
    </div>
    <div className="ludo-controls-wrap practice-ludo-controls">
      <LudoDie value={state.lastDice} rollVersion={state.rollVersion} color={state.turn === 0 ? 'yellow' : 'red'} canRoll={state.turn === 0 && state.dice === null && state.winner === null} onRoll={() => setState((current) => rollLudo(current, Math.floor(Math.random() * 6) + 1))} rollLabel={t('rollDice')} reducedMotion={reduceEffects}/>
      {state.turn !== 0 || state.dice !== null || state.winner !== null ? <div className="ludo-waiting-turn" role="status">{state.winner === null ? turnCopy : <><strong>{turnCopy}</strong><button className="secondary-button" onClick={() => setState(initLudo())}>{t('practiceAgain')} ↻</button></>}</div> : null}
    </div>
  </section>;
}

function PracticeLudoPlayerPanel({ name, color, active, finished, seconds, t, bot = false }: { name: string; color: 'red'|'yellow'; active: boolean; finished: number; seconds: number; t: Translator; bot?: boolean }) {
  return <article className={`ludo-player-panel ${color} ${active ? 'turn-active' : ''}`}>
    <span className={`ludo-player-avatar ${color}`}>{bot ? '✦' : name.trim().slice(0, 1).toUpperCase()}</span>
    <div className="ludo-player-copy"><strong>{name}</strong><small><i className={`player-online-dot ${active ? 'online' : ''}`}/>{bot ? t('bot') : t('you')} · {color === 'red' ? t('marketRed') : t('marketYellow')}</small>{active && <span className="ludo-turn-clock">◷ {seconds}s</span>}</div>
    <span className={`ludo-player-score ${color}`} aria-label={`${finished} of 4 tokens finished`}>{finished}/4</span>
    <span className={`ludo-turn-label ${active ? 'visible' : ''}`}>{active ? (bot ? t('botTurn') : t('yourTurn')) : t('marketWaiting')}</span>
  </article>;
}

export function PokerPractice({ t, onExit, reduceEffects }: PracticeProps) {
  const [state, setState] = useState<PokerState>(() => initTexasHoldem());
  useEffect(() => {
    if (state.turn !== 1) return;
    const timer = window.setTimeout(() => setState((current) => {
      const action = botPokerAction(current);
      return action ? applyPokerAction(current, 1, action) : current;
    }), reduceEffects ? 180 : 640);
    return () => window.clearTimeout(timer);
  }, [state, reduceEffects]);

  const actions = legalPokerActions(state, 0);
  const showBotCards = state.street === 'showdown';
  const runAction = (action: PokerAction) => setState((current) => applyPokerAction(current, 0, action));
  return <section className="screen practice-screen poker-screen">
    <PracticeHeading title="Texas Hold’em" t={t} onExit={onExit} />
    <div className="poker-table">
      <div className="poker-opponent"><span className="bot-avatar">✦</span><div><strong>{t('bot')}</strong><small>{state.players[1].stack} {t('pokerChips')}</small></div><div className="poker-cards">{state.players[1].hole.map((card, index) => <PokerCard card={showBotCards ? card : null} key={index} />)}</div></div>
      <div className="poker-pot"><span>{t('pokerPot')}</span><strong>{state.pot || state.resultPot}</strong><small>{t('pokerChips')}</small></div>
      <div className="poker-community"><span>{t('pokerBoard')}</span><div>{state.board.map((card, index) => <PokerCard card={card} key={index} />)}{Array.from({ length: 5 - state.board.length }, (_, index) => <span className="playing-card card-empty" key={`empty-${index}`} />)}</div></div>
      <div className="poker-opponent poker-you"><span className="player-avatar">Y</span><div><strong>{t('you')}</strong><small>{state.players[0].stack} {t('pokerChips')}</small></div><div className="poker-cards">{state.players[0].hole.map((card, index) => <PokerCard card={card} key={index} />)}</div></div>
    </div>
    <p className="practice-note">{t('freeTableNote')}</p>
    {state.turn === 0 && state.winner === null && <div className="poker-actions">{actions.map((action) => {
      const label = action.type === 'fold' ? t('pokerFold') : action.type === 'check' ? t('pokerCheck') : action.type === 'call' ? t('pokerCall') : action.type === 'all-in' ? t('pokerAllIn') : `${t('pokerRaiseTo')} ${action.to}`;
      return <button key={action.type} className={action.type === 'call' || action.type === 'check' ? 'primary-button' : 'secondary-button'} onClick={() => runAction(action)}>{label}</button>;
    })}</div>}
    {state.winner !== null && <div className="practice-result"><strong>{state.winner === 'split' ? t('gameSplitTitle') : state.winner === 0 ? t('gameWinTitle') : t('gameLossTitle')}</strong><button className="primary-button" onClick={() => setState(initTexasHoldem())}>{t('practiceAgain')}<span>↻</span></button></div>}
  </section>;
}

function PracticeHeading({ title, t, onExit }: { title: string; t: Translator; onExit: () => void }) {
  return <>
    <button className="back-button" onClick={onExit}>← {t('home')}</button>
    <div className="practice-heading"><div><span className="eyebrow">{t('freePractice')} · {t('bot')}</span><h1>{title}</h1></div><span className="bot-pill"><span className="bot-dot"/>{t('bot')}</span></div>
  </>;
}

function PokerCard({ card }: { card: Card | null }) {
  if (!card) return <span className="playing-card card-back" aria-hidden="true">✦</span>;
  const symbols: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
  const rank = card.rank === 14 ? 'A' : card.rank === 13 ? 'K' : card.rank === 12 ? 'Q' : card.rank === 11 ? 'J' : String(card.rank);
  return <span className={`playing-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red-suit' : ''}`}><b>{rank}</b><i>{symbols[card.suit]}</i></span>;
}

function outcome(winner: 0 | 1, t: Translator): string { return winner === 0 ? t('gameWinTitle') : t('gameLossTitle'); }
