import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { legalLudoActions, type LudoPlayer, type LudoState } from '@dire-bet/engines/ludo';

export type LudoBoardColor = 'red' | 'yellow' | 'green' | 'blue';
type BoardColor = LudoBoardColor;

export function LudoPawnPin({ color }: { color: LudoBoardColor }) {
  const palette: Record<LudoBoardColor, { light: string; main: string; dark: string }> = {
    red: { light: '#ff7a84', main: '#e61c24', dark: '#8c0d14' },
    yellow: { light: '#fff066', main: '#facc15', dark: '#a16207' },
    blue: { light: '#7dd3fc', main: '#1d8cf8', dark: '#1e3a8a' },
    green: { light: '#6ee7b7', main: '#00a645', dark: '#065f46' },
  };
  const { light, main, dark } = palette[color] || palette.red;
  const gradId = `ludo-pawn-grad-${color}`;

  return (
    <svg className="ludo-pawn-svg" viewBox="0 0 40 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={gradId} cx="35%" cy="28%" r="72%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.82" />
          <stop offset="28%" stopColor={light} />
          <stop offset="72%" stopColor={main} />
          <stop offset="100%" stopColor={dark} />
        </radialGradient>
      </defs>
      <ellipse cx="20" cy="41.5" rx="14.5" ry="5.2" fill={dark} stroke="rgba(15,23,42,0.45)" strokeWidth="1" />
      <ellipse cx="20" cy="40" rx="13.2" ry="4.3" fill={`url(#${gradId})`} />
      <path
        d="M 10 38.5 C 11 28 15 21 16 17 L 24 17 C 25 21 29 28 30 38.5 Z"
        fill={`url(#${gradId})`}
        stroke={dark}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <ellipse cx="20" cy="17.5" rx="6.6" ry="2.2" fill={light} stroke={dark} strokeWidth="0.8" />
      <circle cx="20" cy="10.8" r="7.4" fill={`url(#${gradId})`} stroke={dark} strokeWidth="1" />
      <ellipse cx="17.2" cy="8" rx="2.4" ry="1.5" fill="#ffffff" opacity="0.68" transform="rotate(-24 17.2 8)" />
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
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
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
  { row: 1, col: 8, kind: 'start', color: 'red' },
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
  { row: 8, col: 13, kind: 'start', color: 'green' },
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
  { row: 13, col: 6, kind: 'start', color: 'yellow' },
  { row: 13, col: 7, kind: 'lane', color: 'yellow' },
  { row: 13, col: 8, kind: 'white' },
  { row: 14, col: 6, kind: 'white' },
  { row: 14, col: 7, kind: 'arrow', color: 'yellow', content: '↑' },
  { row: 14, col: 8, kind: 'white' },

  // Left Arm (rows 6..8, cols 0..5)
  { row: 6, col: 0, kind: 'white' },
  { row: 6, col: 1, kind: 'start', color: 'blue' },
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
      } else if (position < 52) {
        const pathIndex = (position + player * 26) % 52;
        const [row, col] = rotate(TRACK[pathIndex], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: pathIndex });
      } else if (position < 57) {
        const [row, col] = rotate(HOME_LANES[player][position - 52], rotation);
        rawTokens.push({ player: player as LudoPlayer, token, row, col, pathPosition: -2 });
      } else {
        // Center finish area (7, 7)
        rawTokens.push({ player: player as LudoPlayer, token, row: 7, col: 7, pathPosition: -3 });
      }
    }
  }

  // Calculate multi-token spacing for tokens sharing the exact same cell
  const cellGroups = new Map<string, TokenEntry[]>();
  for (const t of rawTokens) {
    const key = `${t.row},${t.col}`;
    const group = cellGroups.get(key) || [];
    group.push(t);
    cellGroups.set(key, group);
  }

  const multiTokenOffsets: Record<number, { x: number; y: number; scale: number }[]> = {
    1: [{ x: 0, y: 0, scale: 1 }],
    2: [
      { x: -5, y: 0, scale: 0.88 },
      { x: 5, y: 0, scale: 0.88 },
    ],
    3: [
      { x: 0, y: -5, scale: 0.78 },
      { x: -5, y: 5, scale: 0.78 },
      { x: 5, y: 5, scale: 0.78 },
    ],
    4: [
      { x: -5, y: -5, scale: 0.72 },
      { x: 5, y: -5, scale: 0.72 },
      { x: -5, y: 5, scale: 0.72 },
      { x: 5, y: 5, scale: 0.72 },
    ],
  };

  const tokens = rawTokens.map((t) => {
    // Tokens in home base are in separate distinct circles, keep centered
    if (t.pathPosition === -1) {
      return { ...t, shiftX: 0, shiftY: 0, scale: 1 };
    }

    const group = cellGroups.get(`${t.row},${t.col}`) || [t];
    const groupIndex = group.findIndex((item) => item.player === t.player && item.token === t.token);
    const count = Math.min(Math.max(group.length, 1), 4);
    const offsets = multiTokenOffsets[count] || multiTokenOffsets[1];
    const offset = offsets[groupIndex] || { x: 0, y: 0, scale: 1 };

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
          <polygon points="100,0 100,100 50,50" fill="#009b3a" />
          <polygon points="0,100 100,100 50,50" fill="#ffdb00" />
          <polygon points="0,0 0,100 50,50" fill="#29aefd" />
          <line x1="0" y1="0" x2="100" y2="100" stroke="#8e9ca8" strokeWidth="1" />
          <line x1="100" y1="0" x2="0" y2="100" stroke="#8e9ca8" strokeWidth="1" />
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
