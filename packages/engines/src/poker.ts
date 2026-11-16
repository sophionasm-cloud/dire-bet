export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';
export type Card = { rank: number; suit: Suit };
export type PokerPlayer = { hole: Card[]; stack: number; invested: number };
export type PokerStreet = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'folded';
export type PokerAction = { type: 'fold' } | { type: 'check' } | { type: 'call' } | { type: 'all-in' } | { type: 'raise'; to: number };
export type HandValue = { category: number; kickers: number[] };
export type PokerState = {
  players: [PokerPlayer, PokerPlayer];
  board: Card[];
  deck: Card[];
  button: 0 | 1;
  street: PokerStreet;
  turn: 0 | 1 | null;
  bets: [number, number];
  currentBet: number;
  minRaise: number;
  acted: [boolean, boolean];
  pot: number;
  resultPot: number;
  winner: 0 | 1 | 'split' | null;
  handValues: [HandValue | null, HandValue | null];
  lastAction: string;
};

const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const SMALL_BLIND = 5;
const BIG_BLIND = 10;

export function initTexasHoldem(random = Math.random, stacks: [number, number] = [1000, 1000], button: 0 | 1 = 0): PokerState {
  if (stacks.some((stack) => !Number.isInteger(stack) || stack < BIG_BLIND)) throw new Error('Each practice stack must cover the big blind');
  const deck: Card[] = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  for (let index = deck.length - 1; index > 0; index--) {
    const selected = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    [deck[index], deck[selected]] = [deck[selected], deck[index]];
  }
  const players: [PokerPlayer, PokerPlayer] = [{ hole: [], stack: stacks[0], invested: 0 }, { hole: [], stack: stacks[1], invested: 0 }];
  for (let deal = 0; deal < 2; deal++) for (const seat of [button, other(button)] as const) players[seat].hole.push(deck.pop()!);
  const bets: [number, number] = [0, 0];
  const pot = commit(players, bets, button, Math.min(SMALL_BLIND, players[button].stack))
    + commit(players, bets, other(button), Math.min(BIG_BLIND, players[other(button)].stack));
  return { players, board: [], deck, button, street: 'preflop', turn: button, bets, currentBet: Math.max(...bets), minRaise: BIG_BLIND, acted: [false, false], pot, resultPot: 0, winner: null, handValues: [null, null], lastAction: 'blinds posted' };
}

export function legalPokerActions(state: PokerState, player = state.turn): PokerAction[] {
  if (state.street === 'showdown' || state.street === 'folded' || player === null || player !== state.turn) return [];
  const actions: PokerAction[] = [{ type: 'fold' }];
  const toCall = state.currentBet - state.bets[player];
  if (toCall === 0) actions.push({ type: 'check' });
  else actions.push({ type: 'call' });
  const allInTo = state.bets[player] + state.players[player].stack;
  if (allInTo > state.currentBet) {
    if (allInTo >= state.currentBet + state.minRaise) actions.push({ type: 'raise', to: state.currentBet + state.minRaise });
    actions.push({ type: 'all-in' });
  }
  return actions;
}

export function applyPokerAction(state: PokerState, player: 0 | 1, action: PokerAction): PokerState {
  const legal = legalPokerActions(state, player);
  const valid = action.type === 'raise'
    ? legal.some((candidate) => candidate.type === 'raise' && candidate.to === action.to)
    : legal.some((candidate) => candidate.type === action.type);
  if (state.turn !== player || !valid) throw new Error('Illegal poker action');
  if (action.type === 'fold') return awardFold(state, player);
  const players: [PokerPlayer, PokerPlayer] = [clonePlayer(state.players[0]), clonePlayer(state.players[1])];
  const bets: [number, number] = state.bets.slice() as [number, number];
  let acted: [boolean, boolean] = state.acted.slice() as [boolean, boolean];
  let pot = state.pot;
  let currentBet = state.currentBet;
  let minRaise = state.minRaise;
  let lastAction: string = action.type;

  if (action.type === 'check') {
    if (state.currentBet !== state.bets[player]) throw new Error('Cannot check while facing a bet');
    acted[player] = true;
  } else if (action.type === 'call') {
    const amount = Math.min(state.currentBet - bets[player], players[player].stack);
    pot += commit(players, bets, player, amount);
    acted[player] = true;
    lastAction = amount < state.currentBet - state.bets[player] ? 'called all-in' : 'called';
  } else {
    const target = action.type === 'all-in' ? bets[player] + players[player].stack : action.to;
    if (target <= currentBet || target > bets[player] + players[player].stack) throw new Error('Illegal raise size');
    const raiseSize = target - currentBet;
    pot += commit(players, bets, player, target - bets[player]);
    currentBet = target;
    if (raiseSize >= minRaise) minRaise = raiseSize;
    acted = [false, false];
    acted[player] = true;
    lastAction = action.type === 'all-in' ? 'went all-in' : 'raised';
  }

  const next: PokerState = { ...state, players, bets, currentBet, minRaise, acted, pot, lastAction, turn: other(player) };
  if (acted[0] && acted[1] && bets[0] === bets[1]) return advanceStreet(next);
  if (players[0].stack === 0 && players[1].stack === 0) return runout(next);
  return next;
}

