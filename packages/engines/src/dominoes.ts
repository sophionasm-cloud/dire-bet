export type Tile = readonly [number, number];
export type DominoEnd = 'left' | 'right';
export type DominoAction = { type: 'place'; tile: number; end: DominoEnd; flip: boolean } | { type: 'draw' } | { type: 'pass' };
export type DominoStatus = 'playing' | 'between-rounds' | 'finished';
export type DominoesState = {
  hands: [Tile[], Tile[]];
  chain: Tile[];
  boneyard: Tile[];
  scores: [number, number];
  round: number;
  dealer: 0 | 1;
  turn: 0 | 1;
  passes: number;
  target: number;
  status: DominoStatus;
  roundWinner: 0 | 1 | null;
  winner: 0 | 1 | null;
  lastAction: 'placed' | 'drew' | 'passed' | 'blocked' | null;
};

export function newDominoesGame(random = Math.random, target = 100): DominoesState {
  return dealRound({ scores: [0, 0], round: 0, dealer: 0, target }, random);
}

export function nextDominoesRound(state: DominoesState, random = Math.random): DominoesState {
  if (state.status !== 'between-rounds') throw new Error('Round is not complete');
  return dealRound({ scores: state.scores.slice() as [number, number], round: state.round, dealer: other(state.dealer), target: state.target }, random);
}

export function legalDominoActions(state: DominoesState): DominoAction[] {
  if (state.status !== 'playing') return [];
  const actions: DominoAction[] = [];
  state.hands[state.turn].forEach((tile, index) => {
    if (!state.chain.length) {
      actions.push({ type: 'place', tile: index, end: 'right', flip: false });
      return;
    }
    const left = state.chain[0][0];
    const right = state.chain[state.chain.length - 1][1];
    if (tile[0] === left) actions.push({ type: 'place', tile: index, end: 'left', flip: false });
    if (tile[1] === left && tile[0] !== tile[1]) actions.push({ type: 'place', tile: index, end: 'left', flip: true });
    if (tile[0] === right) actions.push({ type: 'place', tile: index, end: 'right', flip: false });
    if (tile[1] === right && tile[0] !== tile[1]) actions.push({ type: 'place', tile: index, end: 'right', flip: true });
  });
  if (!actions.length) actions.push(state.boneyard.length ? { type: 'draw' } : { type: 'pass' });
  return actions;
}

export function applyDominoAction(state: DominoesState, action: DominoAction): DominoesState {
  const valid = legalDominoActions(state).some((candidate) => candidate.type === action.type && (candidate.type !== 'place' || (action.type === 'place' && candidate.tile === action.tile && candidate.end === action.end && candidate.flip === action.flip)));
  if (!valid) throw new Error('Illegal domino action');
  if (action.type === 'draw') {
    const hands: [Tile[], Tile[]] = [state.hands[0].slice(), state.hands[1].slice()];
    const tile = state.boneyard[0];
    hands[state.turn].push(tile);
    return { ...state, hands, boneyard: state.boneyard.slice(1), passes: 0, lastAction: 'drew' };
  }
  if (action.type === 'pass') return finishTurn({ ...state, passes: state.passes + 1, lastAction: 'passed' });

  const hands: [Tile[], Tile[]] = [state.hands[0].slice(), state.hands[1].slice()];
  const [a, b] = hands[state.turn].splice(action.tile, 1)[0];
  const tile: Tile = action.flip ? [b, a] : [a, b];
  const chain = state.chain.slice();
  if (action.end === 'left') chain.unshift(tile);
  else chain.push(tile);
  const next = { ...state, hands, chain, passes: 0, lastAction: 'placed' as const };
  if (!hands[state.turn].length) return finishRound(next, state.turn, false);
  return finishTurn(next);
}

export function botDominoAction(state: DominoesState): DominoAction | null {
  if (state.turn !== 1 || state.status !== 'playing') return null;
  const actions = legalDominoActions(state);
  const placement = actions.filter((action): action is Extract<DominoAction, { type: 'place' }> => action.type === 'place');
  if (placement.length) return placement.sort((a, b) => pipValue(state.hands[1][b.tile]) - pipValue(state.hands[1][a.tile]))[0];
  return actions[0] || null;
}

export function viewDominoes(state: DominoesState, player: 0 | 1): Omit<DominoesState, 'hands'> & { hands: [Tile[] | number, Tile[] | number] } {
  return { ...state, hands: state.hands.map((hand, index) => index === player ? hand.map((tile) => [...tile] as Tile) : hand.length) as [Tile[] | number, Tile[] | number] };
}

function dealRound(input: { scores: [number, number]; round: number; dealer: 0 | 1; target: number }, random: () => number): DominoesState {
  const deck: Tile[] = [];
  for (let left = 0; left <= 6; left++) for (let right = left; right <= 6; right++) deck.push([left, right]);
  for (let index = deck.length - 1; index > 0; index--) {
    const selected = Math.floor(random() * (index + 1));
    [deck[index], deck[selected]] = [deck[selected], deck[index]];
  }
  const first = deck.splice(0, 7);
  const second = deck.splice(0, 7);
  return { hands: [first, second], chain: [], boneyard: deck, scores: input.scores, round: input.round + 1, dealer: input.dealer, turn: input.dealer, passes: 0, target: input.target, status: 'playing', roundWinner: null, winner: null, lastAction: null };
}

function finishTurn(state: DominoesState): DominoesState {
  if (state.passes >= 2) {
    const first = state.hands[0].reduce((sum, tile) => sum + pipValue(tile), 0);
    const second = state.hands[1].reduce((sum, tile) => sum + pipValue(tile), 0);
    if (first === second) return { ...state, status: 'between-rounds', roundWinner: null, lastAction: 'blocked' };
    return finishRound(state, first < second ? 0 : 1, true);
  }
  return { ...state, turn: other(state.turn) };
}

function finishRound(state: DominoesState, player: 0 | 1, blocked: boolean): DominoesState {
  const points = blocked ? state.hands[other(player)].reduce((sum, tile) => sum + pipValue(tile), 0) : state.hands[other(player)].reduce((sum, tile) => sum + pipValue(tile), 0);
  const scores = state.scores.slice() as [number, number];
  scores[player] += points;
  return { ...state, scores, status: scores[player] >= state.target ? 'finished' : 'between-rounds', roundWinner: player, winner: scores[player] >= state.target ? player : null, lastAction: blocked ? 'blocked' : state.lastAction };
}

function pipValue(tile: Tile): number { return tile[0] + tile[1]; }
function other(player: 0 | 1): 0 | 1 { return player === 0 ? 1 : 0; }
