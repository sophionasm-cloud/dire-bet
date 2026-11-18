import { useEffect, useState } from 'react';
import { botLudoToken, initLudo, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyDominoAction, botDominoAction, legalDominoActions, newDominoesGame, nextDominoesRound, type DominoAction, type DominoesState, type Tile } from '@dire-bet/engines/dominoes';
import { applyPokerAction, botPokerAction, initTexasHoldem, legalPokerActions, type Card, type PokerAction, type PokerState, type Suit } from '@dire-bet/engines/poker';
import type { TranslationKey } from '../i18n';
import { TraditionalLudoBoard } from './TraditionalLudoBoard';

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
    }), reduceEffects ? 180 : 580);
    return () => window.clearTimeout(timer);
  }, [state, reduceEffects]);

  const turnCopy = state.winner !== null ? outcome(state.winner, t) : state.turn === 0 ? (state.dice === null ? t('yourTurn') : t('selectToken')) : t('botTurn');
  const fullscreen = () => document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen?.();
  return <section className="screen practice-screen practice-ludo-shell ludo-room-layout">
    <header className="ludo-room-topbar">
      <div className="ludo-brand"><span className="ludo-brand-crown">♛</span><strong>DIRE <b>BET</b></strong></div>
      <span className="ludo-game-label"><i>⚄</i> Ludo</span>
      <strong className="ludo-room-pill">{t('freePractice')} · {t('bot')}</strong>
      <span className="connection-pill connected"><i/>{t('bot')}</span>
      <button className="ludo-fullscreen" type="button" aria-label={t('marketFullScreen')} title={t('marketFullScreen')} onClick={fullscreen}>⛶</button>
      <button className="ludo-leave" type="button" onClick={onExit}>← {t('home')}</button>
    </header>
    <div className="ludo-match-meta practice-ludo-meta"><span>{t('ludoRuleText')}</span><small aria-live="polite">{turnCopy}</small></div>
    <div className="ludo-two-player-layout">
      <PracticeLudoPlayerPanel name={t('you')} color="blue" active={state.turn === 0 && state.winner === null} finished={state.tokens[0].filter((position) => position === 57).length} t={t}/>
      <div className="ludo-board-stage"><TraditionalLudoBoard game={state} seat={0} playerZeroColor="blue" onMove={(token) => setState((current) => moveLudo(current, token))}/></div>
      <PracticeLudoPlayerPanel name={t('bot')} color="white" active={state.turn === 1 && state.winner === null} finished={state.tokens[1].filter((position) => position === 57).length} t={t} bot/>
    </div>
    <div className="ludo-controls-wrap practice-ludo-controls">
      <div className={`ludo-dice ${state.dice === null ? '' : 'rolled'}`} aria-live="polite" aria-label={state.dice === null ? 'Dice not rolled' : `Dice ${state.dice}`}><span>{state.dice === null ? '⚄' : ['','⚀','⚁','⚂','⚃','⚄','⚅'][state.dice]}</span></div>
      {state.turn === 0 && state.dice === null && state.winner === null
        ? <button className="ludo-roll-button" onClick={() => setState((current) => rollLudo(current, Math.floor(Math.random() * 6) + 1))}><span>⚄</span>{t('rollDice')}</button>
        : <div className="ludo-waiting-turn" role="status">{state.winner === null ? turnCopy : <><strong>{turnCopy}</strong><button className="secondary-button" onClick={() => setState(initLudo())}>{t('practiceAgain')} ↻</button></>}</div>}
    </div>
  </section>;
}

function PracticeLudoPlayerPanel({ name, color, active, finished, t, bot = false }: { name: string; color: 'blue'|'white'; active: boolean; finished: number; t: Translator; bot?: boolean }) {
  return <article className={`ludo-player-panel ${color} ${active ? 'turn-active' : ''}`}>
    <span className={`ludo-player-avatar ${color}`}>{bot ? '✦' : name.trim().slice(0, 1).toUpperCase()}</span>
    <div className="ludo-player-copy"><strong>{name}</strong><small><i className={`player-online-dot ${active ? 'online' : ''}`}/>{bot ? t('bot') : t('you')} · {color === 'blue' ? t('marketBlue') : t('marketWhite')}</small></div>
    <span className={`ludo-player-score ${color}`} aria-label={`${finished} of 4 tokens finished`}>{finished}/4</span>
    <span className={`ludo-turn-label ${active ? 'visible' : ''}`}>{active ? (bot ? t('botTurn') : t('yourTurn')) : t('marketWaiting')}</span>
  </article>;
}