export function botPokerAction(state: PokerState, random = Math.random): PokerAction | null {
  if (state.turn !== 1 || state.street === 'showdown' || state.street === 'folded') return null;
  const callAmount = state.currentBet - state.bets[1];
  if (callAmount === 0) {
    if (state.players[1].stack > state.minRaise && random() < 0.16) return { type: 'raise', to: state.currentBet + state.minRaise };
    return { type: 'check' };
  }
  if (callAmount <= state.players[1].stack && random() < 0.08) return { type: 'fold' };
  return { type: 'call' };
}

export function evaluateHand(cards: Card[]): HandValue {
  if (cards.length < 5) throw new Error('At least five cards are required');
  const values = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flushSuit = SUITS.find((suit) => cards.filter((card) => card.suit === suit).length >= 5);
  const flushValues = flushSuit ? cards.filter((card) => card.suit === flushSuit).map((card) => card.rank).sort((a, b) => b - a).slice(0, 5) : [];
  const straightFlush = flushSuit ? straightHigh(cards.filter((card) => card.suit === flushSuit).map((card) => card.rank)) : 0;
  if (straightFlush) return { category: 8, kickers: [straightFlush] };
  if (groups[0][1] === 4) return { category: 7, kickers: [groups[0][0], ...values.filter((rank) => rank !== groups[0][0]).slice(0, 1)] };
  if (groups[0][1] === 3 && groups.slice(1).some((group) => group[1] >= 2)) return { category: 6, kickers: [groups[0][0], groups.slice(1).find((group) => group[1] >= 2)![0]] };
  if (flushSuit) return { category: 5, kickers: flushValues };
  const straight = straightHigh(values);
  if (straight) return { category: 4, kickers: [straight] };
  if (groups[0][1] === 3) return { category: 3, kickers: [groups[0][0], ...groups.slice(1).map((group) => group[0]).sort((a, b) => b - a).slice(0, 2)] };
  const pairs = groups.filter((group) => group[1] === 2).map((group) => group[0]).sort((a, b) => b - a);
  if (pairs.length >= 2) return { category: 2, kickers: [pairs[0], pairs[1], ...values.filter((rank) => rank !== pairs[0] && rank !== pairs[1]).slice(0, 1)] };
  if (pairs.length === 1) return { category: 1, kickers: [pairs[0], ...values.filter((rank) => rank !== pairs[0]).slice(0, 3)] };
  return { category: 0, kickers: values.slice(0, 5) };
}

