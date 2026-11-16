import { describe, expect, it } from 'vitest';
import { applyPokerAction, bestHand, compareHands, initTexasHoldem, viewPoker, type Card, type HandValue } from './poker';

const card = (rank: number, suit: Card['suit'] = 'clubs'): Card => ({ rank, suit });

describe('Texas Hold’em rules', () => {
  it('ranks straight flush, quads, full house and wheel straight correctly', () => {
    const straightFlush = bestHand([card(14, 'hearts'), card(13, 'hearts'), card(12, 'hearts'), card(11, 'hearts'), card(10, 'hearts'), card(2), card(3)]);
    const quads = bestHand([card(9), card(9, 'hearts'), card(9, 'diamonds'), card(9, 'spades'), card(14), card(2, 'hearts'), card(3, 'hearts')]);
    const fullHouse = bestHand([card(8), card(8, 'hearts'), card(8, 'spades'), card(3), card(3, 'hearts'), card(14), card(2)]);
    const wheel = bestHand([card(14), card(2, 'hearts'), card(3, 'spades'), card(4, 'diamonds'), card(5, 'clubs'), card(9), card(10)]);
    expect(straightFlush.category).toBe(8);
    expect(quads.category).toBe(7);
    expect(fullHouse).toEqual({ category: 6, kickers: [8, 3] });
    expect(wheel).toEqual({ category: 4, kickers: [5] });
  });

  it('compares kickers and hides the opponent hole cards from a player view', () => {
    const pairA: HandValue = { category: 1, kickers: [10, 14, 8, 5] };
    const pairB: HandValue = { category: 1, kickers: [10, 13, 8, 5] };
    expect(compareHands(pairA, pairB)).toBeGreaterThan(0);
    const view = viewPoker(initTexasHoldem(() => 0.5), 0);
    expect(view.players[0].hole).toHaveLength(2);
    expect(view.players[1].hole).toBeNull();
  });

  it('posts blinds, advances a checked hand and awards a fold', () => {
    const opening = initTexasHoldem(() => 0.5);
    expect(opening.pot).toBe(15);
    expect(opening.currentBet).toBe(10);
    const call = applyPokerAction(opening, 0, { type: 'call' });
    const check = applyPokerAction(call, 1, { type: 'check' });
    expect(check.street).toBe('flop');
    expect(check.board).toHaveLength(3);
    const folded = applyPokerAction(check, 0, { type: 'fold' });
    expect(folded.street).toBe('folded');
    expect(folded.winner).toBe(1);
    expect(folded.pot).toBe(0);
    expect(viewPoker(folded, 0).players[1].hole).toBeNull();
  });

  it('runs an all-in hand to showdown', () => {
    const opening = initTexasHoldem(() => 0.25, [20, 10]);
    const called = applyPokerAction(opening, 0, { type: 'call' });
    const result = applyPokerAction(called, 1, { type: 'check' });
    expect(result.street).toBe('showdown');
    expect(result.board).toHaveLength(5);
    expect(result.winner).not.toBeNull();
    expect(result.players[0].stack + result.players[1].stack).toBe(30);
    expect(viewPoker(result, 0).players[1].hole).toHaveLength(2);
  });
});
