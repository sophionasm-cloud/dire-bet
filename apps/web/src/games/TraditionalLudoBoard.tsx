import type { CSSProperties } from 'react';
import { legalLudoActions, type LudoState } from '@dire-bet/engines/ludo';

type PlayerColor = 'blue' | 'white';

const TRACK: [number, number][] = [
  ...[1, 2, 3, 4, 5].map((column) => [6, column] as [number, number]),
  ...[5, 4, 3, 2, 1, 0].map((row) => [row, 6] as [number, number]), [0, 7], [0, 8],
  ...[1, 2, 3, 4, 5].map((row) => [row, 8] as [number, number]),
  ...[9, 10, 11, 12, 13, 14].map((column) => [6, column] as [number, number]), [7, 14], [8, 14],
  ...[13, 12, 11, 10, 9].map((column) => [8, column] as [number, number]),
  ...[9, 10, 11, 12, 13, 14].map((row) => [row, 8] as [number, number]), [14, 7], [14, 6],
  ...[13, 12, 11, 10, 9].map((row) => [row, 6] as [number, number]),
  ...[5, 4, 3, 2, 1, 0].map((column) => [8, column] as [number, number]), [7, 0], [6, 0],
];

const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const HOME_LANES: [[number, number][], [number, number][]] = [
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
];
const NEUTRAL_LANE: [number, number][] = [
  ...[1, 2, 3, 4, 5].map((row) => [row, 7] as [number, number]),
  ...[9, 10, 11, 12, 13].map((row) => [row, 7] as [number, number]),
];
const HOME_SPACES: [number, number][][] = [
  [[1, 1], [1, 4], [4, 1], [4, 4]],
  [[10, 10], [10, 13], [13, 10], [13, 13]],
];

export function TraditionalLudoBoard({
  game,
  seat,
  playerZeroColor,
  onMove,
}: {
  game: LudoState;
  seat: number;
  playerZeroColor: PlayerColor;
  onMove: (token: number) => void;
}) {
  const colors: [PlayerColor, PlayerColor] = [playerZeroColor, playerZeroColor === 'blue' ? 'white' : 'blue'];
  const tokens: { player: number; token: number; row: number; col: number; pathPosition: number }[] = [];

  for (let player = 0; player < 2; player++) {
    for (let token = 0; token < 4; token++) {
      const position = game.tokens[player][token];
      if (position === -1) {
        const [row, col] = HOME_SPACES[player][token];
        tokens.push({ player, token, row, col, pathPosition: -1 });
      } else if (position < 52) {
        const pathIndex = (position + player * 26) % 52;
        const [row, col] = TRACK[pathIndex];
        tokens.push({ player, token, row, col, pathPosition: pathIndex });
      } else if (position < 57) {
        const [row, col] = HOME_LANES[player][position - 52];
        tokens.push({ player, token, row, col, pathPosition: -2 });
      } else {
        tokens.push({ player, token, row: 7, col: 7, pathPosition: -3 });
      }
    }
  }

  const actions = legalLudoActions(game);
  return <div className="ludo-traditional-board" aria-label="Traditional two-player Ludo board">
    <div className={`ludo-home-quadrant active ${colors[0]}`} style={{ gridRow: '1 / span 6', gridColumn: '1 / span 6' }}><div className="home-pad"/></div>
    <div className="ludo-home-quadrant neutral" style={{ gridRow: '1 / span 6', gridColumn: '10 / span 6' }}><div className="home-pad muted"/></div>
    <div className="ludo-home-quadrant neutral" style={{ gridRow: '10 / span 6', gridColumn: '1 / span 6' }}><div className="home-pad muted"/></div>
    <div className={`ludo-home-quadrant active ${colors[1]}`} style={{ gridRow: '10 / span 6', gridColumn: '10 / span 6' }}><div className="home-pad"/></div>
    {TRACK.map(([row, col], index) => <span key={`track-${index}`} className={`ludo-track-cell ${SAFE.has(index) ? 'safe' : ''} ${index === 0 ? `start ${colors[0]}` : ''} ${index === 26 ? `start ${colors[1]}` : ''}`} style={{ gridRow: row + 1, gridColumn: col + 1 }}>{SAFE.has(index) ? '✦' : index === 0 || index === 26 ? '▲' : ''}</span>)}
    {HOME_LANES[0].map(([row, col], index) => <span key={`lane-0-${index}`} className={`ludo-home-lane ${colors[0]}`} style={{ gridRow: row + 1, gridColumn: col + 1 }}/>) }
    {HOME_LANES[1].map(([row, col], index) => <span key={`lane-1-${index}`} className={`ludo-home-lane ${colors[1]}`} style={{ gridRow: row + 1, gridColumn: col + 1 }}/>) }
    {NEUTRAL_LANE.map(([row, col], index) => <span key={`neutral-lane-${index}`} className="ludo-neutral-lane" style={{ gridRow: row + 1, gridColumn: col + 1 }}/>) }
    <div className="ludo-finish-area" style={{ gridRow: '7 / span 3', gridColumn: '7 / span 3' }} aria-label="Finish"><span>✦</span></div>
    {tokens.map(({ player, token, row, col, pathPosition }) => <button
      key={`${player}-${token}`}
      className={`ludo-board-token ${colors[player]} ${player === seat && game.turn === seat && actions.includes(token) ? 'selectable' : ''} ${player === game.turn ? 'turn-piece' : ''} ${pathPosition === -3 ? 'home-piece' : ''}`}
      style={{ gridRow: row + 1, gridColumn: col + 1, '--piece-shift-x': `${token % 2 ? 4 : -4}px`, '--piece-shift-y': `${Math.floor(token / 2) ? 4 : -4}px` } as CSSProperties}
      aria-label={`${colors[player]} token ${token + 1}${pathPosition === -1 ? ', at home' : ''}`}
      disabled={player !== seat || game.turn !== seat || !actions.includes(token)}
      onClick={() => onMove(token)}
    >{token + 1}</button>)}
  </div>;
}
