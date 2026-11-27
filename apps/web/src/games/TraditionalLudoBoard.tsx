import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { LUDO_HOME, legalLudoActions, type LudoPlayer, type LudoState } from '@dire-bet/engines/ludo';

export type LudoBoardColor = 'red' | 'yellow' | 'green' | 'blue';
type BoardColor = LudoBoardColor;

export function LudoPawnPin({ color }: { color: LudoBoardColor }) {
  const palette: Record<LudoBoardColor, { main: string }> = {
    red: { main: '#e61c24' },
    yellow: { main: '#facc15' },
    blue: { main: '#1d8cf8' },
    green: { main: '#00a645' },
  };
  const { main } = palette[color] || palette.red;

  return (
    <svg className="ludo-pawn-svg" viewBox="3 1 34 45" fill="none" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="20" cy="36.5" rx="11.8" ry="6.8" fill={main} stroke="#111827" strokeWidth="1.35" />
      <ellipse cx="20" cy="36.5" rx="7.8" ry="4.3" fill={main} stroke="#111827" strokeWidth="1.15" />
      <path
        d="M 20 35.5 C 15.5 29.5 9.2 21.8 9.2 14.5 C 9.2 8.2 14.0 3.2 20 3.2 C 26.0 3.2 30.8 8.2 30.8 14.5 C 30.8 21.8 24.5 29.5 20 35.5 Z"
        fill="#ffffff"
        stroke="#111827"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="14.2" r="5.6" fill={main} stroke="#111827" strokeWidth="1.25" />
    </svg>
  );
}

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

const HOME_LANES: [[number, number][], [number, number][]] = [
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
];

const FINISH_TRIANGLES: [[number, number], [number, number]] = [
  [7, 6],
  [7, 8],
];

const HOME_SPACES: [number, number][][] = [
  [[1, 1], [1, 4], [4, 1], [4, 4]],
  [[10, 10], [10, 13], [13, 10], [13, 13]],
];

function rotate([row, column]: [number, number], turns: 0 | 1 | 2 | 3): [number, number] {
  if (turns === 1) return [column, 14 - row];
  if (turns === 2) return [14 - row, 14 - column];
  if (turns === 3) return [14 - column, row];
  return [row, column];
}

function cellStyle([row, column]: [number, number]): CSSProperties {
  return { gridRow: row + 1, gridColumn: column + 1 };
}

function copyTokens(tokens: LudoState['tokens']): LudoState['tokens'] {
  return [tokens[0].slice(), tokens[1].slice()];
}

type TrackCellDef = {
  row: number;
  col: number;
  kind: 'white' | 'start' | 'lane' | 'star' | 'arrow';
  color?: LudoBoardColor;
  content?: string;
};

