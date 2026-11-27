import { useEffect, useState } from 'react';
import { LUDO_HOME, botLudoToken, initLudo, legalLudoActions, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyPokerAction, botPokerAction, initTexasHoldem, legalPokerActions, type Card, type PokerAction, type PokerState, type Suit } from '@dire-bet/engines/poker';
import type { TranslationKey } from '../i18n';
import { TraditionalLudoBoard } from './TraditionalLudoBoard';
import { LudoDie, useLudoTurnClock } from './LudoDie';

export { CheckersPractice } from './CheckersRoom';

type Translator = (key: TranslationKey) => string;
type PracticeProps = { t: Translator; onExit: () => void; reduceEffects: boolean; tutorialMode?: boolean; onBackToLobby?: () => void };

export function LudoPractice({ t, onExit, reduceEffects, tutorialMode = false, onBackToLobby }: PracticeProps) {
  const [state, setState] = useState<LudoState>(() => initLudo(0, tutorialMode ? 1 : 4));
  const [sawCapture, setSawCapture] = useState(false);

  useEffect(() => {
    setState(initLudo(0, tutorialMode ? 1 : 4));
    setSawCapture(false);
  }, [tutorialMode]);

  useEffect(() => {
    if (state.lastEvent === 'capture' && state.lastMove?.player === 0) {
      setSawCapture(true);
    }
  }, [state.lastEvent, state.lastMove]);

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

  const legalActions = state.turn === 0 ? legalLudoActions(state) : [];
  const allAtBase = state.tokens[0].every((pos) => pos === -1);
  const nearHome = state.tokens[0].some((pos) => pos >= 46 && pos < LUDO_HOME);

  let tutorialHint = '';
  if (tutorialMode) {
    if (state.winner !== null) {
      tutorialHint = t('ludoTutStepComplete');
    } else if (state.lastEvent === 'capture' && state.lastMove?.player === 0) {
      tutorialHint = t('ludoTutStepCapture');
    } else if (state.turn === 0 && state.dice === 6 && state.tokens[0].some((pos) => pos === -1) && legalActions.length > 0) {
      tutorialHint = t('ludoTutStepSpawn');
    } else if (state.turn === 0 && state.dice !== null && legalActions.length > 0) {
      tutorialHint = nearHome ? t('ludoTutStepHome') : t('ludoTutStepMove');
    } else if (allAtBase) {
      tutorialHint = state.rollVersion > 0 && state.lastDice !== null && state.lastDice !== 6
        ? t('ludoTutStepNeed6').replace('{roll}', String(state.lastDice))
        : t('ludoTutStepRoll6');
    } else if (nearHome) {
      tutorialHint = t('ludoTutStepHome');
    } else if (sawCapture) {
      tutorialHint = t('ludoTutStepHome');
    } else {
      tutorialHint = state.turn === 0 ? t('ludoTutStepRoll6').replace('6', '1-6').split('.')[0] + ' · ' + t('yourTurn') : t('ludoTutStepCapture');
    }
  }

  const leaveTarget = onBackToLobby || onExit;
  const resetPractice = () => {
    setSawCapture(false);
    setState(initLudo(0, tutorialMode ? 1 : 4));
  };

  const turnCopy = state.winner !== null ? outcome(state.winner, t) : state.turn === 0 ? (state.dice === null ? t('yourTurn') : `${state.lastDice ? `${state.lastDice} · ` : ''}${t('selectToken')}`) : t('botTurn');
  const turnSeconds = useLudoTurnClock(`${state.turn}-${state.lastEvent}-${state.lastMove?.player ?? ''}-${state.lastMove?.token ?? ''}`);
  const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
  const statusBanner = state.lastEvent === 'capture' ? t('ludoCaptureNotice') : state.lastEvent === 'home' ? t('ludoHomeNotice') : turnCopy;
  return <section className="screen practice-screen practice-ludo-shell ludo-room-layout">
    <header className="ludo-room-topbar">
      <strong className="ludo-room-pill">{tutorialMode ? `${t('ludoTutorialBadge')} · ${t('bot')}` : `${t('freePractice')} · ${t('bot')}`}</strong>
      <span className="connection-pill connected"><i/>{t('bot')}</span>
      <div className="ludo-topbar-actions">
        <button className="ludo-fullscreen" type="button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
        <button className="ludo-leave" type="button" onClick={leaveTarget}>← {onBackToLobby ? t('back') : t('home')}</button>
      </div>
    </header>
    {tutorialMode && tutorialHint && (
      <div className={`ludo-tutorial-bubble ${state.winner !== null ? 'is-complete' : ''}`} role="status" aria-live="polite">
        <span className="tutorial-badge">{t('ludoTutorialBadge')}</span>
        <strong>{tutorialHint}</strong>
      </div>
    )}
    <div className="ludo-match-header">
      <PracticeLudoPlayerPanel name={t('you')} color="yellow" active={state.turn === 0 && state.winner === null} finished={state.tokens[0].filter((position) => position === LUDO_HOME).length} t={t}/>
      <div className="ludo-bet-card">
        <span className="ludo-bet-label">{tutorialMode ? t('ludoTutorialBadge') : t('freePractice')}</span>
        <strong className="ludo-bet-amount">{t('bot')}</strong>
        <span className="ludo-bet-timer">◷ {turnSeconds}s</span>
      </div>
      <PracticeLudoPlayerPanel name={t('bot')} color="red" active={state.turn === 1 && state.winner === null} finished={state.tokens[1].filter((position) => position === LUDO_HOME).length} t={t} bot/>
    </div>
    <div className="ludo-board-stage">
      <TraditionalLudoBoard game={state} seat={0} playerZeroColor="yellow" onMove={(token) => setState((current) => moveLudo(current, token))}/>
    </div>
    <LudoDie
      value={state.lastDice}
      rollVersion={state.rollVersion}
      color={state.turn === 0 ? 'yellow' : 'red'}
      canRoll={state.turn === 0 && state.dice === null && state.winner === null}
      onRoll={() => setState((current) => rollLudo(current, Math.floor(Math.random() * 6) + 1))}
      rollLabel={t('rollDice')}
      statusLabel={statusBanner}
      rightSlot={state.winner !== null ? (
        <div className="tutorial-end-actions">
          <button className="secondary-button" onClick={resetPractice}>{t('practiceAgain')} ↻</button>
          {tutorialMode && onBackToLobby && <button className="primary-button" onClick={onBackToLobby}>{t('ludoTutBackToLobby')} →</button>}
        </div>
      ) : undefined}
      reducedMotion={reduceEffects}
    />
  </section>;
}

function PracticeLudoPlayerPanel({ name, color, active, finished, t, bot = false }: { name: string; color: 'red'|'yellow'; active: boolean; finished: number; t: Translator; bot?: boolean }) {
  return <article className={`ludo-player-panel ${color} ${active ? 'turn-active' : ''}`}>
    <div className="ludo-player-top">
      <span className={`ludo-player-avatar ${color}`}>{bot ? '✦' : name.trim().slice(0, 1).toUpperCase()}</span>
      <div className="ludo-player-copy">
        <strong>{name}</strong>
        <small><i className={`player-online-dot ${active ? 'online' : ''}`}/>{color === 'red' ? t('marketRed') : t('marketYellow')} · {finished}/4</small>
      </div>
    </div>
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
