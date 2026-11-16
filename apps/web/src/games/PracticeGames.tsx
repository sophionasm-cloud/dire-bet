import { useEffect, useState } from 'react';
import { botLudoToken, initLudo, legalLudoActions, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyDominoAction, botDominoAction, legalDominoActions, newDominoesGame, nextDominoesRound, type DominoAction, type DominoesState, type Tile } from '@dire-bet/engines/dominoes';
import { applyPokerAction, botPokerAction, initTexasHoldem, legalPokerActions, type Card, type PokerAction, type PokerState, type Suit } from '@dire-bet/engines/poker';
import type { TranslationKey } from '../i18n';

type Translator = (key: TranslationKey) => string;
type PracticeProps = { t: Translator; onExit: () => void; reduceEffects: boolean };

export function LudoPractice({ t, onExit, reduceEffects }: PracticeProps) {
  const [state, setState] = useState<LudoState>(() => initLudo());
  const actions = legalLudoActions(state);
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

  const ownTokens = state.tokens[0].map((position, token) => ({ position, token, player: 0 as const }));
  const botTokens = state.tokens[1].map((position, token) => ({ position, token, player: 1 as const }));
  return <section className="screen practice-screen ludo-screen">
    <PracticeHeading title="Ludo" t={t} onExit={onExit} />
    <p className="practice-rules">{t('ludoRuleText')}</p>
    <div className="ludo-score-row"><span className="practice-player"><i className="player-dot red-dot"/>{t('you')}</span><span className="practice-turn">{state.winner !== null ? outcome(state.winner, t) : state.turn === 0 ? (state.dice === null ? t('yourTurn') : t('selectToken')) : t('botTurn')}</span><span className="practice-player"><i className="player-dot blue-dot"/>{t('bot')}</span></div>
    <div className="ludo-board" aria-label="Ludo board">
      {Array.from({ length: 52 }, (_, index) => <span key={index} className={`ludo-cell ${index === 0 ? 'start-red' : ''} ${index === 26 ? 'start-blue' : ''}`} style={ringPoint(index)} />)}
      <div className="ludo-center">✦</div>
      {[...botTokens, ...ownTokens].map(({ position, token, player }) => {
        const point = tokenPoint(position, token, player);
        const canMove = player === 0 && state.turn === 0 && actions.includes(token);
        const className = `ludo-token ${player === 0 ? 'side-you' : 'side-bot'} ${canMove ? 'token-ready' : ''}`;
        return canMove
          ? <button key={`${player}-${token}`} className={className} style={point} onClick={() => setState((current) => moveLudo(current, token))} aria-label={`${t('selectToken')} ${token + 1}`}>{token + 1}</button>
          : <span key={`${player}-${token}`} className={className} style={point} aria-label={`${player === 0 ? t('you') : t('bot')} ${token + 1}`}>{token + 1}</span>;
      })}
    </div>
    <div className="ludo-controls">
      <div className={`dice-face ${state.dice === null ? '' : 'dice-active'}`} aria-live="polite">{state.dice ?? '·'}</div>
      <button className="primary-button" disabled={state.turn !== 0 || state.dice !== null || state.winner !== null} onClick={() => setState((current) => rollLudo(current, Math.floor(Math.random() * 6) + 1))}>{t('rollDice')}<span>↻</span></button>
      {state.winner !== null && <button className="secondary-button" onClick={() => setState(initLudo())}>{t('practiceAgain')}</button>}
    </div>
  </section>;
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

function ringPoint(index: number): React.CSSProperties {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / 52;
  return { left: `${50 + Math.cos(angle) * 38}%`, top: `${50 + Math.sin(angle) * 38}%` };
}

function tokenPoint(position: number, token: number, player: 0 | 1): React.CSSProperties {
  if (position === -1) {
    const base = player === 0 ? { x: 28, y: 69 } : { x: 72, y: 31 };
    return { left: `${base.x + (token % 2) * 6}%`, top: `${base.y + Math.floor(token / 2) * 6}%` };
  }
  const progress = position < 52 ? position : 52;
  const angle = -Math.PI / 2 + (Math.PI * 2 * ((progress + player * 26) % 52)) / 52;
  const radius = position < 52 ? 38 : Math.max(4, 28 - (position - 52) * 5);
  return { left: `${50 + Math.cos(angle) * radius}%`, top: `${50 + Math.sin(angle) * radius}%` };
}