const STATIC_TRACK_CELLS: TrackCellDef[] = [
  // Top Arm (cols 6..8, rows 0..5)
  { row: 0, col: 6, kind: 'white' },
  { row: 0, col: 7, kind: 'arrow', color: 'red', content: '↓' },
  { row: 0, col: 8, kind: 'white' },
  { row: 1, col: 6, kind: 'white' },
  { row: 1, col: 7, kind: 'lane', color: 'red' },
  { row: 1, col: 8, kind: 'start', color: 'red', content: '★' },
  { row: 2, col: 6, kind: 'star', color: 'blue', content: '★' },
  { row: 2, col: 7, kind: 'lane', color: 'red' },
  { row: 2, col: 8, kind: 'white' },
  { row: 3, col: 6, kind: 'white' },
  { row: 3, col: 7, kind: 'lane', color: 'red' },
  { row: 3, col: 8, kind: 'white' },
  { row: 4, col: 6, kind: 'white' },
  { row: 4, col: 7, kind: 'lane', color: 'red' },
  { row: 4, col: 8, kind: 'white' },
  { row: 5, col: 6, kind: 'white' },
  { row: 5, col: 7, kind: 'lane', color: 'red' },
  { row: 5, col: 8, kind: 'white' },

  // Right Arm (rows 6..8, cols 9..14)
  { row: 6, col: 9, kind: 'white' },
  { row: 6, col: 10, kind: 'white' },
  { row: 6, col: 11, kind: 'white' },
  { row: 6, col: 12, kind: 'star', color: 'red', content: '★' },
  { row: 6, col: 13, kind: 'white' },
  { row: 6, col: 14, kind: 'white' },
  { row: 7, col: 9, kind: 'lane', color: 'green' },
  { row: 7, col: 10, kind: 'lane', color: 'green' },
  { row: 7, col: 11, kind: 'lane', color: 'green' },
  { row: 7, col: 12, kind: 'lane', color: 'green' },
  { row: 7, col: 13, kind: 'lane', color: 'green' },
  { row: 7, col: 14, kind: 'arrow', color: 'green', content: '←' },
  { row: 8, col: 9, kind: 'white' },
  { row: 8, col: 10, kind: 'white' },
  { row: 8, col: 11, kind: 'white' },
  { row: 8, col: 12, kind: 'white' },
  { row: 8, col: 13, kind: 'start', color: 'green', content: '★' },
  { row: 8, col: 14, kind: 'white' },

  // Bottom Arm (cols 6..8, rows 9..14)
  { row: 9, col: 6, kind: 'white' },
  { row: 9, col: 7, kind: 'lane', color: 'yellow' },
  { row: 9, col: 8, kind: 'white' },
  { row: 10, col: 6, kind: 'white' },
  { row: 10, col: 7, kind: 'lane', color: 'yellow' },
  { row: 10, col: 8, kind: 'white' },
  { row: 11, col: 6, kind: 'white' },
  { row: 11, col: 7, kind: 'lane', color: 'yellow' },
  { row: 11, col: 8, kind: 'white' },
  { row: 12, col: 6, kind: 'white' },
  { row: 12, col: 7, kind: 'lane', color: 'yellow' },
  { row: 12, col: 8, kind: 'star', color: 'green', content: '★' },
  { row: 13, col: 6, kind: 'start', color: 'yellow', content: '★' },
  { row: 13, col: 7, kind: 'lane', color: 'yellow' },
  { row: 13, col: 8, kind: 'white' },
  { row: 14, col: 6, kind: 'white' },
  { row: 14, col: 7, kind: 'arrow', color: 'yellow', content: '↑' },
  { row: 14, col: 8, kind: 'white' },

  // Left Arm (rows 6..8, cols 0..5)
  { row: 6, col: 0, kind: 'white' },
  { row: 6, col: 1, kind: 'start', color: 'blue', content: '★' },
  { row: 6, col: 2, kind: 'white' },
  { row: 6, col: 3, kind: 'white' },
  { row: 6, col: 4, kind: 'white' },
  { row: 6, col: 5, kind: 'white' },
  { row: 7, col: 0, kind: 'arrow', color: 'blue', content: '→' },
  { row: 7, col: 1, kind: 'lane', color: 'blue' },
  { row: 7, col: 2, kind: 'lane', color: 'blue' },
  { row: 7, col: 3, kind: 'lane', color: 'blue' },
  { row: 7, col: 4, kind: 'lane', color: 'blue' },
  { row: 7, col: 5, kind: 'lane', color: 'blue' },
  { row: 8, col: 0, kind: 'white' },
  { row: 8, col: 1, kind: 'white' },
  { row: 8, col: 2, kind: 'star', color: 'yellow', content: '★' },
  { row: 8, col: 3, kind: 'white' },
  { row: 8, col: 4, kind: 'white' },
  { row: 8, col: 5, kind: 'white' },
];

const QUADRANTS: { color: LudoBoardColor; row: number; col: number }[] = [
  { color: 'blue', row: 0, col: 0 },
  { color: 'red', row: 0, col: 9 },
  { color: 'yellow', row: 9, col: 0 },
  { color: 'green', row: 9, col: 9 },
];

