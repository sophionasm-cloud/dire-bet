import { describe, expect, it } from 'vitest';
import { applyCheckerMove, legalCheckerMoves, newCheckersGame, type CheckersBoard, type CheckersState } from './checkers';

function state(board: CheckersBoard, turn: 0 | 1): CheckersState {
  return { board, turn, chain: null, winner: null, lastMove: null, moveCount: 0 };
}

function emptyBoard(): CheckersBoard {
  return Array.from({ length: 64 }, () => null);
}

describe('American checkers rules', () => {
  it('starts with twelve pieces each and dark moves first', () => {
    const game = newCheckersGame();
    expect(game.turn).toBe(1);
    expect(game.board.filter((piece) => piece?.player === 0)).toHaveLength(12);
    expect(game.board.filter((piece) => piece?.player === 1)).toHaveLength(12);
    expect(legalCheckerMoves(game)).toHaveLength(7);
  });

  it('moves regular pieces diagonally forward only', () => {
    const board = emptyBoard();
    board[17] = { player: 1, king: false };
    board[40] = { player: 0, king: false };
    const game = state(board, 1);
    expect(legalCheckerMoves(game).map((move) => move.to).sort()).toEqual([24, 26]);
    expect(() => applyCheckerMove(game, 17, 8)).toThrow('Illegal checker move');
    const next = applyCheckerMove(game, 17, 26);
    expect(next.board[17]).toBeNull();
    expect(next.board[26]).toEqual({ player: 1, king: false });
    expect(next.turn).toBe(0);
  });

  it('makes captures mandatory and removes the jumped piece', () => {
    const board = emptyBoard();
    board[17] = { player: 1, king: false };
    board[26] = { player: 0, king: false };
    board[60] = { player: 0, king: false };
    const game = state(board, 1);
    const moves = legalCheckerMoves(game);
    expect(moves).toEqual([{ from: 17, to: 35, captured: 26 }]);
    expect(() => applyCheckerMove(game, 17, 24)).toThrow('Illegal checker move');
    const next = applyCheckerMove(game, 17, 35);
    expect(next.board[26]).toBeNull();
    expect(next.board[35]).toEqual({ player: 1, king: false });
    expect(next.turn).toBe(0);
  });

  it('keeps the turn with a piece that can continue a multi-jump', () => {
    const board = emptyBoard();
    board[17] = { player: 1, king: false };
    board[26] = { player: 0, king: false };
    board[44] = { player: 0, king: false };
    board[60] = { player: 0, king: false };
    const game = state(board, 1);
    const first = applyCheckerMove(game, 17, 35);
    expect(first.chain).toBe(35);
    expect(first.turn).toBe(1);
    expect(legalCheckerMoves(first)).toEqual([{ from: 35, to: 53, captured: 44 }]);
    const second = applyCheckerMove(first, 35, 53);
    expect(second.board[44]).toBeNull();
    expect(second.chain).toBeNull();
    expect(second.turn).toBe(0);
  });

  it('promotes on the far row and lets kings move and capture backwards', () => {
    const board = emptyBoard();
    board[49] = { player: 1, king: false };
    board[40] = { player: 0, king: false };
    const promoted = applyCheckerMove(state(board, 1), 49, 58);
    expect(promoted.board[58]).toEqual({ player: 1, king: true });
    expect(promoted.lastMove?.promoted).toBe(true);

    const kingBoard = emptyBoard();
    kingBoard[35] = { player: 0, king: true };
    kingBoard[5] = { player: 1, king: false };
    const king = state(kingBoard, 0);
    expect(legalCheckerMoves(king)).toContainEqual({ from: 35, to: 42, captured: null });
    expect(legalCheckerMoves(king)).toContainEqual({ from: 35, to: 26, captured: null });

    const captureBoard = emptyBoard();
    captureBoard[35] = { player: 0, king: true };
    captureBoard[44] = { player: 1, king: false };
    captureBoard[5] = { player: 1, king: false };
    const capture = state(captureBoard, 0);
    expect(legalCheckerMoves(capture)).toEqual([{ from: 35, to: 53, captured: 44 }]);
    const captured = applyCheckerMove(capture, 35, 53);
    expect(captured.board[44]).toBeNull();
    expect(captured.board[53]).toEqual({ player: 0, king: true });
  });

  it('ends the move when a capture reaches the king row', () => {
    const board = emptyBoard();
    board[44] = { player: 1, king: false };
    board[51] = { player: 0, king: false };
    board[49] = { player: 0, king: false };
    const next = applyCheckerMove(state(board, 1), 44, 58);
    expect(next.board[58]).toEqual({ player: 1, king: true });
    expect(next.chain).toBeNull();
    expect(next.turn).toBe(0);
    expect(legalCheckerMoves(next).every((move) => move.from !== 58)).toBe(true);
  });

  it('wins when the opponent has no pieces or no legal moves', () => {
    const captureBoard = emptyBoard();
    captureBoard[17] = { player: 1, king: false };
    captureBoard[26] = { player: 0, king: false };
    expect(applyCheckerMove(state(captureBoard, 1), 17, 35).winner).toBe(1);

    const blockedBoard = emptyBoard();
    blockedBoard[17] = { player: 1, king: false };
    blockedBoard[0] = { player: 0, king: false };
    const blocked = applyCheckerMove(state(blockedBoard, 1), 17, 24);
    expect(blocked.winner).toBe(1);
    expect(blocked.turn).toBe(0);
    expect(legalCheckerMoves(blocked)).toEqual([]);
  });
});
