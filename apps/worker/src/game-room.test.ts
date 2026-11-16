import { describe, expect, it } from 'vitest';
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
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => { const statement = { sql, values }; boundStatements.push(statement); return statement; } }),
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
    expect(batches.some((batch) => batch.some((sql) => sql.includes('INSERT INTO match_events')))).toBe(true);
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
    expect(batches.some((batch) => batch.some((sql) => sql.includes('INSERT INTO match_events')))).toBe(true);
  });
});

describe('free room game catalog', () => {
  it.each(['xo', 'ludo', 'dominoes', 'poker'] as const)('records %s with its own game identity', async (gameId) => {
    const { room, boundStatements } = createFixture();
    const code = gameId === 'xo' ? 'GHI234' : gameId === 'ludo' ? 'JKL345' : gameId === 'dominoes' ? 'MNP456' : 'QRS567';
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
    const event = boundStatements.find((entry) => entry.sql.includes('INSERT INTO match_events'))!;
    const payload = JSON.parse(String(event.values[4])) as { state: { players: Record<string, unknown>[]; deck?: unknown; deckCount?: number } };
    expect(payload.state.players.every((player) => !('hole' in player))).toBe(true);
    expect(payload.state).not.toHaveProperty('deck');
    expect(payload.state.deckCount).toBe(48);
  });
});
