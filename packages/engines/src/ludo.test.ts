import { describe, expect, it } from 'vitest';
import { initLudo, legalLudoActions, moveLudo, rollLudo } from './ludo';

describe('Ludo rules', () => {
  it('requires a six to leave base and grants an extra roll', () => {
    const failed = rollLudo(initLudo(), 4);
    expect(failed.turn).toBe(1);
    expect(failed.dice).toBeNull();
    expect(failed.lastDice).toBe(4);
    expect(failed.rollVersion).toBe(1);
    const six = rollLudo(initLudo(), 6);
    expect(legalLudoActions(six)).toEqual([0, 1, 2, 3]);
    const moved = moveLudo(six, 0);
    expect(moved.tokens[0][0]).toBe(0);
    expect(moved.turn).toBe(0);
    expect(moved.consecutiveSixes).toBe(1);
  });

  it('forfeits the turn after three sixes in a row', () => {
    const first = rollLudo(initLudo(), 6);
    const second = rollLudo(moveLudo(first, 0), 6);
    const third = rollLudo(moveLudo(second, 1), 6);
    expect(third.turn).toBe(1);
    expect(third.dice).toBeNull();
    expect(third.consecutiveSixes).toBe(0);
    expect(third.lastEvent).toBe('triple-six');
    expect(third.lastDice).toBe(6);
  });

  it('captures an opponent off a non-safe track cell', () => {
    const state = { ...initLudo(), tokens: [[1, -1, -1, -1], [28, -1, -1, -1]] as [number[], number[]], dice: 1 };
    const moved = moveLudo(state, 0);
    expect(moved.tokens[1][0]).toBe(-1);
    expect(moved.lastEvent).toBe('capture');
  });

  it('requires an exact roll to enter home', () => {
    const state = { ...initLudo(), tokens: [[56, -1, -1, -1], [-1, -1, -1, -1]] as [number[], number[]], dice: 2 };
    expect(legalLudoActions(state)).toEqual([]);
    expect(() => moveLudo(state, 0)).toThrow('Illegal move');
  });

  it.each([1, 2, 4] as const)('ends at the selected %i-crown target', (target) => {
    const tokens: [number[], number[]] = [[...Array(target - 1).fill(57), 56, ...Array(4 - target).fill(-1)], [-1, -1, -1, -1]];
    expect(moveLudo({ ...initLudo(0, target), tokens, dice: 1 }, target - 1).winner).toBe(0);
  });

  it.each([2, 4] as const)('does not end before the selected %i-crown target', (target) => {
    const finished = target - 2;
    const tokens: [number[], number[]] = [[...Array(finished).fill(57), 56, ...Array(3 - finished).fill(-1)], [-1, -1, -1, -1]];
    expect(moveLudo({ ...initLudo(0, target), tokens, dice: 1 }, finished).winner).toBeNull();
  });
});