export function TraditionalLudoBoard({ game, seat, playerZeroColor, onMove }: {
  game: LudoState;
  seat: number;
  playerZeroColor: LudoBoardColor;
  onMove: (token: number) => void;
}) {
  const board: Record<LudoBoardColor, { colors: [BoardColor, BoardColor]; rotation: 0 | 1 | 2 | 3 }> = {
    red: { colors: ['red', 'yellow'], rotation: 1 },
    yellow: { colors: ['yellow', 'red'], rotation: 3 },
    blue: { colors: ['blue', 'green'], rotation: 0 },
    green: { colors: ['green', 'blue'], rotation: 2 },
  };
  const { colors, rotation } = board[playerZeroColor];
  const [visibleTokens, setVisibleTokens] = useState(() => copyTokens(game.tokens));
  const [animatingToken, setAnimatingToken] = useState<{ player: LudoPlayer; token: number } | null>(null);
  const [capturedToken, setCapturedToken] = useState<{ player: LudoPlayer; token: number } | null>(null);
  const previousTokens = useRef(copyTokens(game.tokens));
  const actions = legalLudoActions(game);

  useEffect(() => {
    const next = copyTokens(game.tokens);
    const previous = previousTokens.current;
    previousTokens.current = next;
    const move = game.lastMove;
    if (!move) {
      setVisibleTokens(next);
      setAnimatingToken(null);
      setCapturedToken(null);
      return;
    }

    const start = previous[move.player][move.token];
    const end = next[move.player][move.token];

    // If no forward steps, snap directly
    if (end <= start) {
      setVisibleTokens(next);
      return;
    }

    const steps = Array.from({ length: end - Math.max(start, -1) }, (_, index) => start < 0 ? index : start + index + 1);
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisibleTokens(next);
      return;
    }

    setVisibleTokens(previous);
    setAnimatingToken({ player: move.player, token: move.token });

    const stepDuration = 140;
    const timers: number[] = [];

    steps.forEach((position, index) => {
      timers.push(window.setTimeout(() => {
        setVisibleTokens((current) => {
          const updated = copyTokens(current);
          updated[move.player][move.token] = position;
          return updated;
        });
      }, (index + 1) * stepDuration));
    });

    const finishTime = steps.length * stepDuration + 30;
    timers.push(window.setTimeout(() => {
      setVisibleTokens(next);
      setAnimatingToken(null);
      if (move.captured) {
        setCapturedToken({ player: move.captured.player, token: move.captured.token });
        const resetTimer = window.setTimeout(() => setCapturedToken(null), 400);
        timers.push(resetTimer);
      }
    }, finishTime));

    return () => {
      timers.forEach(window.clearTimeout);
      setAnimatingToken(null);
    };
  }, [game]);

  // Compute cell coordinates for each token
  type TokenEntry = {
    player: LudoPlayer;
    token: number;
    row: number;
    col: number;
    pathPosition: number;
  };
  const rawTokens: TokenEntry[] = [];

  for (let player = 0; player < 2; player++) {
    for (let token = 0; token < 4; token++) {
      const position = visibleTokens[player][token];
      if (position === -1) {
        const [row, col] = rotate(HOME_SPACES[player][token], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -1 });
      } else if (position < 51) {
        const pathIndex = (position + player * 26) % 52;
        const [row, col] = rotate(TRACK[pathIndex], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: pathIndex });
      } else if (position < LUDO_HOME) {
        const [row, col] = rotate(HOME_LANES[player][position - 51], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -2 });
      } else {
        // Player's colored finish triangle inside center 3x3 finish area
        const [row, col] = rotate(FINISH_TRIANGLES[player], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -3 });
      }
    }
  }

  // Calculate multi-token spacing for tokens sharing the exact same cell
  const cellGroups = new Map<string, TokenEntry[]>();
  for (const t of rawTokens) {
    if (t.pathPosition === -1) continue;
    const key = `${t.row},${t.col}`;
    const group = cellGroups.get(key) || [];
    group.push(t);
    cellGroups.set(key, group);
  }

  const multiTokenOffsets: Record<number, { x: number; y: number; scale: number }[]> = {
    1: [{ x: 0, y: -2, scale: 1.18 }],
    2: [
      { x: -7, y: -1, scale: 0.96 },
      { x: 7, y: -1, scale: 0.96 },
    ],
    3: [
      { x: 0, y: -6, scale: 0.86 },
      { x: -7, y: 5, scale: 0.86 },
      { x: 7, y: 5, scale: 0.86 },
    ],
    4: [
      { x: -6, y: -6, scale: 0.8 },
      { x: 6, y: -6, scale: 0.8 },
      { x: -6, y: 6, scale: 0.8 },
      { x: 6, y: 6, scale: 0.8 },
    ],
  };

  const tokens = rawTokens.map((t) => {
    // Tokens in home base sit centered inside their larger 1.4-cell circular pad
    if (t.pathPosition === -1) {
      return { ...t, shiftX: 0, shiftY: -2, scale: 1.48 };
    }

    const group = cellGroups.get(`${t.row},${t.col}`) || [t];
    const groupIndex = group.findIndex((item) => item.player === t.player && item.token === t.token);
    const count = Math.min(Math.max(group.length, 1), 4);
    const offsets = multiTokenOffsets[count] || multiTokenOffsets[1];
    const offset = offsets[groupIndex] || { x: 0, y: -2, scale: 1.18 };

    return {
      ...t,
      shiftX: offset.x,
      shiftY: offset.y,
      scale: offset.scale,
    };
  });

  return (
    <div className="ludo-traditional-board" aria-label="Two-player traditional Ludo board">
      {/* 4 Large Home Quadrants */}
      {QUADRANTS.map(({ color, row, col }) => (
        <div
          key={color}
          className={`ludo-home-quadrant ${color}`}
          style={{ gridRow: `${row + 1} / span 6`, gridColumn: `${col + 1} / span 6` }}
        >
          <div className="home-pad" aria-hidden="true">
            <i /><i /><i /><i />
          </div>
        </div>
      ))}

      {/* 72 Static Track & Lane Cells */}
      {STATIC_TRACK_CELLS.map(({ row, col, kind, color, content }, idx) => (
        <span
          key={`cell-${row}-${col}-${idx}`}
          className={`ludo-track-cell ${kind}${color ? ` ${color}` : ''}`}
          style={cellStyle([row, col])}
        >
          {content || null}
        </span>
      ))}

      {/* Center 3x3 Finish Area: 4 clean colored triangles meeting at the center */}
      <div
        className="ludo-finish-area"
        style={{ gridRow: '7 / span 3', gridColumn: '7 / span 3' }}
        aria-label="Finish"
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="ludo-finish-svg">
          <polygon points="0,0 100,0 50,50" fill="#e61c24" />
          <polygon points="100,0 100,100 50,50" fill="#00a645" />
          <polygon points="0,100 100,100 50,50" fill="#facc15" />
          <polygon points="0,0 0,100 50,50" fill="#1d8cf8" />
          <line x1="0" y1="0" x2="100" y2="100" stroke="#ffffff" strokeWidth="1.2" />
          <line x1="100" y1="0" x2="0" y2="100" stroke="#ffffff" strokeWidth="1.2" />
        </svg>
      </div>

      {/* Active Pawns */}
      {tokens.map(({ player, token, row, col, pathPosition, shiftX, shiftY, scale }) => {
        const isHopping = animatingToken?.player === player && animatingToken?.token === token;
        const isCaptured = capturedToken?.player === player && capturedToken?.token === token;
        const isSelectable = player === seat && game.turn === seat && actions.includes(token);

        return (
          <button
            key={`${player}-${token}`}
            className={`ludo-board-token ${colors[player]} ${isSelectable ? 'selectable' : ''} ${player === game.turn ? 'turn-piece' : ''} ${pathPosition === -3 ? 'home-piece' : ''} ${isHopping ? 'token-hopping' : ''} ${isCaptured ? 'token-captured' : ''}`}
            style={{
              ...cellStyle([row, col]),
              '--piece-shift-x': `${shiftX}px`,
              '--piece-shift-y': `${shiftY}px`,
              '--piece-scale': `${scale}`,
            } as CSSProperties}
            aria-label={`${colors[player]} token ${token + 1}${pathPosition === -1 ? ', at home' : ''}`}
            disabled={!isSelectable}
            onClick={() => onMove(token)}
          >
            <LudoPawnPin color={colors[player]} />
          </button>
        );
      })}
    </div>
  );
}