export function bestHand(cards: Card[]): HandValue {
  if (cards.length < 5) throw new Error('At least five cards are required');
  let best: HandValue | null = null;
  for (let a = 0; a < cards.length - 4; a++) for (let b = a + 1; b < cards.length - 3; b++) for (let c = b + 1; c < cards.length - 2; c++) for (let d = c + 1; d < cards.length - 1; d++) for (let e = d + 1; e < cards.length; e++) {
    const value = evaluateHand([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (!best || compareHands(value, best) > 0) best = value;
  }
  return best!;
}

export function compareHands(left: HandValue, right: HandValue): number {
  if (left.category !== right.category) return left.category - right.category;
  const length = Math.max(left.kickers.length, right.kickers.length);
  for (let index = 0; index < length; index++) {
    const difference = (left.kickers[index] || 0) - (right.kickers[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

export function viewPoker(state: PokerState, player: 0 | 1): Omit<PokerState, 'deck' | 'players'> & { players: [{ stack: number; hole: Card[] | null }, { stack: number; hole: Card[] | null }] } {
  const { deck: _deck, players: _players, ...publicState } = state;
  return { ...publicState, players: state.players.map((seat, index) => ({ stack: seat.stack, hole: index === player || state.street === 'showdown' ? seat.hole.map((card) => ({ ...card })) : null })) as [{ stack: number; hole: Card[] | null }, { stack: number; hole: Card[] | null }] };
}

function advanceStreet(state: PokerState): PokerState {
  if (state.street === 'river') return settleShowdown(refundUncalled(state));
  const deck = state.deck.slice();
  deck.pop();
  const board = state.board.slice();
  const street: PokerStreet = state.street === 'preflop' ? 'flop' : state.street === 'flop' ? 'turn' : 'river';
  const draw = street === 'flop' ? 3 : 1;
  for (let index = 0; index < draw; index++) board.push(deck.pop()!);
  const next: PokerState = { ...state, deck, board, street, bets: [0, 0], currentBet: 0, minRaise: BIG_BLIND, acted: [false, false], turn: state.button, lastAction: `dealt ${street}` };
  if (next.players[0].stack === 0 || next.players[1].stack === 0) return runout(next);
  return next;
}

function runout(state: PokerState): PokerState {
  let current = { ...state, board: state.board.slice(), deck: state.deck.slice() };
  while (current.board.length < 5) {
    current.deck.pop();
    current.board.push(current.deck.pop()!);
  }
  return settleShowdown(refundUncalled({ ...current, street: 'river', turn: null, bets: [0, 0], currentBet: 0, acted: [false, false], lastAction: 'all-in runout' }));
}

function settleShowdown(state: PokerState): PokerState {
  const handValues: [HandValue, HandValue] = [bestHand([...state.players[0].hole, ...state.board]), bestHand([...state.players[1].hole, ...state.board])];
  const comparison = compareHands(handValues[0], handValues[1]);
  const winner: 0 | 1 | 'split' = comparison > 0 ? 0 : comparison < 0 ? 1 : 'split';
  const players: [PokerPlayer, PokerPlayer] = [clonePlayer(state.players[0]), clonePlayer(state.players[1])];
  if (winner === 'split') { players[0].stack += Math.floor(state.pot / 2); players[1].stack += Math.ceil(state.pot / 2); }
  else players[winner].stack += state.pot;
  return { ...state, players, pot: 0, resultPot: state.pot, winner, handValues, street: 'showdown', turn: null, lastAction: winner === 'split' ? 'split pot' : `player ${winner + 1} wins` };
}

function awardFold(state: PokerState, folder: 0 | 1): PokerState {
  const winner = other(folder);
  const refunded = refundUncalled(state);
  const players: [PokerPlayer, PokerPlayer] = [clonePlayer(refunded.players[0]), clonePlayer(refunded.players[1])];
  players[winner].stack += refunded.pot;
  return { ...refunded, players, pot: 0, resultPot: refunded.pot, winner, street: 'folded', turn: null, lastAction: `player ${folder + 1} folded` };
}

function refundUncalled(state: PokerState): PokerState {
  const [first, second] = state.players.map((player) => player.invested) as [number, number];
  if (first === second) return state;
  const players: [PokerPlayer, PokerPlayer] = [clonePlayer(state.players[0]), clonePlayer(state.players[1])];
  const unmatched: 0 | 1 = first > second ? 0 : 1;
  const amount = Math.abs(first - second);
  players[unmatched].stack += amount;
  players[unmatched].invested -= amount;
  return { ...state, players, pot: state.pot - amount };
}

function commit(players: [PokerPlayer, PokerPlayer], bets: [number, number], player: 0 | 1, amount: number): number {
  const chips = Math.max(0, Math.min(amount, players[player].stack));
  players[player].stack -= chips;
  players[player].invested += chips;
  bets[player] += chips;
  return chips;
}

function clonePlayer(player: PokerPlayer): PokerPlayer { return { hole: player.hole.map((card) => ({ ...card })), stack: player.stack, invested: player.invested }; }
function other(player: 0 | 1): 0 | 1 { return player === 0 ? 1 : 0; }

function straightHigh(values: number[]): number {
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let index = 0; index <= unique.length - 5; index++) if (unique[index] - unique[index + 4] === 4) return unique[index];
  return 0;
}
