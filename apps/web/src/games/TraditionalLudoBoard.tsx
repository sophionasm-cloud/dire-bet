import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { legalLudoActions, type LudoPlayer, type LudoState } from '@dire-bet/engines/ludo';

type PlayerColor = 'blue' | 'white';
type BoardColor = 'red' | 'yellow';

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

function rotate([row, column]: [number, number], clockwise: boolean): [number, number] {
  return clockwise ? [column, 14 - row] : [14 - column, row];
}

function cellStyle([row, column]: [number, number]): CSSProperties {
  return { gridRow: row + 1, gridColumn: column + 1 };
}

function copyTokens(tokens: LudoState['tokens']): LudoState['tokens'] {
  return [tokens[0].slice(), tokens[1].slice()];
}

export function TraditionalLudoBoard({ game, seat, playerZeroColor, onMove }: {
  game: LudoState;
  seat: number;
  playerZeroColor: PlayerColor;
  onMove: (token: number) => void;
}) {
  const colors: [BoardColor, BoardColor] = playerZeroColor === 'blue' ? ['red', 'yellow'] : ['yellow', 'red'];
  const clockwise = colors[0] === 'red';
  const [visibleTokens, setVisibleTokens] = useState(() => copyTokens(game.tokens));
  const previousTokens = useRef(copyTokens(game.tokens));
  const actions = legalLudoActions(game);

  useEffect(() => {
    const next = copyTokens(game.tokens);
    const previous = previousTokens.current;
    previousTokens.current = next;
    const move = game.lastMove;
    if (!move) { setVisibleTokens(next); return; }

    const start = previous[move.player][move.token];
    const end = next[move.player][move.token];
    if (end <= start) { setVisibleTokens(next); return; }

    const steps = Array.from({ length: end - Math.max(start, -1) }, (_, index) => start < 0 ? index : start + index + 1);
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setVisibleTokens(next); return; }
    setVisibleTokens(previous);
    const timers: number[] = [];
    steps.forEach((position, index) => timers.push(window.setTimeout(() => {
      setVisibleTokens((current) => {
        const updated = copyTokens(current);
        updated[move.player][move.token] = position;
        return updated;
      });
    }, (index + 1) * 135)));
    timers.push(window.setTimeout(() => setVisibleTokens(next), steps.length * 135 + 25));
    return () => timers.forEach(window.clearTimeout);
  }, [game]);

  const tokens: { player: LudoPlayer; token: number; row: number; col: number; pathPosition: number }[] = [];
  for (let player = 0; player < 2; player++) {
    for (let token = 0; token < 4; token++) {
      const position = visibleTokens[player][token];
      if (position === -1) {
        const [row, col] = rotate(HOME_SPACES[player][token], clockwise);
        tokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -1 });
      } else if (position < 52) {
        const pathIndex = (position + player * 26) % 52;
        const [row, col] = rotate(TRACK[pathIndex], clockwise);
        tokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: pathIndex });
      } else if (position < 57) {
        const [row, col] = rotate(HOME_LANES[player][position - 52], clockwise);
        tokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -2 });
      } else {
        tokens.push({ player: player as LudoPlayer, token, row: 7, col: 7, pathPosition: -3 });
      }
    }
  }

  const quadrants: { color: string; row: number; column: number }[] = [
    { color: 'blue', row: 0, column: 0 }, { color: 'red', row: 0, column: 9 },
    { color: 'yellow', row: 9, column: 0 }, { color: 'green', row: 9, column: 9 },
  ];

  return <div className="ludo-traditional-board" aria-label="Two-player traditional Ludo board">
    {quadrants.map(({ color, row, column }) => <div key={color} className={`ludo-home-quadrant ${color}`} style={{ gridRow: `${row + 1} / span 6`, gridColumn: `${column + 1} / span 6` }}>
      <div className="home-pad" aria-hidden="true">{[0, 1, 2, 3].map((well) => <i key={well}/>)}</div>
    </div>)}
    {TRACK.map((point, index) => {
      const [row, col] = rotate(point, clockwise);
      const color = index === 0 ? colors[0] : index === 26 ? colors[1] : null;
      const arrow = index === 0 ? (clockwise ? '↓' : '↑') : index === 26 ? (clockwise ? '↑' : '↓') : '';
      return <span key={`track-${index}`} className={`ludo-track-cell ${SAFE.has(index) ? 'safe' : ''} ${color ? `start ${color}` : ''}`} style={cellStyle([row, col])}>{SAFE.has(index) ? '★' : arrow}</span>;
    })}
    {HOME_LANES.map((lane, player) => lane.map((point, index) => <span key={`lane-${player}-${index}`} className={`ludo-home-lane ${colors[player]}`} style={cellStyle(rotate(point, clockwise))}/>))}
    {NEUTRAL_LANE.map((point, index) => <span key={`neutral-${index}`} className="ludo-neutral-lane" style={cellStyle(rotate(point, clockwise))}/>)}
    <div className="ludo-finish-area" style={{ gridRow: '7 / span 3', gridColumn: '7 / span 3' }} aria-label="Finish"><span>✦</span></div>
    {tokens.map(({ player, token, row, col, pathPosition }) => <button
      key={`${player}-${token}`}
      className={`ludo-board-token ${colors[player]} ${player === seat && game.turn === seat && actions.includes(token) ? 'selectable' : ''} ${player === game.turn ? 'turn-piece' : ''} ${pathPosition === -3 ? 'home-piece' : ''}`}
      style={{ ...cellStyle([row, col]), '--piece-shift-x': pathPosition === -1 ? '0px' : `${token % 2 ? 3 : -3}px`, '--piece-shift-y': pathPosition === -1 ? '0px' : `${Math.floor(token / 2) ? 3 : -3}px` } as CSSProperties}
      aria-label={`${colors[player]} token ${token + 1}${pathPosition === -1 ? ', at home' : ''}`}
      disabled={player !== seat || game.turn !== seat || !actions.includes(token)}
      onClick={() => onMove(token)}
    ><span>{token + 1}</span></button>)}
  </div>;
}
