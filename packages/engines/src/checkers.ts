export type CheckerPlayer = 0 | 1;
export type CheckerPiece = { player: CheckerPlayer; king: boolean };
export type CheckersBoard = (CheckerPiece | null)[];
export type CheckerMove = { from: number; to: number; captured: number | null };
export type CheckersState = {
  board: CheckersBoard;
  turn: CheckerPlayer;
  chain: number | null;
  winner: CheckerPlayer | null;
  lastMove: { player: CheckerPlayer; from: number; to: number; captured: number | null; promoted: boolean } | null;
  moveCount: number;
};

const DIRECTIONS = [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const;

/** American checkers: twelve pieces each, dark pieces move first. */
export function newCheckersGame(firstPlayer: CheckerPlayer = 1): CheckersState {
  const board: CheckersBoard = Array.from({ length: 64 }, () => null);
  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      if ((row + column) % 2 !== 1) continue;
      if (row < 3) board[row * 8 + column] = { player: 1, king: false };
      if (row > 4) board[row * 8 + column] = { player: 0, king: false };
    }
  }
  return { board, turn: firstPlayer, chain: null, winner: null, lastMove: null, moveCount: 0 };
}

export function legalCheckerMoves(state: CheckersState): CheckerMove[] {
  if (state.winner !== null) return [];
  const starts = state.chain !== null
    ? [state.chain]
    : state.board.flatMap((piece, index) => piece?.player === state.turn ? [index] : []);
  const captures: CheckerMove[] = [];
  const steps: CheckerMove[] = [];
  for (const from of starts) {
    const piece = state.board[from];
    if (!piece || piece.player !== state.turn) continue;
    const row = Math.floor(from / 8);
    const column = from % 8;
    for (const [dr, dc] of DIRECTIONS) {
      if (!piece.king && (state.turn === 0 ? dr !== -1 : dr !== 1)) continue;
      const middleRow = row + dr;
      const middleColumn = column + dc;
      const targetRow = row + dr * 2;
      const targetColumn = column + dc * 2;
      if (!inside(middleRow, middleColumn)) continue;
      const middle = middleRow * 8 + middleColumn;
      const middlePiece = state.board[middle];
      if (middlePiece && inside(targetRow, targetColumn)) {
        const target = targetRow * 8 + targetColumn;
        if (middlePiece.player === other(state.turn) && !state.board[target]) captures.push({ from, to: target, captured: middle });
      } else if (!middlePiece) {
        steps.push({ from, to: middle, captured: null });
      }
    }
  }
  if (captures.length) return captures;
  return state.chain === null ? steps : [];
}

export function applyCheckerMove(state: CheckersState, from: number, to: number): CheckersState {
  const move = legalCheckerMoves(state).find((candidate) => candidate.from === from && candidate.to === to);
  if (!move) throw new Error('Illegal checker move');
  const piece = state.board[from];
  if (!piece) throw new Error('Illegal checker move');
  const board = state.board.slice();
  board[from] = null;
  if (move.captured !== null) board[move.captured] = null;
  const promoted = !piece.king && (piece.player === 0 ? to < 8 : to >= 56);
  board[to] = promoted ? { ...piece, king: true } : piece;
  const next: CheckersState = {
    ...state,
    board,
    chain: null,
    lastMove: { player: state.turn, from, to, captured: move.captured, promoted },
    moveCount: state.moveCount + 1,
  };
  if (move.captured !== null && !promoted && legalCheckerMoves({ ...next, chain: to }).length) return { ...next, chain: to };
  return finishTurn(next);
}

export function botCheckerMove(state: CheckersState): CheckerMove | null {
  if (state.turn !== 1 || state.winner !== null) return null;
  const moves = legalCheckerMoves(state);
  if (!moves.length) return null;
  const scored = moves.map((move) => {
    const next = applyCheckerMove(state, move.from, move.to);
    const row = Math.floor(move.to / 8);
    const column = move.to % 8;
    let score = 7 - Math.abs(3.5 - row) - Math.abs(3.5 - column);
    if (next.winner === state.turn) score += 10_000;
    if (move.captured !== null) score += 500;
    if (next.lastMove?.promoted) score += 400;
    if (next.chain !== null) score += 200;
    return { move, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0].move;
}

function finishTurn(state: CheckersState): CheckersState {
  const player = state.turn;
  const turn = other(player);
  const next: CheckersState = { ...state, turn, chain: null, winner: null };
  const hasPieces = next.board.some((piece) => piece?.player === turn);
  if (!hasPieces || legalCheckerMoves(next).length === 0) return { ...next, winner: player };
  return next;
}

function inside(row: number, column: number): boolean {
  return row >= 0 && row < 8 && column >= 0 && column < 8;
}

function other(player: CheckerPlayer): CheckerPlayer {
  return player === 0 ? 1 : 0;
}
