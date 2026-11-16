import { describe, expect, it } from 'vitest';
import { applyDominoAction, legalDominoActions, type DominoesState } from './dominoes';

function state(overrides: Partial<DominoesState> = {}): DominoesState {
  return {
    hands: [[[1, 4], [5, 6]], [[2, 3]]], chain: [[1, 2]], boneyard: [], scores: [0, 0], round: 1,
    dealer: 0, turn: 0, passes: 0, target: 100, status: 'playing', roundWinner: null, winner: null, lastAction: null, ...overrides,
  };
}

describe('Dominoes rules', () => {
  it('offers both ends and flips a tile to match the left end', () => {
    const start = state();
    const left = legalDominoActions(start).find((action) => action.type === 'place' && action.tile === 0 && action.end === 'left');
    expect(left).toEqual({ type: 'place', tile: 0, end: 'left', flip: false });
    const placed = applyDominoAction(start, left!);
    expect(placed.chain).toEqual([[1, 4], [1, 2]]);
    expect(placed.turn).toBe(1);
  });

  it('draws when blocked and passes only when the boneyard is empty', () => {
    const withDraw = state({ hands: [[[5, 5]], [[2, 4]]], boneyard: [[1, 4]] });
    expect(legalDominoActions(withDraw)).toEqual([{ type: 'draw' }]);
    const drawn = applyDominoAction(withDraw, { type: 'draw' });
    expect(drawn.hands[0]).toHaveLength(2);
    expect(drawn.turn).toBe(0);
    const blocked = state({ hands: [[[5, 5]], [[2, 4]]], boneyard: [] });
    expect(legalDominoActions(blocked)).toEqual([{ type: 'pass' }]);
  });

  it('awards remaining pips and ends the match at the target score', () => {
    const start = state({ hands: [[[6, 6]], [[1, 2]]], chain: [], target: 3 });
    const end = applyDominoAction(start, { type: 'place', tile: 0, end: 'right', flip: false });
    expect(end.scores).toEqual([3, 0]);
    expect(end.roundWinner).toBe(0);
    expect(end.winner).toBe(0);
    expect(end.status).toBe('finished');
  });
});
