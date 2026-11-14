export type Mark = 'X' | 'O';
export type Cell = Mark | null;
export type XOState = { board: Cell[]; turn: Mark; winner: Mark | 'draw' | null };

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
] as const;

export function initXO(first: Mark = 'X'): XOState {
  return { board: Array<Cell>(9).fill(null), turn: first, winner: null };
}

export function winnerOf(board: Cell[]): Mark | 'draw' | null {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  }
  return board.every(Boolean) ? 'draw' : null;
}

export function winningLine(board: Cell[]): number[] {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) return [a, b, c];
  }
  return [];
}

export function legalActions(state: XOState): number[] {
  return state.winner ? [] : state.board.flatMap((cell, index) => cell ? [] : [index]);
}

export function applyXO(state: XOState, player: Mark, action: number): XOState {
  if (state.winner || player !== state.turn || !Number.isInteger(action) || action < 0 || action > 8 || state.board[action]) {
    throw new Error('Illegal move');
  }
  const board = [...state.board];
  board[action] = player;
  return { board, turn: player === 'X' ? 'O' : 'X', winner: winnerOf(board) };
}

function score(board: Cell[], depth: number): number {
  const result = winnerOf(board);
  if (result === 'O') return 10 - depth;
  if (result === 'X') return depth - 10;
  if (result === 'draw') return 0;
  return 0;
}

function minimax(board: Cell[], maximizing: boolean, depth: number): number {
  const result = winnerOf(board);
  if (result) return score(board, depth);
  let best = maximizing ? -Infinity : Infinity;
  for (const index of board.flatMap((cell, i) => cell ? [] : [i])) {
    board[index] = maximizing ? 'O' : 'X';
    const next = minimax(board, !maximizing, depth + 1);
    board[index] = null;
    best = maximizing ? Math.max(best, next) : Math.min(best, next);
  }
  return best;
}

export function botMove(state: XOState, difficulty: 'easy' | 'hard' = 'hard', random = Math.random): number | null {
  const actions = legalActions(state);
  if (!actions.length) return null;
  if (difficulty === 'easy') return actions[Math.floor(random() * actions.length)];
  let best = -Infinity;
  let choices: number[] = [];
  for (const index of actions) {
    const board = [...state.board];
    board[index] = 'O';
    const value = minimax(board, false, 0);
    if (value > best) { best = value; choices = [index]; }
    else if (value === best) choices.push(index);
  }
  return choices[Math.floor(random() * choices.length)];
}

export function result(state: XOState): Mark | 'draw' | null { return state.winner; }

export function isOver(state: XOState): boolean { return state.winner !== null; }

export function view(state: XOState): XOState {
  return { board: [...state.board], turn: state.turn, winner: state.winner };
}
