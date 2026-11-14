import { describe, expect, it } from 'vitest';
import { applyXO, botMove, initXO, isOver, legalActions, winnerOf, winningLine, type XOState } from './xo';

describe('XO rules', () => {
  it('rejects out-of-turn, occupied and out-of-range actions', () => {
    const state = initXO();
    expect(() => applyXO(state, 'O', 0)).toThrow('Illegal move');
    const after = applyXO(state, 'X', 0);
    expect(() => applyXO(after, 'O', 0)).toThrow('Illegal move');
    expect(() => applyXO(after, 'O', 9)).toThrow('Illegal move');
  });

  it('detects a completed line and stops accepting actions', () => {
    let state = initXO();
    state = applyXO(state, 'X', 0);
    state = applyXO(state, 'O', 3);
    state = applyXO(state, 'X', 1);
    state = applyXO(state, 'O', 4);
    state = applyXO(state, 'X', 2);
    expect(state.winner).toBe('X');
    expect(winningLine(state.board)).toEqual([0, 1, 2]);
    expect(isOver(state)).toBe(true);
    expect(legalActions(state)).toEqual([]);
  });

  it('draws when all squares are full without a winning line', () => {
    const board = ['X','O','X','X','O','O','O','X','X'] as XOState['board'];
    expect(winnerOf(board)).toBe('draw');
  });

  it('hard bot never loses against any legal player sequence', () => {
    const search = (state: XOState): boolean => {
      if (state.winner) return state.winner !== 'X';
      if (state.turn === 'O') {
        const move = botMove(state, 'hard', () => 0);
        return move !== null && search(applyXO(state, 'O', move));
      }
      return legalActions(state).every((move) => search(applyXO(state, 'X', move)));
    };
    expect(search(initXO())).toBe(true);
  });
});