export function DominoesPractice({ t, onExit, reduceEffects }: PracticeProps) {
  const [state, setState] = useState<DominoesState>(() => newDominoesGame());
  const actions = legalDominoActions(state);
  useEffect(() => {
    if (state.turn !== 1 || state.status !== 'playing') return;
    const timer = window.setTimeout(() => setState((current) => {
      const action = botDominoAction(current);
      return action ? applyDominoAction(current, action) : current;
    }), reduceEffects ? 180 : 620);
    return () => window.clearTimeout(timer);
  }, [state, reduceEffects]);

  const apply = (action: DominoAction) => setState((current) => applyDominoAction(current, action));
  return <section className="screen practice-screen dominoes-screen">
    <PracticeHeading title="Dominoes" t={t} onExit={onExit} />
    <div className="table-score"><span>{t('gameScore')}</span><strong>{state.scores[0]} <i>:</i> {state.scores[1]}</strong><small>{t('roundNumber')} {state.round} · {t('you')} vs {t('bot')}</small></div>
    <div className="domino-opponent"><span className="bot-avatar">✦</span><strong>{t('bot')}</strong><small>{state.hands[1].length} · {t('yourTiles').toLowerCase()}</small></div>
    <div className="domino-chain" aria-label="Domino line">{state.chain.length ? state.chain.map((tile, index) => <DominoTile tile={tile} key={`${index}-${tile[0]}-${tile[1]}`} />) : <span className="chain-empty">{t('yourTurn')}</span>}</div>
    {state.status === 'playing' && <p className="practice-turn domino-turn" aria-live="polite">{state.turn === 0 ? t('yourTurn') : t('botTurn')}</p>}
    {state.status === 'playing' && state.turn === 0 && <>
      <div className="domino-actions">
        {actions.some((action) => action.type === 'draw') && <button className="secondary-button" onClick={() => apply({ type: 'draw' })}>{t('drawTile')}<span>＋</span></button>}
        {actions.some((action) => action.type === 'pass') && <button className="secondary-button" onClick={() => apply({ type: 'pass' })}>{t('passTurn')}<span>↗</span></button>}
      </div>
      <h2 className="practice-section-title">{t('yourTiles')}</h2>
      <div className="domino-hand">{state.hands[0].map((tile, index) => {
        const placements = actions.filter((action): action is Extract<DominoAction, { type: 'place' }> => action.type === 'place' && action.tile === index);
        return <div className="domino-hand-item" key={`${index}-${tile[0]}-${tile[1]}`}><DominoTile tile={tile} /><div>{placements.map((action) => <button key={`${action.end}-${action.flip}`} aria-label={`${action.end === 'left' ? t('placeLeft') : t('placeRight')} ${tile[0]}-${tile[1]}`} onClick={() => apply(action)}>{action.end === 'left' ? `← ${t('placeLeft')}` : `${t('placeRight')} →`}</button>)}</div></div>;
      })}</div>
    </>}
    {state.status !== 'playing' && <div className="practice-result"><strong>{state.status === 'finished' ? outcome(state.winner!, t) : state.roundWinner === null ? t('blockedRound') : state.roundWinner === 0 ? t('gameWinTitle') : t('gameLossTitle')}</strong>{state.status === 'between-rounds' ? <button className="primary-button" onClick={() => setState((current) => nextDominoesRound(current))}>{t('nextRound')}<span>→</span></button> : <button className="primary-button" onClick={() => setState(newDominoesGame())}>{t('practiceAgain')}<span>↻</span></button>}</div>}
  </section>;
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

function DominoTile({ tile }: { tile: Tile }) {
  return <span className="domino-tile" aria-label={`${tile[0]}-${tile[1]}`}><i>{tile[0]}</i><b/><i>{tile[1]}</i></span>;
}

function PokerCard({ card }: { card: Card | null }) {
  if (!card) return <span className="playing-card card-back" aria-hidden="true">✦</span>;
  const symbols: Record<Suit, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
  const rank = card.rank === 14 ? 'A' : card.rank === 13 ? 'K' : card.rank === 12 ? 'Q' : card.rank === 11 ? 'J' : String(card.rank);
  return <span className={`playing-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red-suit' : ''}`}><b>{rank}</b><i>{symbols[card.suit]}</i></span>;
}

function outcome(winner: 0 | 1, t: Translator): string { return winner === 0 ? t('gameWinTitle') : t('gameLossTitle'); }
