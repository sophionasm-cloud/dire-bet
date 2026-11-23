import { describe, expect, it } from 'vitest';
import { legalCheckerMoves, type CheckersState } from '@dire-bet/engines/checkers';
import { GameRoom } from './index';

function createFixture() {
  const records = new Map<string, unknown>();
  const batches: string[][] = [];
  const boundStatements: { sql: string; values: unknown[] }[] = [];
  const storage = {
    get: async <T>(key: string) => records.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { records.set(key, value); },
    setAlarm: async (_time: number) => undefined,
    deleteAlarm: async () => undefined,
  };
  const state = { storage, acceptWebSocket: () => undefined, getWebSockets: () => [] } as unknown as DurableObjectState;
  const db = {
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => { const statement = { sql, values, first: async () => ({ status: 'active', age_eligibility: 'verified' }) }; boundStatements.push(statement); return statement; } }),
    batch: async (statements: { sql: string }[]) => { batches.push(statements.map((statement) => statement.sql)); return []; },
  };
  const room = new GameRoom(state, { DB: db } as never);
  return { room, records, batches, boundStatements };
}

function request(path: string, body: unknown): Request {
  return new Request(`https://room${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function socket(userId: number, sent: string[]) {
  return { deserializeAttachment: () => ({ userId }), send: (message: string) => sent.push(message) } as unknown as WebSocket;
}

describe('authoritative XO room', () => {
  it('rejects out-of-turn moves and records a complete free match', async () => {
    const { room, records, batches } = createFixture();
    const code = 'ABC234';
    await room.fetch(request('/create', { code, gameId: 'xo', userId: 11, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    const joined = await room.fetch(request('/join', { code, userId: 22, displayName: 'Friend' }));
    expect(joined.status).toBe(200);
    let current = records.get('room') as { players: { id: number; mark: 'X'|'O'|null }[]; game: { board: (string|null)[]; turn: 'X'|'O'; winner: string|null }; status: string };
    const x = current.players.find((player) => player.mark === 'X')!.id;
    const o = current.players.find((player) => player.mark === 'O')!.id;
    const messages: string[] = [];
    await room.webSocketMessage(socket(o, messages), JSON.stringify({ type: 'move', index: 0 }));
    current = records.get('room') as typeof current;
    expect(current.game.board.every((cell) => cell === null)).toBe(true);
    expect(messages).toHaveLength(1);

    for (const [userId, index] of [[x, 0], [o, 3], [x, 1], [o, 4], [x, 2]] as const) {
      await room.webSocketMessage(socket(userId, []), JSON.stringify({ type: 'move', index }));
    }
    current = records.get('room') as typeof current;
    expect(current.status).toBe('finished');
    expect(current.game.winner).toBe('X');
    expect(current.game.board).toEqual(['X', 'X', 'X', 'O', 'O', null, null, null, null]);
    expect(batches.some((batch) => batch.some((sql) => sql.includes('INSERT OR IGNORE INTO match_events')))).toBe(true);
    expect(batches.some((batch) => batch.some((sql) => sql.includes("status = 'completed'")))).toBe(true);
  });

  it('uses the Ludo rules in the server room and records server-rolled dice', async () => {
    const { room, records, batches } = createFixture();
    const code = 'DEF345';
    await room.fetch(request('/create', { code, gameId: 'ludo', userId: 31, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    await room.fetch(request('/join', { code, userId: 32, displayName: 'Friend' }));
    let current = records.get('room') as { game: { turn: number; dice: number|null; lastEvent: string|null }; status: string };
    expect(current.status).toBe('active');
    const sent: string[] = [];
    await room.webSocketMessage(socket(32, sent), JSON.stringify({ type: 'roll' }));
    current = records.get('room') as typeof current;
    expect(current.game.dice).toBeNull();
    expect(sent[0]).toContain('Please wait for your turn');
    await room.webSocketMessage(socket(31, []), JSON.stringify({ type: 'roll' }));
    current = records.get('room') as typeof current;
    expect(current.game.lastEvent).not.toBeNull();
    expect(batches.some((batch) => batch.some((sql) => sql.includes('INSERT OR IGNORE INTO match_events')))).toBe(true);
  });

  it('automatically makes a legal Ludo turn when the server deadline expires, exactly once', async () => {
    const { room, records, boundStatements } = createFixture();
    const code = 'TMR345';
    await room.fetch(request('/create', { code, gameId: 'ludo', userId: 81, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    await room.fetch(request('/join', { code, userId: 82, displayName: 'Friend' }));
    const stored = records.get('room') as { turnDeadline?: number; game: { turn: number } };
    expect(stored.turnDeadline).toBeGreaterThan(Date.now());
    expect(stored.game.turn).toBe(0);
    stored.turnDeadline = Date.now() - 1;
    await room.alarm();
    const resumed = records.get('room') as { status: string; terminal?: { winner: number | 'draw'; reason: string }; turnDeadline?: number };
    expect(resumed.status).toBe('active');
    expect(resumed.terminal).toBeUndefined();
    expect(resumed.turnDeadline).toBeGreaterThan(Date.now());
    const autoTurnEvents = () => boundStatements.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO match_events'));
    expect(autoTurnEvents()).toHaveLength(1);
    expect(JSON.parse(autoTurnEvents()[0].values[4] as string).action.type).toBe('auto-turn');
    await room.alarm();
    expect(autoTurnEvents()).toHaveLength(1);
  });

  it.each([1, 2, 4] as const)('carries a %i-crown public-room target into the match engine', async (crownTarget) => {
    const { room, records } = createFixture();
    const code = crownTarget === 1 ? 'ABC567' : crownTarget === 2 ? 'DEF678' : 'GHI789';
    await room.fetch(request('/create', { code, gameId: 'ludo', userId: 61, displayName: 'Host', expiresAt: Date.now() + 60_000, publicRoomOptions: { player0Color: 'yellow', crownTarget } }));
    await room.fetch(request('/join', { code, userId: 62, displayName: 'Friend' }));
    const current = records.get('room') as { game: { crownTarget: number }; publicRoomOptions: { crownTarget: number } };
    expect(current.game.crownTarget).toBe(crownTarget);
    expect(current.publicRoomOptions.crownTarget).toBe(crownTarget);
  });
});

describe('free room game catalog', () => {
  it.each(['xo', 'ludo', 'checkers', 'poker'] as const)('records %s with its own game identity', async (gameId) => {
    const { room, boundStatements } = createFixture();
    const code = gameId === 'xo' ? 'GHI234' : gameId === 'ludo' ? 'JKL345' : gameId === 'checkers' ? 'MNP456' : 'QRS567';
    await room.fetch(request('/create', { code, gameId, userId: 41, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    await room.fetch(request('/join', { code, userId: 42, displayName: 'Friend' }));
    const statement = boundStatements.find((entry) => entry.sql.includes('INSERT INTO matches'))!;
    expect(statement.values[0]).toBe(`${gameId}-${code}`);
    expect(statement.values[2]).toBe(gameId);
  });

  it('keeps concealed poker cards and deck out of saved event payloads', async () => {
    const { room, boundStatements } = createFixture();
    const code = 'TUV678';
    await room.fetch(request('/create', { code, gameId: 'poker', userId: 51, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    await room.fetch(request('/join', { code, userId: 52, displayName: 'Friend' }));
    await room.webSocketMessage(socket(51, []), JSON.stringify({ type: 'action', action: { type: 'call' } }));
    const event = boundStatements.find((entry) => entry.sql.includes('INSERT OR IGNORE INTO match_events'))!;
    const payload = JSON.parse(String(event.values[4])) as { state: { players: Record<string, unknown>[]; deck?: unknown; deckCount?: number } };
    expect(payload.state.players.every((player) => !('hole' in player))).toBe(true);
    expect(payload.state).not.toHaveProperty('deck');
    expect(payload.state.deckCount).toBe(48);
  });

  it('validates authoritative checkers turns and records a resign', async () => {
    const { room, records, batches } = createFixture();
    const code = 'CHK234';
    await room.fetch(request('/create', { code, gameId: 'checkers', userId: 71, displayName: 'Host', expiresAt: Date.now() + 60_000 }));
    await room.fetch(request('/join', { code, userId: 72, displayName: 'Friend' }));
    let current = records.get('room') as { game: CheckersState; status: string; terminal?: { winner: number | 'draw' } };
    expect(current.game.board.filter((piece) => piece?.player === 0)).toHaveLength(12);
    expect(current.game.turn).toBe(1);
    const move = legalCheckerMoves(current.game)[0];
    const sent: string[] = [];
    await room.webSocketMessage(socket(71, sent), JSON.stringify({ type: 'move', from: move.from, to: move.to }));
    expect(sent[0]).toContain('Please wait for your turn');
    await room.webSocketMessage(socket(72, []), JSON.stringify({ type: 'move', from: move.from, to: move.to }));
    current = records.get('room') as typeof current;
    expect(current.game.moveCount).toBe(1);
    expect(current.game.turn).toBe(0);
    await room.webSocketMessage(socket(71, []), JSON.stringify({ type: 'resign' }));
    current = records.get('room') as typeof current;
    expect(current.status).toBe('finished');
    expect(current.terminal?.winner).toBe(1);
    expect(batches.some((batch) => batch.some((sql) => sql.includes("status = 'completed'")))).toBe(true);
  });
});
