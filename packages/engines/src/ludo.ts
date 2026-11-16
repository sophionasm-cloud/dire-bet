export type LudoPlayer = 0 | 1;
export type LudoEvent = 'roll' | 'move' | 'no-move' | 'extra-roll' | 'triple-six' | 'capture' | 'home' | 'win';
export type LudoState = {
  tokens: [number[], number[]];
  turn: LudoPlayer;
  dice: number | null;
  consecutiveSixes: number;
  winner: LudoPlayer | null;
  lastEvent: LudoEvent | null;
  lastMove: { player: LudoPlayer; token: number; captured?: { player: LudoPlayer; token: number } } | null;
};

const HOME = 57;
const TRACK_LENGTH = 52;
const STARTS: [number, number] = [0, 26];
const SAFE_TRACK_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export function initLudo(firstPlayer: LudoPlayer = 0): LudoState {
  return { tokens: [[-1, -1, -1, -1], [-1, -1, -1, -1]], turn: firstPlayer, dice: null, consecutiveSixes: 0, winner: null, lastEvent: null, lastMove: null };
}

export function legalLudoActions(state: LudoState): number[] {
  if (state.winner !== null || state.dice === null) return [];
  return state.tokens[state.turn].flatMap((position, token) => {
    if (position === HOME) return [];
    if (position === -1) return state.dice === 6 ? [token] : [];
    return position + (state.dice ?? 0) <= HOME ? [token] : [];
  });
}

export function rollLudo(state: LudoState, dice: number): LudoState {
  if (state.winner !== null || state.dice !== null || !Number.isInteger(dice) || dice < 1 || dice > 6) throw new Error('Illegal roll');
  const consecutiveSixes = dice === 6 ? state.consecutiveSixes + 1 : 0;
  if (consecutiveSixes >= 3) return { ...state, turn: other(state.turn), dice: null, consecutiveSixes: 0, lastEvent: 'triple-six', lastMove: null };
  const rolled = { ...state, dice, consecutiveSixes, lastEvent: 'roll' as const, lastMove: null };
  if (legalLudoActions(rolled).length) return rolled;
  if (dice === 6) return { ...rolled, dice: null, lastEvent: 'extra-roll' };
  return { ...rolled, turn: other(state.turn), dice: null, consecutiveSixes: 0, lastEvent: 'no-move' };
}

export function moveLudo(state: LudoState, token: number): LudoState {
  if (!Number.isInteger(token) || !legalLudoActions(state).includes(token) || state.dice === null) throw new Error('Illegal move');
  const player = state.turn;
  const tokens: [number[], number[]] = [state.tokens[0].slice(), state.tokens[1].slice()];
  const previous = tokens[player][token];
  const position = previous === -1 ? 0 : previous + state.dice;
  tokens[player][token] = position;
  let captured: { player: LudoPlayer; token: number } | undefined;
  if (position < TRACK_LENGTH) {
    const trackCell = (position + STARTS[player]) % TRACK_LENGTH;
    if (!SAFE_TRACK_CELLS.has(trackCell)) {
      const opponent = other(player);
      const victim = tokens[opponent].findIndex((value) => value >= 0 && value < TRACK_LENGTH && (value + STARTS[opponent]) % TRACK_LENGTH === trackCell);
      if (victim >= 0) { tokens[opponent][victim] = -1; captured = { player: opponent, token: victim }; }
    }
  }
  const winner = tokens[player].every((value) => value === HOME) ? player : null;
  const lastEvent: LudoEvent = winner !== null ? 'win' : position === HOME ? 'home' : captured ? 'capture' : 'move';
  return {
    ...state,
    tokens,
    turn: winner !== null || state.dice === 6 ? player : other(player),
    dice: null,
    consecutiveSixes: winner !== null || state.dice === 6 ? state.consecutiveSixes : 0,
    winner,
    lastEvent,
    lastMove: { player, token, ...(captured ? { captured } : {}) },
  };
}

export function botLudoToken(state: LudoState): number | null {
  const actions = legalLudoActions(state);
  if (!actions.length || state.turn !== 1) return null;
  return actions.map((token) => {
    const next = moveLudo(state, token);
    const score = next.winner === 1 ? 10_000 : next.lastEvent === 'capture' ? 400 : next.lastEvent === 'home' ? 200 : state.tokens[1][token] === -1 ? 80 : (next.tokens[1][token] - state.tokens[1][token]) * 3;
    return { token, score };
  }).sort((a, b) => b.score - a.score)[0].token;
}

export function viewLudo(state: LudoState): LudoState {
  return { ...state, tokens: [state.tokens[0].slice(), state.tokens[1].slice()], lastMove: state.lastMove ? { ...state.lastMove, ...(state.lastMove.captured ? { captured: { ...state.lastMove.captured } } : {}) } : null };
}

function other(player: LudoPlayer): LudoPlayer { return player === 0 ? 1 : 0; }
