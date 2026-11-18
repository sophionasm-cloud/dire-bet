import { PUBLIC_GAMES, TelegramAuthRequestSchema, type GameId } from '@dire-bet/shared';
import { applyXO, initXO, type Mark, type XOState } from '@dire-bet/engines/xo';
import { initLudo, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyDominoAction, newDominoesGame, nextDominoesRound, viewDominoes, type DominoAction, type DominoesState } from '@dire-bet/engines/dominoes';
import { applyPokerAction, initTexasHoldem, viewPoker, type PokerAction, type PokerState } from '@dire-bet/engines/poker';
import { Matchmaker } from './public-marketplace';
import { isMarketplaceGame } from './marketplace';
import { addisWeekStart } from './agent-report';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  PRESENCE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  ENVIRONMENT: string;
  BOT_USERNAME: string;
  REAL_MONEY_ENABLED: string;
  DEMO_MODE: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
  SETUP_KEY?: string;
  SUPER_ADMIN_TELEGRAM_ID?: string;
}

const enc = new TextEncoder();
const ONE_HOUR = 60 * 60;
const SESSION_LIFETIME = 15 * 60;
const PASSWORD_SESSION_LIFETIME = 12 * 60 * 60;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_TTL_MS = 15 * 60 * 1000;
const RECONNECT_GRACE_MS = 60 * 1000;

type RoomGame = 'xo' | 'ludo' | 'dominoes' | 'poker';
type RoomState = XOState | LudoState | DominoesState | PokerState;
type RoomPlayer = { id: number; name: string; mark: Mark | null; online: boolean };
type StoredRoom = { code: string; gameId: RoomGame; hostId: number; status: 'waiting' | 'active' | 'finished' | 'cancelled'; players: RoomPlayer[]; game: RoomState; matchId: string | null; sequence: number; expiresAt: number; publicRoomId?: string; publicRoomOptions?: Record<string, unknown>; entryCredits?: number; commissionBps?: number };
type RoomTicket = { userId: number; displayName: string; code: string; expiresAt: number };

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), payment=(), microphone=(self)',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; base-uri 'self'; form-action 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
};

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const result = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders, ...Object.fromEntries(new Headers(headers)) });
  return new Response(JSON.stringify(data), { status, headers: result });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let mismatch = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i++) mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return mismatch === 0;
}

async function hmac(key: string, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(value)));
}

export async function validateInitData(initData: string, botToken: string): Promise<{ user: Record<string, unknown>; authDate: number } | null> {
  const params = new URLSearchParams(initData);
  const pairs = [...params.entries()];
  if (pairs.length < 3 || new Set(pairs.map(([key]) => key)).size !== pairs.length) return null;
  const suppliedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  const now = Math.floor(Date.now() / 1000);
  if (!suppliedHash || !Number.isInteger(authDate) || now - authDate > ONE_HOUR || authDate > now + 60) return null;
  const checkString = pairs.filter(([key]) => key !== 'hash').map(([key, value]) => `${key}=${value}`).sort().join('\n');
  const secret = await hmac('WebAppData', botToken);
  const cryptoKey = await crypto.subtle.importKey('raw', ownedBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(checkString)));
  const supplied = fromHex(suppliedHash);
  if (!supplied || !equalBytes(expected, supplied)) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null') as Record<string, unknown> | null;
    if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id)) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return atob(padded);
}

function randomCode(length = 6): string {
  const limit = Math.floor(256 / ROOM_ALPHABET.length) * ROOM_ALPHABET.length;
  let result = '';
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) if (byte < limit) result += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  }
  return result.slice(0, length);
}

function secureRandom(): number {
  const ceiling = 0x1_0000_0000;
  const limit = Math.floor(ceiling / 1_000_000) * 1_000_000;
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]; } while (value >= limit);
  return (value % 1_000_000) / 1_000_000;
}

function secureInt(minimum: number, maximum: number): number {
  return minimum + Math.floor(secureRandom() * (maximum - minimum + 1));
}

function createGame(gameId: RoomGame): RoomState {
  if (gameId === 'xo') return initXO();
  if (gameId === 'ludo') return initLudo();
  if (gameId === 'dominoes') return newDominoesGame(secureRandom);
  return initTexasHoldem(secureRandom, [1000, 1000]);
}

function gameTurn(room: StoredRoom): number | null {
  if (room.gameId === 'xo') return room.players.findIndex((player) => player.mark === (room.game as XOState).turn);
  if (room.gameId === 'ludo') return (room.game as LudoState).turn;
  if (room.gameId === 'dominoes') return (room.game as DominoesState).turn;
  return (room.game as PokerState).turn;
}

function gameComplete(room: StoredRoom): { done: boolean; winner: number | 'draw' | null } {
  if (room.gameId === 'xo') {
    const game = room.game as XOState;
    return { done: game.winner !== null, winner: game.winner === 'draw' ? 'draw' : game.winner ? room.players.findIndex((player) => player.mark === game.winner) : null };
  }
  if (room.gameId === 'ludo') { const game = room.game as LudoState; return { done: game.winner !== null, winner: game.winner }; }
  if (room.gameId === 'dominoes') { const game = room.game as DominoesState; return { done: game.status === 'finished', winner: game.winner }; }
  const game = room.game as PokerState;
  return { done: game.street === 'showdown' || game.street === 'folded', winner: game.winner === 'split' ? 'draw' : game.winner };
}

function roomAuditView(room: StoredRoom): unknown {
  if (room.gameId === 'xo' || room.gameId === 'ludo') return room.game;
  if (room.gameId === 'dominoes') {
    const { hands, boneyard, ...publicState } = room.game as DominoesState;
    return { ...publicState, hands: hands.map((hand) => hand.length), boneyardCount: boneyard.length };
  }
  const { deck, players, ...publicState } = room.game as PokerState;
  return { ...publicState, players: players.map(({ stack, invested }) => ({ stack, invested })), deckCount: deck.length };
}

async function issueRoomTicket(userId: number, displayName: string, code: string, secret: string): Promise<string> {
  const payload = base64url(enc.encode(JSON.stringify({ userId, displayName, code, expiresAt: Math.floor(Date.now() / 1000) + 90 })));
  const signature = base64url(await hmac(secret, payload));
  return `${payload}.${signature}`;
}

async function readRoomTicket(value: string, secret?: string): Promise<RoomTicket | null> {
  if (!secret || value.length > 2048) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const expected = await hmac(secret, payload);
    const received = Uint8Array.from(decodeBase64url(signature), (character) => character.charCodeAt(0));
    if (!equalBytes(expected, received)) return null;
    const decoded = JSON.parse(decodeBase64url(payload)) as Partial<RoomTicket>;
    if (!Number.isSafeInteger(decoded.userId) || typeof decoded.displayName !== 'string' || !/^[23456789A-HJ-NP-Z]{6}$/.test(decoded.code || '') || !Number.isInteger(decoded.expiresAt) || (decoded.expiresAt || 0) < Date.now() / 1000) return null;
    return decoded as RoomTicket;
  } catch { return null; }
}

async function hashWebPassword(password: string, salt: string, secret: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', enc.encode(`${secret}\u0000${password}`), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(decodeBase64url(salt), (character) => character.charCodeAt(0)), iterations: 600_000, hash: 'SHA-256' }, material, 256));
}

async function encryptContact(phone: string, secret: string): Promise<string> {
  const keyMaterial = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`dire-bet-contact-v1:${secret}`)));
  const key = await crypto.subtle.importKey('raw', ownedBuffer(keyMaterial), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(phone)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv); packed.set(ciphertext, iv.length);
  return base64url(packed);
}

async function gameDisplayName(env: Env, userId: number): Promise<string | null> {
  const user = await env.DB.prepare('SELECT first_name, username, web_username FROM users WHERE id = ? AND status = ?').bind(userId, 'active').first<{ first_name: string; username: string | null; web_username: string | null }>();
  if (!user) return null;
  return (user.web_username || (user.username ? `@${user.username}` : user.first_name)).slice(0, 32);
}

async function hasRegisteredContact(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT user_id FROM user_contacts WHERE user_id = ?').bind(userId).first();
  return Boolean(row);
}

async function allowRoomAction(env: Env, userId: number, action: string): Promise<boolean> {
  return allowRateLimit(env, `room-user:${userId}`, action);
}

async function allowRateLimit(env: Env, bucket: string, action: string, limit = 30, windowSeconds = 60): Promise<boolean> {
  const id = env.RATE_LIMITER.idFromName(bucket);
  const limiter = env.RATE_LIMITER.get(id);
  const response = await limiter.fetch(`https://rate-limit/?key=${encodeURIComponent(action)}&limit=${limit}&window=${windowSeconds}`);
  if (!response.ok) return false;
  const result = await response.json() as { allowed?: boolean };
  return result.allowed === true;
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Open DIRE BET in Telegram to create an online room.' }, 401);
  if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your contact with the DIRE BET bot to finish registration.' }, 403);
  if (!(await allowRoomAction(env, userId, 'create'))) return json({ error: 'Too many room attempts. Try again shortly.' }, 429);
  let body: { gameId?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request' }, 400); }
  if (body.gameId !== 'xo' && body.gameId !== 'ludo' && body.gameId !== 'dominoes' && body.gameId !== 'poker') return json({ error: 'This game cannot be played online.' }, 409);
  const displayName = await gameDisplayName(env, userId);
  if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
  const game = await env.DB.prepare('SELECT enabled FROM games WHERE id = ?').bind(body.gameId).first<{ enabled: number }>();
  if (!game || game.enabled !== 1) return json({ error: 'This game is not open for online play.' }, 409);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      await env.DB.prepare(`INSERT INTO game_rooms (id, code, game_id, host_user_id, status, capacity, mode, expires_at)
        VALUES (?, ?, ?, ?, 'waiting', 2, 'free', ?)`)
        .bind(code, code, body.gameId, userId, new Date(Date.now() + ROOM_TTL_MS).toISOString()).run();
    } catch { continue; }
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
    const init = await stub.fetch('https://room/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, gameId: body.gameId, userId, displayName, expiresAt: Date.now() + ROOM_TTL_MS }) });
    if (!init.ok) {
      await env.DB.prepare('DELETE FROM game_rooms WHERE id = ? AND status = ?').bind(code, 'waiting').run();
      return json({ error: 'Could not create room. Try again.' }, 503);
    }
    return json({ code, ticket: await issueRoomTicket(userId, displayName, code, env.SESSION_SECRET || ''), gameId: body.gameId }, 201);
  }
  return json({ error: 'Could not reserve a room code. Try again.' }, 503);
}

async function joinRoom(request: Request, env: Env, code: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (!/^[23456789A-HJ-NP-Z]{6}$/i.test(code)) return json({ error: 'Room code is invalid.' }, 400);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Open DIRE BET in Telegram to join an online room.' }, 401);
  if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your contact with the DIRE BET bot to finish registration.' }, 403);
  if (!(await allowRoomAction(env, userId, 'join'))) return json({ error: 'Too many room attempts. Try again shortly.' }, 429);
  const row = await env.DB.prepare('SELECT id, game_id, status, expires_at FROM game_rooms WHERE code = ?').bind(code.toUpperCase()).first<{ id: string; game_id: string; status: string; expires_at: string | null }>();
  if (!row || (row.expires_at && Date.parse(row.expires_at) < Date.now())) return json({ error: 'Room not found or expired.' }, 404);
  if (row.game_id !== 'xo' && row.game_id !== 'ludo' && row.game_id !== 'dominoes' && row.game_id !== 'poker') return json({ error: 'This game is not available online yet.' }, 409);
  const game = await env.DB.prepare('SELECT enabled FROM games WHERE id = ?').bind(row.game_id).first<{ enabled: number }>();
  if (!game || game.enabled !== 1) return json({ error: 'This game is not open for online play.' }, 409);
  const displayName = await gameDisplayName(env, userId);
  if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(row.id));
  const response = await stub.fetch('https://room/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: row.id, userId, displayName }) });
  if (!response.ok) return json(await response.json(), response.status);
  return json({ code: row.id, ticket: await issueRoomTicket(userId, displayName, row.id, env.SESSION_SECRET || ''), gameId: row.game_id });
}

function publicMarketplace(env: Env): DurableObjectStub {
  return env.MATCHMAKER.get(env.MATCHMAKER.idFromName('public-room-marketplace'));
}

async function createPublicRoom(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Open DIRE BET in Telegram to create a public room.' }, 401);
  if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your contact with the DIRE BET bot to finish registration.' }, 403);
  if (!(await allowRoomAction(env, userId, 'public-create'))) return json({ error: 'Too many room attempts. Try again shortly.' }, 429);
  const input = await request.json().catch(() => null) as { gameId?: unknown; entry?: unknown; options?: unknown; idempotencyKey?: unknown } | null;
  if (!input || !isMarketplaceGame(input.gameId)) return json({ error: 'This game cannot be opened in the public room list.' }, 409);
  const game = await env.DB.prepare('SELECT enabled FROM games WHERE id = ?').bind(input.gameId).first<{ enabled: number }>();
  if (!game || game.enabled !== 1) return json({ error: 'This game is not open for online play.' }, 409);
  const displayName = await gameDisplayName(env, userId);
  if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
  return publicMarketplace(env).fetch('https://market/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, userId, displayName }),
  });
}

async function superAdmin(request: Request, env: Env): Promise<number | Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Sign in through your approved Telegram account.' }, 401);
  if (!env.SUPER_ADMIN_TELEGRAM_ID) return json({ error: 'Room management is waiting for the owner Telegram ID to be configured.' }, 503);
  const account = await env.DB.prepare('SELECT telegram_id FROM users WHERE id = ? AND status = ?').bind(userId, 'active').first<{ telegram_id: number }>();
  if (!account || String(account.telegram_id) !== env.SUPER_ADMIN_TELEGRAM_ID) return json({ error: 'This Telegram account is not the configured Super Admin.' }, 403);
  return userId;
}

async function handlePublicMarketplace(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/public-rooms/config' && request.method === 'GET') return publicMarketplace(env).fetch('https://market/config');
  if (url.pathname === '/api/public-rooms' && request.method === 'GET') {
    const gameId = url.searchParams.get('gameId') || '';
    if (gameId && !isMarketplaceGame(gameId)) return json({ error: 'Game filter is invalid.' }, 400);
    return publicMarketplace(env).fetch(`https://market/list?gameId=${encodeURIComponent(gameId)}`);
  }
  if (url.pathname === '/api/public-rooms/balance' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ error: 'Sign in through Telegram to view demo credits.' }, 401);
    if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your Telegram contact to view a room balance.' }, 403);
    return publicMarketplace(env).fetch(`https://market/balance?userId=${userId}`);
  }
  if (url.pathname === '/api/public-rooms/mine' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ room: null });
    const gameId = url.searchParams.get('gameId') || '';
    return publicMarketplace(env).fetch(`https://market/mine?userId=${userId}&gameId=${encodeURIComponent(gameId)}`);
  }
  if (url.pathname === '/api/public-rooms' && request.method === 'POST') return createPublicRoom(request, env);
  if (url.pathname === '/api/public-rooms/ws-ticket' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ ticket: null });
    const displayName = await gameDisplayName(env, userId);
    if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
    return json({ ticket: await issueRoomTicket(userId, displayName, 'MARKET', env.SESSION_SECRET || '') });
  }
  const publicAction = url.pathname.match(/^\/api\/public-rooms\/([23456789A-HJ-NP-Z]{6})\/(join|cancel|session)$/i);
  if (publicAction) {
    const [, rawCode, action] = publicAction;
    const code = rawCode.toUpperCase();
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    if (action === 'join' && request.method === 'POST') {
      const userId = await readSession(request, env.SESSION_SECRET);
      if (!userId) return json({ error: 'Sign in through Telegram to join a room.' }, 401);
      if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your contact with the DIRE BET bot to finish registration.' }, 403);
      if (!(await allowRoomAction(env, userId, 'public-join'))) return json({ error: 'Too many room attempts. Try again shortly.' }, 429);
      const displayName = await gameDisplayName(env, userId);
      if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
      return publicMarketplace(env).fetch(`https://market/join/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, displayName }) });
    }
    if (action === 'cancel' && request.method === 'POST') {
      const userId = await readSession(request, env.SESSION_SECRET);
      if (!userId) return json({ error: 'Sign in through Telegram to cancel a room.' }, 401);
      return publicMarketplace(env).fetch(`https://market/cancel/${code}`, { method: 'POST', headers: { 'X-Market-User': String(userId) } });
    }
    if (action === 'session' && request.method === 'GET') {
      const userId = await readSession(request, env.SESSION_SECRET);
      if (!userId) return json({ error: 'Sign in through Telegram to reopen a match.' }, 401);
      const result = await publicMarketplace(env).fetch(`https://market/session/${code}?userId=${userId}`);
      if (!result.ok) return result;
      const session = await result.json() as { code: string; gameId: GameId; room: unknown };
      const displayName = await gameDisplayName(env, userId);
      if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
      return json({ ...session, ticket: await issueRoomTicket(userId, displayName, code, env.SESSION_SECRET || '') });
    }
  }
  if (url.pathname.startsWith('/api/admin/public-rooms')) {
    const adminId = await superAdmin(request, env);
    if (adminId instanceof Response) return adminId;
    if (url.pathname === '/api/admin/public-rooms' && request.method === 'GET') {
      const gameId = url.searchParams.get('gameId') || '';
      const filter = gameId && isMarketplaceGame(gameId) ? `?gameId=${encodeURIComponent(gameId)}` : '';
      return publicMarketplace(env).fetch(`https://market/admin/rooms${filter}`, { headers: { 'X-Market-Admin': String(adminId) } });
    }
    if (url.pathname === '/api/admin/public-rooms/settings' && request.method === 'PUT') {
      const body = await request.json().catch(() => null);
      if (!body) return json({ error: 'Settings are invalid.' }, 400);
      return publicMarketplace(env).fetch('https://market/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'X-Market-Admin': String(adminId) }, body: JSON.stringify(body) });
    }
    const adminCancel = url.pathname.match(/^\/api\/admin\/public-rooms\/([23456789A-HJ-NP-Z]{6})\/cancel$/i);
    if (adminCancel && request.method === 'POST') return publicMarketplace(env).fetch(`https://market/admin/cancel/${adminCancel[1].toUpperCase()}`, { method: 'POST', headers: { 'X-Market-Admin': String(adminId) } });
    const adminDetail = url.pathname.match(/^\/api\/admin\/public-rooms\/([23456789A-HJ-NP-Z]{6})$/i);
    if (adminDetail && request.method === 'GET') return publicMarketplace(env).fetch(`https://market/admin/room/${adminDetail[1].toUpperCase()}`);
    return json({ error: 'Room management route not found.' }, 404);
  }
  return null;
}

async function connectRoom(request: Request, env: Env, code: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
  const ticket = await readRoomTicket(new URL(request.url).searchParams.get('ticket') || '', env.SESSION_SECRET);
  if (!ticket || ticket.code !== code) return json({ error: 'Room ticket is invalid or expired.' }, 401);
  const headers = new Headers(request.headers);
  headers.set('X-Game-User', String(ticket.userId));
  headers.set('X-Game-Name', ticket.displayName);
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
  return stub.fetch(new Request('https://room/connect', { method: 'GET', headers }));
}

async function issueSession(userId: number, secret: string, lifetime = SESSION_LIFETIME): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(enc.encode(JSON.stringify({ sub: String(userId), iat: now, exp: now + lifetime })));
  const body = `${header}.${payload}`;
  const signature = await hmac(secret, body);
  return `${body}.${base64url(signature)}`;
}

async function readSession(request: Request, secret?: string): Promise<number | null> {
  if (!secret) return null;
  const value = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  try {
    const body = `${parts[0]}.${parts[1]}`;
    const expected = await hmac(secret, body);
    const received = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (!equalBytes(expected, received)) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string; exp?: number };
    if (!payload.sub || !payload.exp || payload.exp < Date.now() / 1000) return null;
    const id = Number(payload.sub);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

export async function moneyActivationRecorded(env: Env): Promise<boolean> {
  if (env.REAL_MONEY_ENABLED !== 'true' || env.DEMO_MODE !== 'false') return false;
  try {
    const record = await env.DB.prepare('SELECT id, evidence_json, minimum_age FROM activation_records ORDER BY approved_at DESC LIMIT 1').first<{ id: string; evidence_json: string; minimum_age: number }>();
    if (!record || !Number.isInteger(record.minimum_age) || record.minimum_age < 1) return false;
    const audit = await env.DB.prepare("SELECT id FROM audit_logs WHERE action = 'REAL_MONEY_ACTIVATED' AND entity_type = 'activation_record' AND entity_id = ? LIMIT 1").bind(record.id).first();
    if (!audit) return false;
    const evidence = JSON.parse(record.evidence_json) as Record<string, unknown>;
    return typeof evidence.counselApproval === 'string' && evidence.counselApproval.length > 0
      && Array.isArray(evidence.providerApprovals) && evidence.providerApprovals.length > 0
      && typeof evidence.telegramApproval === 'string' && evidence.telegramApproval.length > 0
      && Array.isArray(evidence.licenseReferences) && evidence.licenseReferences.length > 0
      && Number.isInteger(evidence.minimumAge) && evidence.minimumAge === record.minimum_age
      && typeof evidence.ownerSignedAt === 'string' && evidence.ownerSignedAt.length > 0;
  } catch { return false; }
}

async function telegramApi<T>(token: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Telegram request failed');
  const result = await response.json() as { ok?: boolean; result?: T };
  if (!result.ok) throw new Error('Telegram request rejected');
  return result.result as T;
}

const welcome: Record<string, string> = {
  en: 'Welcome to DIRE BET. Play free practice games with friends.',
  am: 'ወደ DIRE BET እንኳን በደህና መጡ። ከጓደኞችዎ ጋር በነፃ ይጫወቱ።',
  so: 'Ku soo dhowow DIRE BET. Saaxiibbadaa kula ciyaar bilaash.',
  om: 'Baga DIRE BET dhuftan. Hiriyoota waliin bilisaan taphadhaa.',
};

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'Bot is not configured' }, 503);
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'Unauthorized' }, 401);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_WEBHOOK_BYTES) return json({ error: 'Request too large' }, 413);
  const text = new TextDecoder().decode(bytes);
  let update: { message?: { text?: string; chat?: { id?: number }; from?: { id?: number; username?: string; first_name?: string; last_name?: string; language_code?: string }; contact?: { user_id?: number; phone_number?: string; first_name?: string } } };
  try { update = JSON.parse(text) as typeof update; } catch { return json({ ok: true }); }
  const message = update.message;
  if (message?.contact) {
    await storeTelegramContact(message, env, new URL(request.url).origin);
    return json({ ok: true });
  }
  if (!message?.text || typeof message.chat?.id !== 'number') return json({ ok: true });
  const parts = message.text.trim().split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const roomPayload = command === '/start' && /^room_[23456789A-HJ-NP-Z]{6}$/i.test(parts[1] || '') ? parts[1].slice(5).toUpperCase() : null;
  const agentCodeMatch = command === '/start' ? (parts[1] || '').match(/^agent_([A-Z0-9]{4,16})$/i) : null;
  const agentCode = agentCodeMatch?.[1]?.toUpperCase() || null;
  const agent = agentCode ? await env.DB.prepare(`SELECT id, user_id FROM agents WHERE referral_code = ? COLLATE NOCASE AND status = 'active'`).bind(agentCode).first<{ id: string; user_id: number | null }>() : null;
  if (agent && agentCode && message.from && Number.isSafeInteger(message.from.id) && message.from.id! > 0) {
    const telegramId = message.from.id as number;
    const firstName = (message.from.first_name || 'Player').slice(0, 128);
    const username = message.from.username?.slice(0, 64) || null;
    const language = ['am', 'so', 'om'].includes(message.from.language_code || '') ? message.from.language_code as string : 'en';
    const user = await env.DB.prepare(`INSERT INTO users (telegram_id, username, first_name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username), first_name = excluded.first_name, updated_at = CURRENT_TIMESTAMP
      RETURNING id`).bind(telegramId, username, firstName, language).first<{ id: number }>();
    if (user && user.id !== agent.user_id) {
      await env.DB.prepare(`INSERT OR IGNORE INTO referrals (id, referred_user_id, agent_id, source_code) VALUES (?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), user.id, agent.id, agentCode).run();
    }
  }
  const lang = ['am', 'so', 'om'].includes(message.from?.language_code || '') ? message.from?.language_code as string : 'en';
  const base = new URL(request.url).origin;
  const gameList: Record<string, string> = {
    en: 'Free practice vs a bot: XO, Ludo, Dominoes and Texas Hold’em. Create a private online room for any of the four games.',
    am: 'በነፃ ከቦት ጋር ይለማመዱ፦ XO፣ Ludo፣ Dominoes እና Texas Hold’em። ከአራቱ ጨዋታዎች ለማንኛውም የግል ኦንላይን ክፍል ይፍጠሩ።',
    so: 'Tababar bilaash ah la ciyaar bot: XO, Ludo, Dominoes iyo Texas Hold’em. U samee qol gaar ah mid kasta oo ka mid ah afarta ciyaarood.',
    om: 'Shaakala bilisaa bot waliin: XO, Ludo, Dominoes fi Texas Hold’em. Tapha afran keessaa kamiyyuu irratti kutaa dhuunfaa uumi.',
  };
  const responses: Record<string, string> = {
    '/start': welcome[lang],
    '/play': welcome[lang],
    '/games': gameList[lang],
    '/profile': 'Open DIRE BET to view your player profile.',
    '/account': 'Share your contact with this bot, then open Account in DIRE BET to set an optional web username and 8-digit PIN.',
    '/wallet': 'TEST MODE · Demo credits are not ETB cash. Live deposits and withdrawals are disabled.',
    '/leaderboard': 'The public leaderboard is not available yet.',
    '/help': 'DIRE BET free-play preview. Use /support for help.',
    '/support': 'Support tickets are not available yet. Please check back later.',
    '/stop': 'Promotional messages are not sent in this preview.',
  };
  const reply_markup = ['/start', '/play', '/games'].includes(command) ? {
    inline_keyboard: [[{ text: roomPayload ? `Join game · ${roomPayload}` : 'Play DIRE BET', web_app: { url: roomPayload ? `${base}/?room=${roomPayload}` : agentCode && agent ? `${base}/?ref=${encodeURIComponent(agentCode)}` : base } }]],
  } : command === '/account' ? {
    inline_keyboard: [[{ text: 'Set up web login', web_app: { url: `${base}/?page=account` } }]],
  } : command === '/wallet' ? {
    inline_keyboard: [[{ text: 'Open demo wallet', web_app: { url: `${base}/?page=wallet` } }]],
  } : undefined;
  await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: message.chat.id,
    text: roomPayload ? `${welcome[lang]} Room ${roomPayload} is ready. Tap below to join.` : agentCode && agent ? `${welcome[lang]} This link uses promo code ${agentCode}. Agent reports use demo match results only; there are no cash commissions or payments.` : responses[command] || 'Use /play to open free practice games, or /help for help.',
    ...(reply_markup ? { reply_markup } : {}),
  });
  if (command === '/start') {
    const registrationText: Record<string, string> = {
      en: 'Optional web login: share your own contact, then open Account to choose a username and 8-digit PIN. Your contact is used only to link your account. Live payments are off.',
      am: 'የድር መግቢያ አማራጭ ነው፦ የራስዎን እውቂያ ያጋሩ፣ ከዚያ መለያ ውስጥ የተጠቃሚ ስምና 8 አሃዝ PIN ይምረጡ። እውቂያዎ መለያዎን ለማገናኘት ብቻ ይጠቀማል። ቀጥታ ክፍያዎች የሉም።',
      so: 'Gelitaanka webka waa ikhtiyaari: la wadaag xiriirkaaga, kadib fur Account oo dooro magac iyo PIN 8-god ah. Xiriirka waxaa loo isticmaalaa oo keliya isku xidhka akoonkaaga. Lacag-bixin toos ah ma jirto.',
      om: 'Seensi weebii filannoo dha: quunnamtii kee qoodi, achiis Herrega baniitii maqaa fayyadamaa fi PIN lakkoofsa 8 filadhu. Quunnamtiin kee herrega kee walitti hidhuuf qofa fayyada. Kaffaltiin kallattiin hin jiru.',
    };
    const keyboardLabels: Record<string, { play: string; contact: string; wallet: string; more: string }> = {
      en: { play: '🎮 Play', contact: 'Share contact', wallet: 'Demo wallet', more: 'More' },
      am: { play: '🎮 መጫወት', contact: 'እውቂያ አጋራ', wallet: 'የማሳያ ዋሌት', more: 'ተጨማሪ' },
      so: { play: '🎮 Ciyaar', contact: 'La wadaag xiriirka', wallet: 'Wallet tijaabo', more: 'Wax badan' },
      om: { play: '🎮 Taphadhu', contact: 'Quunnamtii qoodi', wallet: 'Wallet shaakalaa', more: 'Dabalata' },
    };
    const labels = keyboardLabels[lang];
    await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: registrationText[lang],
      reply_markup: {
        keyboard: [
          [{ text: labels.play, web_app: { url: base } }],
          [{ text: labels.contact, request_contact: true }],
          [{ text: labels.wallet, web_app: { url: `${base}/?page=wallet` } }, { text: labels.more, web_app: { url: `${base}/?page=menu` } }],
        ],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: 'Choose an option',
      },
    });
  }
  return json({ ok: true });
}

async function setupTelegram(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_KEY || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'Setup secrets are not configured' }, 503);
  if (request.headers.get('Authorization') !== `Bearer ${env.SETUP_KEY}`) return json({ error: 'Unauthorized' }, 401);
  const origin = new URL(request.url).origin;
  const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const call = async (method: string, body: unknown) => {
    const response = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json() as { ok?: boolean };
    if (!response.ok || !data.ok) throw new Error(`Telegram ${method} failed`);
  };
  try {
    await call('setWebhook', { url: `${origin}/telegram/webhook`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    await call('setMyCommands', { commands: [
      { command: 'start', description: 'Open DIRE BET' }, { command: 'play', description: 'Play free games' },
      { command: 'games', description: 'See available games' }, { command: 'profile', description: 'View your profile' },
      { command: 'account', description: 'Set up optional web login' },
      { command: 'wallet', description: 'View demo wallet status' }, { command: 'leaderboard', description: 'View rankings' },
      { command: 'help', description: 'Get help' }, { command: 'support', description: 'Contact support' },
      { command: 'stop', description: 'Turn off promotions' },
    ] });
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: origin } } });
    await call('setMyDescription', { description: 'DIRE BET · Friendly free-play games for the community.' });
    await env.DB.prepare("INSERT INTO application_settings (key, value, updated_at) VALUES ('telegram_setup_used', 'true', CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = CURRENT_TIMESTAMP").run();
    return json({ ok: true });
  } catch {
    return json({ error: 'Telegram setup failed. Check the Worker secrets and try again.' }, 502);
  }
}

async function authenticate(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (!env.TELEGRAM_BOT_TOKEN || !env.SESSION_SECRET) return json({ error: 'Telegram authentication is not configured' }, 503);
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }
  const parsed = TelegramAuthRequestSchema.safeParse(input);
  if (!parsed.success) return json({ error: 'Invalid Telegram data' }, 400);
  const verified = await validateInitData(parsed.data.initData, env.TELEGRAM_BOT_TOKEN);
  if (!verified) return json({ error: 'Telegram session is invalid or expired' }, 401);
  const user = verified.user;
  const id = user.id as number;
  const username = typeof user.username === 'string' ? user.username.slice(0, 64) : null;
  const firstName = typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : 'Player';
  const lastName = typeof user.last_name === 'string' ? user.last_name.slice(0, 128) : null;
  const lang = typeof user.language_code === 'string' && ['am', 'so', 'om'].includes(user.language_code) ? user.language_code : 'en';
  try {
    const result = await env.DB.prepare(`INSERT INTO users (telegram_id, username, first_name, last_name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
      last_name = excluded.last_name, updated_at = CURRENT_TIMESTAMP RETURNING id`).bind(id, username, firstName, lastName, lang).first<{ id: number }>();
    if (!result) return json({ error: 'Could not create session' }, 500);
    const token = await issueSession(result.id, env.SESSION_SECRET);
    return json({ token, expiresIn: SESSION_LIFETIME, user: { displayName: firstName, username, language: lang } });
  } catch {
    return json({ error: 'Could not create session' }, 503);
  }
}

function normalizeWebUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{2,23}$/.test(username) ? username : null;
}

async function setWebLogin(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Sign in through Telegram first.' }, 401);
  if (!env.SESSION_SECRET) return json({ error: 'Account setup is unavailable.' }, 503);
  if (!(await allowRateLimit(env, `web-login-setup:${userId}`, 'setup', 5, 900))) return json({ error: 'Too many setup attempts. Try again in 15 minutes.' }, 429);
  let body: { username?: unknown; password?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request.' }, 400); }
  const username = normalizeWebUsername(body.username);
  if (!username || typeof body.password !== 'string' || !/^\d{8}$/.test(body.password)) return json({ error: 'Use a username with 3–24 letters, numbers or underscores, and an 8-digit PIN.' }, 400);
  const contact = await env.DB.prepare('SELECT user_id FROM user_contacts WHERE user_id = ?').bind(userId).first();
  if (!contact) return json({ error: 'Share your phone number with the DIRE BET bot first.' }, 409);
  const taken = await env.DB.prepare('SELECT id FROM users WHERE web_username = ? COLLATE NOCASE AND id != ?').bind(username, userId).first();
  if (taken) return json({ error: 'That username is already in use.' }, 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltText = base64url(salt);
  const hash = base64url(await hashWebPassword(body.password, saltText, env.SESSION_SECRET));
  try {
    await env.DB.prepare('UPDATE users SET web_username = ?, password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(username, saltText, hash, userId).run();
    return json({ ok: true, username });
  } catch {
    return json({ error: 'That username is already in use.' }, 409);
  }
}

async function authenticatePassword(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (!env.SESSION_SECRET) return json({ error: 'Web login is not configured.' }, 503);
  let body: { username?: unknown; password?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request.' }, 400); }
  const username = normalizeWebUsername(body.username);
  if (!username || typeof body.password !== 'string' || !/^\d{8}$/.test(body.password)) return json({ error: 'Username or PIN did not match.' }, 401);
  if (!(await allowRateLimit(env, 'web-password-logins', `login:${username}`, 6, 900))) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(clientIp)));
    const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
    if (!(await allowRateLimit(env, 'web-password-logins', `ip:${fingerprint}`, 30, 900))) return json({ error: 'Too many attempts from this network. Try again in 15 minutes.' }, 429);
  }
  const user = await env.DB.prepare('SELECT id, first_name, web_username, password_salt, password_hash FROM users WHERE web_username = ? COLLATE NOCASE AND status = ?')
    .bind(username, 'active').first<{ id: number; first_name: string; web_username: string; password_salt: string | null; password_hash: string | null }>();
  const salt = user?.password_salt || base64url(new Uint8Array(16));
  const candidate = await hashWebPassword(body.password, salt, env.SESSION_SECRET);
  const stored = user?.password_hash ? Uint8Array.from(decodeBase64url(user.password_hash), (character) => character.charCodeAt(0)) : new Uint8Array(32);
  if (!user || !user.password_salt || !user.password_hash || !equalBytes(candidate, stored)) return json({ error: 'Username or PIN did not match.' }, 401);
  const token = await issueSession(user.id, env.SESSION_SECRET, PASSWORD_SESSION_LIFETIME);
  return json({ token, expiresIn: PASSWORD_SESSION_LIFETIME, user: { displayName: user.web_username } });
}

async function storeTelegramContact(message: { chat?: { id?: number }; from?: { id?: number; username?: string; first_name?: string; last_name?: string; language_code?: string }; contact?: { user_id?: number; phone_number?: string; first_name?: string } }, env: Env, origin: string): Promise<void> {
  const telegramId = message.from?.id;
  const phone = message.contact?.phone_number?.trim();
  const language = ['am', 'so', 'om'].includes(message.from?.language_code || '') ? message.from?.language_code as string : 'en';
  if (!env.SESSION_SECRET || !Number.isSafeInteger(telegramId) || telegramId! <= 0 || message.contact?.user_id !== telegramId || !phone || !/^[+\d().\s-]{7,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    const prompts: Record<string, string> = {
      en: 'To register, use the Share contact button in this chat and share your own number.',
      am: 'ለመመዝገብ በዚህ ውይይት ያለውን እውቂያ አጋራ ቁልፍ ተጠቅመው የራስዎን ቁጥር ያጋሩ።',
      so: 'Si aad isu diiwaangeliso, taabo La wadaag xiriirka oo la wadaag lambarkaaga.',
      om: 'Galmaa’uuf, Quunnamtii qoodi jedhu tuqiitii lakkoofsa bilbilaa kee qoodi.',
    };
    if (typeof message.chat?.id === 'number' && env.TELEGRAM_BOT_TOKEN) await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: message.chat.id, text: prompts[language] });
    return;
  }
  const firstName = (message.from?.first_name || message.contact?.first_name || 'Player').slice(0, 128);
  const lastName = message.from?.last_name?.slice(0, 128) || null;
  const username = message.from?.username?.slice(0, 64) || null;
  const user = await env.DB.prepare(`INSERT INTO users (telegram_id, username, first_name, last_name, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username), first_name = excluded.first_name,
    last_name = excluded.last_name, updated_at = CURRENT_TIMESTAMP RETURNING id`).bind(telegramId, username, firstName, lastName, language).first<{ id: number }>();
  if (!user) throw new Error('Could not link Telegram contact');
  const encrypted = await encryptContact(phone, env.SESSION_SECRET);
  await env.DB.prepare(`INSERT INTO user_contacts (user_id, phone_ciphertext, shared_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET phone_ciphertext = excluded.phone_ciphertext, shared_at = CURRENT_TIMESTAMP`).bind(user.id, encrypted).run();
  if (typeof message.chat?.id === 'number' && env.TELEGRAM_BOT_TOKEN) {
    const confirmations: Record<string, string> = {
      en: 'Your contact is linked. Open DIRE BET to choose a web username and 8-digit PIN. No live payments are enabled.',
      am: 'እውቂያዎ ተገናኝቷል። DIRE BET ን ከፍተው የድር የተጠቃሚ ስምና 8 አሃዝ PIN ይምረጡ። ቀጥታ ክፍያዎች የሉም።',
      so: 'Xiriirkaaga waa la xidhay. Fur DIRE BET oo dooro magac web iyo PIN 8-god ah. Lacag-bixin toos ah ma jirto.',
      om: 'Quunnamtiin kee walitti hidhameera. DIRE BET baniitii maqaa weebii fi PIN lakkoofsa 8 filadhu. Kaffaltiin kallattiin hin jiru.',
    };
    await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: confirmations[language],
      reply_markup: { inline_keyboard: [[{ text: 'Set up web login', web_app: { url: `${origin}/?page=account` } }]] },
    });
  }
}

type PaymentProvider = 'telebirr' | 'ebirr';

function paymentProvider(value: unknown): PaymentProvider | null {
  return value === 'telebirr' || value === 'ebirr' ? value : null;
}

function validPaymentPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const phone = value.trim();
  const digits = phone.replace(/\D/g, '');
  return /^[+\d().\s-]{7,24}$/.test(phone) && digits.length >= 9 && digits.length <= 15 ? phone : null;
}

function validRequestAmount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 50 && (value as number) <= 10_000 ? value as number : null;
}

function validIdempotencyKey(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{16,80}$/.test(value) ? value : null;
}

async function decryptContact(value: string, secret: string): Promise<string> {
  const packed = Uint8Array.from(decodeBase64url(value), (character) => character.charCodeAt(0));
  if (packed.byteLength < 29) throw new Error('Encrypted value is invalid.');
  const keyMaterial = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`dire-bet-contact-v1:${secret}`)));
  const key = await crypto.subtle.importKey('raw', ownedBuffer(keyMaterial), { name: 'AES-GCM' }, false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return new TextDecoder().decode(clear);
}

async function recordAdminAudit(env: Env, adminId: number, action: string, entityType: string, entityId: string, before: unknown, after: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (?, 'admin', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), String(adminId), action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)).run();
}

async function publicPaymentSettings(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT provider, account_label, account_number, enabled, minimum_santim, maximum_santim
    FROM payment_settings WHERE provider IN ('telebirr','ebirr') ORDER BY provider`).all<{
      provider: PaymentProvider; account_label: string | null; account_number: string | null; enabled: number; minimum_santim: number | null; maximum_santim: number | null;
    }>();
  return json({ mode: 'demo', providers: result.results.map((row) => ({
    provider: row.provider, accountLabel: row.account_label || '', accountNumber: row.enabled === 1 ? row.account_number || '' : '',
    enabled: row.enabled === 1, minimumAmount: Math.ceil((row.minimum_santim || 5000) / 100), maximumAmount: Math.floor((row.maximum_santim || 1_000_000) / 100),
  })) });
}

async function playerWalletRequests(env: Env, userId: number): Promise<Response> {
  const [deposits, withdrawals] = await Promise.all([
    env.DB.prepare(`SELECT id, provider, amount_santim, provider_reference, status, review_reason, created_at, reviewed_at
      FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).bind(userId).all<{
        id: string; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      }>(),
    env.DB.prepare(`SELECT id, provider, amount_santim, status, review_reason, created_at, reviewed_at
      FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`).bind(userId).all<{
        id: string; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      }>(),
  ]);
  return json({ deposits: deposits.results.map((row) => ({ ...row, amount: row.amount_santim / 100 })), withdrawals: withdrawals.results.map((row) => ({ ...row, amount: row.amount_santim / 100 })) });
}

async function createDemoDeposit(request: Request, env: Env, userId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 3_200_000) return json({ error: 'Receipt must be 2 MB or smaller.' }, 413);
  if (!(await allowRateLimit(env, `wallet:${userId}`, 'deposit-request', 5, 3600))) return json({ error: 'Too many requests. Try again later.' }, 429);
  const input = await request.json().catch(() => null) as { provider?: unknown; amount?: unknown; senderPhone?: unknown; transactionReference?: unknown; receiptData?: unknown; idempotencyKey?: unknown } | null;
  const provider = paymentProvider(input?.provider);
  const amount = validRequestAmount(input?.amount);
  const senderPhone = validPaymentPhone(input?.senderPhone);
  const reference = typeof input?.transactionReference === 'string' ? input.transactionReference.trim() : '';
  const idempotencyKey = validIdempotencyKey(input?.idempotencyKey);
  if (!input || !provider || !amount || !senderPhone || reference.length < 5 || reference.length > 80 || !/^[\p{L}\p{N}._/-]+$/u.test(reference) || !idempotencyKey) return json({ error: 'Check the payment method, whole-birr amount, sender number and transaction reference.' }, 400);
  const settings = await env.DB.prepare('SELECT enabled, minimum_santim, maximum_santim FROM payment_settings WHERE provider = ?').bind(provider).first<{ enabled: number; minimum_santim: number | null; maximum_santim: number | null }>();
  if (!settings || settings.enabled !== 1) return json({ error: 'That demo payment method is not available.' }, 409);
  if (amount * 100 < (settings.minimum_santim || 5000) || amount * 100 > (settings.maximum_santim || 1_000_000)) return json({ error: 'The amount is outside the configured request range.' }, 400);
  const old = await env.DB.prepare('SELECT id, user_id, status FROM deposit_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; user_id: number; status: string }>();
  if (old) return old.user_id === userId ? json({ requestId: old.id, status: old.status, repeated: true }) : json({ error: 'Request key was already used.' }, 409);
  let receiptType: 'image/png' | 'image/jpeg' | null = null;
  let receiptBase64: string | null = null;
  if (input.receiptData !== undefined && input.receiptData !== null && input.receiptData !== '') {
    if (typeof input.receiptData !== 'string' || input.receiptData.length > 2_850_000) return json({ error: 'Receipt must be a PNG or JPG no larger than 2 MB.' }, 413);
    const match = input.receiptData.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return json({ error: 'Choose a PNG or JPG receipt.' }, 400);
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    const png = bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    const jpeg = bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (bytes.byteLength > 2 * 1024 * 1024 || !(png || jpeg)) return json({ error: 'Choose a valid PNG or JPG up to 2 MB.' }, 400);
    receiptType = png ? 'image/png' : 'image/jpeg';
    receiptBase64 = match[2];
  }
  const existingRef = await env.DB.prepare('SELECT id FROM deposit_requests WHERE provider = ? AND provider_reference = ?').bind(provider, reference).first();
  if (existingRef) return json({ error: 'That transaction reference was already submitted.' }, 409);
  const id = `DP-${Date.now().toString(36).toUpperCase()}-${randomCode(4)}`;
  const senderCiphertext = await encryptContact(senderPhone, env.SESSION_SECRET || '');
  const statements = [env.DB.prepare(`INSERT INTO deposit_requests
    (id, user_id, wallet_kind, provider, amount_santim, provider_reference, status, idempotency_key, sender_phone_ciphertext)
    VALUES (?, ?, 'demo', ?, ?, ?, 'pending', ?, ?)`)
    .bind(id, userId, provider, amount * 100, reference, idempotencyKey, senderCiphertext)];
  if (receiptBase64 && receiptType) {
    const encryptedReceipt = await encryptContact(receiptBase64, env.SESSION_SECRET || '');
    statements.push(env.DB.prepare(`INSERT INTO receipt_blobs (id, deposit_request_id, content_type, encrypted_blob, retention_until)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), id, receiptType, enc.encode(encryptedReceipt), new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()));
  }
  try { await env.DB.batch(statements); }
  catch { return json({ error: 'That request could not be saved. Check whether its reference was already used.' }, 409); }
  return json({ requestId: id, status: 'pending', demoOnly: true }, 201);
}

async function createDemoWithdrawal(request: Request, env: Env, userId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (!(await allowRateLimit(env, `wallet:${userId}`, 'withdrawal-request', 5, 3600))) return json({ error: 'Too many requests. Try again later.' }, 429);
  const input = await request.json().catch(() => null) as { provider?: unknown; amount?: unknown; destinationPhone?: unknown; accountHolderName?: unknown; idempotencyKey?: unknown } | null;
  const provider = paymentProvider(input?.provider);
  const amount = validRequestAmount(input?.amount);
  const destination = validPaymentPhone(input?.destinationPhone);
  const accountHolder = typeof input?.accountHolderName === 'string' ? input.accountHolderName.trim() : '';
  const idempotencyKey = validIdempotencyKey(input?.idempotencyKey);
  if (!input || !provider || !amount || !destination || accountHolder.length < 2 || accountHolder.length > 100 || !idempotencyKey) return json({ error: 'Check the payment method, whole-birr amount, phone number and account name.' }, 400);
  const settings = await env.DB.prepare('SELECT enabled, minimum_santim, maximum_santim FROM payment_settings WHERE provider = ?').bind(provider).first<{ enabled: number; minimum_santim: number | null; maximum_santim: number | null }>();
  if (!settings || settings.enabled !== 1) return json({ error: 'That demo withdrawal method is not available.' }, 409);
  if (amount * 100 < (settings.minimum_santim || 5000) || amount * 100 > (settings.maximum_santim || 1_000_000)) return json({ error: 'The amount is outside the configured request range.' }, 400);
  const old = await env.DB.prepare('SELECT id, user_id, status FROM withdrawal_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; user_id: number; status: string }>();
  if (old) return old.user_id === userId ? json({ requestId: old.id, status: old.status, repeated: true }) : json({ error: 'Request key was already used.' }, 409);
  const id = `WD-${Date.now().toString(36).toUpperCase()}-${randomCode(4)}`;
  const phoneCiphertext = await encryptContact(destination, env.SESSION_SECRET || '');
  const nameCiphertext = await encryptContact(accountHolder, env.SESSION_SECRET || '');
  try {
    await env.DB.prepare(`INSERT INTO withdrawal_requests
      (id, user_id, wallet_kind, amount_santim, provider, status, idempotency_key, destination_phone_ciphertext, account_holder_ciphertext)
      VALUES (?, ?, 'demo', ?, ?, 'pending', ?, ?, ?)`)
      .bind(id, userId, amount * 100, provider, idempotencyKey, phoneCiphertext, nameCiphertext).run();
  } catch { return json({ error: 'That request could not be saved. Try again.' }, 409); }
  return json({ requestId: id, status: 'pending', demoOnly: true }, 201);
}

async function adminWalletList(env: Env, adminId: number, kind: 'deposits' | 'withdrawals'): Promise<Response> {
  if (kind === 'deposits') {
    const rows = await env.DB.prepare(`SELECT d.id, d.user_id, d.provider, d.amount_santim, d.provider_reference, d.status, d.review_reason, d.created_at, d.reviewed_at,
      u.first_name, u.username, u.web_username, EXISTS(SELECT 1 FROM receipt_blobs b WHERE b.deposit_request_id = d.id) AS has_receipt
      FROM deposit_requests d JOIN users u ON u.id = d.user_id ORDER BY d.created_at DESC LIMIT 100`).all<{
        id: string; user_id: number; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
        first_name: string; username: string | null; web_username: string | null; has_receipt: number;
      }>();
    const details = await Promise.all(rows.results.map(async (row) => {
      const phone = await env.DB.prepare('SELECT sender_phone_ciphertext FROM deposit_requests WHERE id = ?').bind(row.id).first<{ sender_phone_ciphertext: string | null }>();
      let senderPhone = '';
      try { if (phone?.sender_phone_ciphertext) senderPhone = await decryptContact(phone.sender_phone_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
      return { ...row, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, senderPhone };
    }));
    return json({ requests: details, count: details.length });
  }
  const rows = await env.DB.prepare(`SELECT w.id, w.user_id, w.provider, w.amount_santim, w.status, w.review_reason, w.created_at, w.reviewed_at,
    u.first_name, u.username, u.web_username FROM withdrawal_requests w JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT 100`).all<{
      id: string; user_id: number; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      first_name: string; username: string | null; web_username: string | null;
    }>();
  const details = await Promise.all(rows.results.map(async (row) => {
    const protectedFields = await env.DB.prepare('SELECT destination_phone_ciphertext, account_holder_ciphertext FROM withdrawal_requests WHERE id = ?').bind(row.id).first<{ destination_phone_ciphertext: string | null; account_holder_ciphertext: string | null }>();
    let destinationPhone = ''; let accountHolderName = '';
    try { if (protectedFields?.destination_phone_ciphertext) destinationPhone = await decryptContact(protectedFields.destination_phone_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
    try { if (protectedFields?.account_holder_ciphertext) accountHolderName = await decryptContact(protectedFields.account_holder_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
    return { ...row, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, destinationPhone, accountHolderName };
  }));
  return json({ requests: details, count: details.length });
}

async function reviewWalletRequest(request: Request, env: Env, adminId: number, kind: 'deposits' | 'withdrawals', id: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { status?: unknown; reason?: unknown } | null;
  const allowed = kind === 'deposits' ? ['needs_info', 'approved', 'rejected'] : ['reviewing', 'approved', 'rejected'];
  if (!input || typeof input.status !== 'string' || !allowed.includes(input.status)) return json({ error: 'That review action is not available in demo mode.' }, 400);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if ((input.status === 'needs_info' || input.status === 'rejected') && reason.length < 3) return json({ error: 'Add a short note for this request.' }, 400);
  const table = kind === 'deposits' ? 'deposit_requests' : 'withdrawal_requests';
  const old = await env.DB.prepare(`SELECT status FROM ${table} WHERE id = ?`).bind(id).first<{ status: string }>();
  if (!old) return json({ error: 'Request not found.' }, 404);
  const result = await env.DB.prepare(`UPDATE ${table} SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('pending','needs_info','reviewing')`)
    .bind(input.status, reason || null, String(adminId), id).run();
  if (!result.meta.changes) return json({ error: 'This request has already been reviewed.' }, 409);
  await recordAdminAudit(env, adminId, `WALLET_${kind.toUpperCase()}_${String(input.status).toUpperCase()}`, `${kind.slice(0, -1)}_request`, id, { status: old.status }, { status: input.status, reason: reason || null, balanceChanged: false });
  return json({ ok: true, status: input.status, balanceChanged: false });
}

async function adminPaymentSettings(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT provider, account_label, account_number, enabled, minimum_santim, maximum_santim, updated_at
    FROM payment_settings WHERE provider IN ('telebirr','ebirr') ORDER BY provider`).all<{
      provider: PaymentProvider; account_label: string | null; account_number: string | null; enabled: number; minimum_santim: number | null; maximum_santim: number | null; updated_at: string;
    }>();
  return json({ providers: result.results.map((row) => ({ provider: row.provider, accountLabel: row.account_label || '', accountNumber: row.account_number || '', enabled: row.enabled === 1, minimumAmount: Math.ceil((row.minimum_santim || 5000) / 100), maximumAmount: Math.floor((row.maximum_santim || 1_000_000) / 100), updatedAt: row.updated_at })) });
}

async function updateAdminPaymentSettings(request: Request, env: Env, adminId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { providers?: unknown } | null;
  if (!input || !Array.isArray(input.providers) || input.providers.length !== 2) return json({ error: 'Update Telebirr and eBirr settings together.' }, 400);
  const parsed = input.providers.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as { provider?: unknown; accountLabel?: unknown; accountNumber?: unknown; enabled?: unknown };
    const provider = paymentProvider(row.provider);
    const label = typeof row.accountLabel === 'string' ? row.accountLabel.trim() : '';
    const number = validPaymentPhone(row.accountNumber);
    if (!provider || label.length > 100 || !number || typeof row.enabled !== 'boolean') return null;
    return { provider, label, number, enabled: row.enabled };
  });
  if (parsed.some((item) => item === null) || new Set(parsed.map((item) => item?.provider)).size !== 2) return json({ error: 'Check both account names, numbers and enabled switches.' }, 400);
  const before = await adminPaymentSettings(env);
  const beforeData = await before.json() as { providers: unknown[] };
  const statements = parsed.map((row) => env.DB.prepare(`UPDATE payment_settings SET account_label = ?, account_number = ?, enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE provider = ?`)
    .bind(row!.label || null, row!.number, row!.enabled ? 1 : 0, String(adminId), row!.provider));
  await env.DB.batch(statements);
  await recordAdminAudit(env, adminId, 'PAYMENT_SETTINGS_CHANGED', 'payment_settings', 'telebirr,ebirr', beforeData.providers, parsed.map((row) => ({ provider: row!.provider, accountLabel: row!.label, accountNumber: 'updated', enabled: row!.enabled })));
  return adminPaymentSettings(env);
}

async function adminAgents(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT a.id, a.user_id, a.referral_code, a.status, a.created_at, u.telegram_id, u.first_name, u.username, u.web_username,
    (SELECT COUNT(*) FROM referrals r WHERE r.agent_id = a.id) AS referrals FROM agents a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200`).all<{
      id: string; user_id: number | null; referral_code: string; status: string; created_at: string; telegram_id: number | null; first_name: string | null; username: string | null; web_username: string | null; referrals: number;
    }>();
  return json({ agents: result.results.map((row) => ({ id: row.id, userId: row.user_id, telegramId: row.telegram_id, name: row.web_username || row.username || row.first_name || 'Unlinked account', code: row.referral_code, status: row.status, referrals: row.referrals, createdAt: row.created_at, commissionRate: 5, commissionBasis: 'weekly net demo-credit losses' })) });
}

async function createAdminAgent(request: Request, env: Env, adminId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { telegramId?: unknown; code?: unknown } | null;
  const telegramId = input?.telegramId;
  let code = typeof input?.code === 'string' && input.code.trim() ? input.code.trim().toUpperCase() : `DB${randomCode(8)}`;
  if (!Number.isSafeInteger(telegramId) || (telegramId as number) <= 0 || !/^[A-Z0-9]{4,16}$/.test(code)) return json({ error: 'Enter the agent’s numeric Telegram ID and a 4–16 character code.' }, 400);
  const user = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ? AND status = ?').bind(telegramId, 'active').first<{ id: number }>();
  if (!user) return json({ error: 'That Telegram account must open DIRE BET once before it can be added as an agent.' }, 404);
  if (user.id === adminId) return json({ error: 'The Super Admin cannot also be an agent.' }, 409);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO agents (id, user_id, referral_code, status, commission_rule_json, created_by)
      VALUES (?, ?, ?, 'active', ?, ?)`)
      .bind(id, user.id, code, JSON.stringify({ rateBps: 500, basis: 'weekly_net_demo_loss', version: 'weekly-loss-demo-v1' }), String(adminId)).run();
  } catch { return json({ error: 'That user or promo code is already assigned.' }, 409); }
  await recordAdminAudit(env, adminId, 'AGENT_CREATED', 'agent', id, null, { userId: user.id, code, status: 'active', commissionRateBps: 500, commissionBasis: 'weekly_net_demo_loss' });
  return json({ agent: { id, userId: user.id, telegramId, code, status: 'active', commissionRate: 5 } }, 201);
}

async function changeAdminAgent(request: Request, env: Env, adminId: number, agentId: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { status?: unknown } | null;
  if (!input || !['active', 'suspended', 'revoked'].includes(String(input.status))) return json({ error: 'Choose active, suspended or revoked.' }, 400);
  const old = await env.DB.prepare('SELECT id, status, referral_code FROM agents WHERE id = ?').bind(agentId).first<{ id: string; status: string; referral_code: string }>();
  if (!old) return json({ error: 'Agent not found.' }, 404);
  await env.DB.prepare('UPDATE agents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(input.status, agentId).run();
  await recordAdminAudit(env, adminId, input.status === 'revoked' ? 'AGENT_REVOKED' : `AGENT_${String(input.status).toUpperCase()}`, 'agent', agentId, { status: old.status }, { status: input.status });
  return json({ ok: true, status: input.status });
}

async function claimAgentReferral(request: Request, env: Env, userId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof input?.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4,16}$/.test(code)) return json({ error: 'Enter a valid agent promo code.' }, 400);
  const agent = await env.DB.prepare(`SELECT id, user_id FROM agents WHERE referral_code = ? COLLATE NOCASE AND status = 'active'`).bind(code).first<{ id: string; user_id: number | null }>();
  if (!agent) return json({ error: 'That promo code is unavailable.' }, 404);
  if (agent.user_id === userId) return json({ error: 'You cannot use your own promo code.' }, 409);
  const existing = await env.DB.prepare('SELECT source_code FROM referrals WHERE referred_user_id = ?').bind(userId).first<{ source_code: string }>();
  if (existing) return existing.source_code.toUpperCase() === code ? json({ ok: true, alreadyApplied: true }) : json({ error: 'A promo code is already linked to this account.' }, 409);
  try {
    await env.DB.prepare(`INSERT INTO referrals (id, referred_user_id, agent_id, source_code) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), userId, agent.id, code).run();
  } catch { return json({ error: 'That promo code could not be applied.' }, 409); }
  return json({ ok: true });
}

async function agentDashboard(env: Env, userId: number): Promise<Response> {
  const agent = await env.DB.prepare(`SELECT id, referral_code, status FROM agents WHERE user_id = ?`).bind(userId).first<{ id: string; referral_code: string; status: string }>();
  if (!agent || agent.status !== 'active') return json({ error: agent ? 'Agent access is suspended.' : 'This Telegram account is not an active agent.' }, 403);
  const result = await env.DB.prepare(`SELECT week_start,
    SUM(CASE WHEN net_loss_santim > 0 THEN CAST(net_loss_santim * 500 / 10000 AS INTEGER) ELSE 0 END) AS commission_santim,
    SUM(CASE WHEN net_loss_santim > 0 THEN net_loss_santim ELSE 0 END) AS referred_net_loss_santim,
    SUM(CASE WHEN net_loss_santim > 0 THEN 1 ELSE 0 END) AS referred_players FROM (
      SELECT week_start, referred_user_id, SUM(net_result_santim) AS net_loss_santim
      FROM agent_weekly_activity WHERE agent_id = ? GROUP BY week_start, referred_user_id
    ) GROUP BY week_start HAVING referred_net_loss_santim > 0 ORDER BY week_start DESC LIMIT 12`).bind(agent.id).all<{ week_start: string; commission_santim: number; referred_net_loss_santim: number; referred_players: number }>();
  const referrals = await env.DB.prepare(`SELECT u.first_name, u.username, u.web_username, r.created_at,
    (SELECT COUNT(DISTINCT a.match_id) FROM agent_weekly_activity a WHERE a.agent_id = r.agent_id AND a.referred_user_id = r.referred_user_id) AS completed_matches
    FROM referrals r JOIN users u ON u.id = r.referred_user_id WHERE r.agent_id = ? ORDER BY r.created_at DESC LIMIT 100`).bind(agent.id).all<{ first_name: string; username: string | null; web_username: string | null; created_at: string; completed_matches: number }>();
  return json({ agent: { code: agent.referral_code, status: agent.status, commissionRate: 5, basis: '5% of each referred player’s positive net loss for the week, using completed demo-credit matches only' },
    shareLink: `https://t.me/${encodeURIComponent('Dire_Bet_bot')}?start=agent_${agent.referral_code}`,
    weeks: result.results.map((row) => ({ weekStart: row.week_start, simulatedCommissionCredits: row.commission_santim / 100, referredNetLossCredits: row.referred_net_loss_santim / 100, referredPlayers: row.referred_players })),
    referrals: referrals.results.map((row) => ({ name: row.web_username || (row.username ? `@${row.username}` : row.first_name), joinedAt: row.created_at, completedMatches: row.completed_matches })) });
}

async function handleWalletAndStaff(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/wallet/settings' && request.method === 'GET') return publicPaymentSettings(env);
  if (url.pathname.startsWith('/api/wallet/')) {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ error: 'Sign in through Telegram or your web account to continue.' }, 401);
    if (url.pathname === '/api/wallet/requests' && request.method === 'GET') return playerWalletRequests(env, userId);
    if (url.pathname === '/api/wallet/deposits' && request.method === 'POST') return createDemoDeposit(request, env, userId);
    if (url.pathname === '/api/wallet/withdrawals' && request.method === 'POST') return createDemoWithdrawal(request, env, userId);
  }
  if (url.pathname === '/api/referrals/claim' && request.method === 'POST') {
    const userId = await readSession(request, env.SESSION_SECRET);
    return userId ? claimAgentReferral(request, env, userId) : json({ error: 'Sign in before applying a promo code.' }, 401);
  }
  if (url.pathname === '/api/agent/dashboard' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    return userId ? agentDashboard(env, userId) : json({ error: 'Sign in with the agent Telegram account.' }, 401);
  }
  if (url.pathname.startsWith('/api/admin/identity') || url.pathname.startsWith('/api/admin/wallet') || url.pathname.startsWith('/api/admin/agents')) {
    const adminId = await superAdmin(request, env);
    if (adminId instanceof Response) return adminId;
    if (url.pathname === '/api/admin/identity' && request.method === 'GET') return json({ isSuperAdmin: true });
    if (url.pathname === '/api/admin/wallet/settings' && request.method === 'GET') return adminPaymentSettings(env);
    if (url.pathname === '/api/admin/wallet/settings' && request.method === 'PUT') return updateAdminPaymentSettings(request, env, adminId);
    if (url.pathname === '/api/admin/wallet/deposits' && request.method === 'GET') return adminWalletList(env, adminId, 'deposits');
    if (url.pathname === '/api/admin/wallet/withdrawals' && request.method === 'GET') return adminWalletList(env, adminId, 'withdrawals');
    const detail = url.pathname.match(/^\/api\/admin\/wallet\/(deposits|withdrawals)\/([A-Za-z0-9-]+)$/);
    if (detail && request.method === 'GET') {
      const table = detail[1] === 'deposits' ? 'deposit_requests' : 'withdrawal_requests';
      if (detail[1] === 'deposits') {
        const row = await env.DB.prepare(`SELECT d.id, d.user_id, d.provider, d.amount_santim, d.provider_reference, d.status, d.review_reason, d.created_at, d.reviewed_at,
          u.first_name, u.username, u.web_username, d.sender_phone_ciphertext FROM deposit_requests d JOIN users u ON u.id = d.user_id WHERE d.id = ?`).bind(detail[2]).first<{
            id: string; user_id: number; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
            first_name: string; username: string | null; web_username: string | null; sender_phone_ciphertext: string | null;
          }>();
        if (!row) return json({ error: 'Request not found.' }, 404);
        const { sender_phone_ciphertext: senderPhoneCiphertext, ...safeRow } = row;
        const blob = await env.DB.prepare('SELECT content_type, encrypted_blob FROM receipt_blobs WHERE deposit_request_id = ?').bind(row.id).first<{ content_type: 'image/png' | 'image/jpeg'; encrypted_blob: ArrayBuffer }>();
        let senderPhone = ''; let receiptData = '';
        try { if (senderPhoneCiphertext) senderPhone = await decryptContact(senderPhoneCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
        try {
          if (blob) {
            const bytes = blob.encrypted_blob instanceof Uint8Array ? blob.encrypted_blob : new Uint8Array(blob.encrypted_blob);
            const encrypted = new TextDecoder().decode(bytes);
            receiptData = `data:${blob.content_type};base64,${await decryptContact(encrypted, env.SESSION_SECRET || '')}`;
          }
        } catch { /* Leave the receipt unavailable rather than exposing encrypted bytes. */ }
        return json({ request: { ...safeRow, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, senderPhone, receiptData } });
      }
      const row = await env.DB.prepare(`SELECT w.id, w.user_id, w.provider, w.amount_santim, w.status, w.review_reason, w.created_at, w.reviewed_at,
        w.destination_phone_ciphertext, w.account_holder_ciphertext, u.first_name, u.username, u.web_username
        FROM withdrawal_requests w JOIN users u ON u.id = w.user_id WHERE w.id = ?`).bind(detail[2]).first<{
          id: string; user_id: number; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
          destination_phone_ciphertext: string | null; account_holder_ciphertext: string | null; first_name: string; username: string | null; web_username: string | null;
        }>();
      if (!row) return json({ error: 'Request not found.' }, 404);
      const { destination_phone_ciphertext: destinationPhoneCiphertext, account_holder_ciphertext: accountHolderCiphertext, ...safeRow } = row;
      let destinationPhone = ''; let accountHolderName = '';
      try { if (destinationPhoneCiphertext) destinationPhone = await decryptContact(destinationPhoneCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
      try { if (accountHolderCiphertext) accountHolderName = await decryptContact(accountHolderCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
      return json({ request: { ...safeRow, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, destinationPhone, accountHolderName } });
    }
    const review = url.pathname.match(/^\/api\/admin\/wallet\/(deposits|withdrawals)\/([A-Za-z0-9-]+)$/);
    if (review && request.method === 'PATCH') return reviewWalletRequest(request, env, adminId, review[1] as 'deposits' | 'withdrawals', review[2]);
    if (url.pathname === '/api/admin/agents' && request.method === 'GET') return adminAgents(env);
    if (url.pathname === '/api/admin/agents' && request.method === 'POST') return createAdminAgent(request, env, adminId);
    const agent = url.pathname.match(/^\/api\/admin\/agents\/([A-Za-z0-9-]+)$/);
    if (agent && request.method === 'PATCH') return changeAdminAgent(request, env, adminId, agent[1]);
    if (agent && request.method === 'DELETE') return changeAdminAgent(new Request(request, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) }), env, adminId, agent[1]);
    if (url.pathname.startsWith('/api/admin/wallet') || url.pathname.startsWith('/api/admin/agents')) return json({ error: 'Admin wallet route not found.' }, 404);
  }
  return null;
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: securityHeaders });
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, mode: 'demo', realMoneyAvailable: await moneyActivationRecorded(env) });
  }
  if (url.pathname === '/api/games' && request.method === 'GET') {
    return json({ games: PUBLIC_GAMES, liveMoney: false });
  }
  if (url.pathname === '/api/auth/telegram' && request.method === 'POST') return authenticate(request, env);
  if (url.pathname === '/api/auth/password' && request.method === 'POST') return authenticatePassword(request, env);
  if (url.pathname === '/api/account/web-login' && request.method === 'POST') return setWebLogin(request, env);
  if (url.pathname === '/api/me' && request.method === 'GET') {
    const id = await readSession(request, env.SESSION_SECRET);
    if (!id) return json({ error: 'Authentication required' }, 401);
    const user = await env.DB.prepare(`SELECT id, first_name, web_username, language,
      EXISTS(SELECT 1 FROM user_contacts WHERE user_id = users.id) AS phone_shared FROM users WHERE id = ?`).bind(id).first<{ id: number; first_name: string; web_username: string | null; language: string; phone_shared: number }>();
    return user ? json({ user: { displayName: user.web_username || user.first_name, webUsername: user.web_username, phoneShared: user.phone_shared === 1, telegramLinked: true, language: user.language } }) : json({ error: 'Session is no longer valid' }, 401);
  }
  const walletStaffResponse = await handleWalletAndStaff(request, env);
  if (walletStaffResponse) return walletStaffResponse;
  const publicMarketplaceResponse = await handlePublicMarketplace(request, env);
  if (publicMarketplaceResponse) return publicMarketplaceResponse;
  if (url.pathname === '/api/rooms' && request.method === 'POST') return createRoom(request, env);
  const join = url.pathname.match(/^\/api\/rooms\/([23456789A-HJ-NP-Z]{6})\/join$/i);
  if (join && request.method === 'POST') return joinRoom(request, env, join[1]);
  if (url.pathname === '/api/ws-ticket' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    let body: { code?: unknown };
    try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request' }, 400); }
    if (typeof body.code !== 'string') return json({ error: 'Room code is required.' }, 400);
    return joinRoom(request, env, body.code);
  }
  if (url.pathname.startsWith('/api/money') || url.pathname.startsWith('/api/deposit') || url.pathname.startsWith('/api/withdraw')) {
    return (await moneyActivationRecorded(env))
      ? json({ error: 'Provider-approved money flows are not implemented' }, 503)
      : json({ error: 'Live funds are disabled pending verified approvals' }, 403);
  }
  const roomSocket = url.pathname.match(/^\/ws\/room\/([23456789A-HJ-NP-Z]{6})$/i);
  if (roomSocket && request.method === 'GET') return connectRoom(request, env, roomSocket[1].toUpperCase());
  if (url.pathname === '/ws/public-rooms' && request.method === 'GET') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    const gameId = url.searchParams.get('gameId') || '';
    if (!isMarketplaceGame(gameId)) return json({ error: 'Game filter is invalid.' }, 400);
    const headers = new Headers(request.headers);
    headers.delete('X-Market-User');
    const ticketValue = url.searchParams.get('ticket');
    if (ticketValue) {
      const ticket = await readRoomTicket(ticketValue, env.SESSION_SECRET);
      if (!ticket || ticket.code !== 'MARKET') return json({ error: 'Room list connection ticket is invalid or expired.' }, 401);
      headers.set('X-Market-User', String(ticket.userId));
    }
    const marketRequest = new Request(`https://market/connect?gameId=${encodeURIComponent(gameId)}`, { method: 'GET', headers });
    return publicMarketplace(env).fetch(marketRequest);
  }
  if (url.pathname === '/telegram/webhook' && request.method === 'POST') return handleTelegramWebhook(request, env);
  if (url.pathname === '/telegram/setup' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    return setupTelegram(request, env);
  }
  if (url.pathname.startsWith('/ws/')) return json({ error: 'Room not found.' }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handleRequest(request, env); }
    catch { return json({ error: 'Service temporarily unavailable' }, 503); }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run().then(() => undefined).catch(() => undefined));
    ctx.waitUntil(publicMarketplace(env).fetch('https://market/reconcile', { method: 'POST' }).then(() => undefined).catch(() => undefined));
  },
};

export class GameRoom {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/create' && request.method === 'POST') {
      const existing = await this.state.storage.get<StoredRoom>('room');
      if (existing) return json({ error: 'Room code is already in use.' }, 409);
      let input: { code?: unknown; gameId?: unknown; userId?: unknown; displayName?: unknown; expiresAt?: unknown; publicRoomId?: unknown; publicRoomOptions?: unknown; entryCredits?: unknown; commissionBps?: unknown };
      try { input = await request.json() as typeof input; } catch { return json({ error: 'Invalid room request.' }, 400); }
      if (typeof input.code !== 'string' || (input.gameId !== 'xo' && input.gameId !== 'ludo' && input.gameId !== 'dominoes' && input.gameId !== 'poker') || !Number.isSafeInteger(input.userId) || typeof input.displayName !== 'string' || !Number.isSafeInteger(input.expiresAt)) return json({ error: 'Invalid room request.' }, 400);
      const room: StoredRoom = { code: input.code, gameId: input.gameId, hostId: input.userId as number, status: 'waiting', players: [{ id: input.userId as number, name: input.displayName.slice(0, 32), mark: null, online: false }], game: createGame(input.gameId), matchId: null, sequence: 0, expiresAt: input.expiresAt as number,
        ...(typeof input.publicRoomId === 'string' ? { publicRoomId: input.publicRoomId } : {}),
        ...(input.publicRoomOptions && typeof input.publicRoomOptions === 'object' ? { publicRoomOptions: input.publicRoomOptions as Record<string, unknown> } : {}),
        ...(Number.isSafeInteger(input.entryCredits) ? { entryCredits: input.entryCredits as number } : {}),
        ...(Number.isSafeInteger(input.commissionBps) ? { commissionBps: input.commissionBps as number } : {}) };
      await this.state.storage.put('room', room);
      await this.state.storage.setAlarm(room.expiresAt);
      return json({ ok: true });
    }
    if (path === '/cancel-public' && request.method === 'POST') {
      const room = await this.state.storage.get<StoredRoom>('room');
      if (!room || !room.publicRoomId) return json({ error: 'Public room not found.' }, 404);
      if (room.status === 'cancelled' || room.status === 'finished') return json({ ok: true });
      room.status = 'cancelled';
      await this.state.storage.put('room', room);
      await this.state.storage.deleteAlarm();
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE game_rooms SET status = 'cancelled' WHERE id = ? AND status IN ('waiting','active')").bind(room.code),
        this.env.DB.prepare("UPDATE matches SET status = 'voided', ended_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(room.matchId),
        this.env.DB.prepare("UPDATE match_players SET result = 'void' WHERE match_id = ? AND result IS NULL").bind(room.matchId),
      ]);
      this.broadcast(room);
      return json({ ok: true });
    }
    if (path === '/join' && request.method === 'POST') return this.joinRoom(request);
    if (path === '/connect' && request.method === 'GET') return this.connect(request);
    return json({ error: 'Room route not found.' }, 404);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as { userId?: number } | null;
    const userId = attachment?.userId;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (!userId || text.length > 512) return this.sendError(socket, 'Move could not be read.');
    let input: { type?: unknown; index?: unknown; token?: unknown; action?: unknown };
    try { input = JSON.parse(text) as typeof input; } catch { return this.sendError(socket, 'Move could not be read.'); }
    if (typeof input.type !== 'string') return this.sendError(socket, 'Move is not allowed.');
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room || room.status !== 'active' || !room.matchId) return this.sendError(socket, 'This room is not active.');
    const player = room.players.find((entry) => entry.id === userId);
    const playerIndex = room.players.findIndex((entry) => entry.id === userId);
    if (!player || playerIndex < 0) return this.sendError(socket, 'You are not seated in this room.');
    if (input.type !== 'next-round' && gameTurn(room) !== playerIndex) return this.sendError(socket, 'Please wait for your turn.');
    const previous = room.game;
    try {
      if (room.gameId === 'xo' && input.type === 'move' && Number.isInteger(input.index) && player.mark) room.game = applyXO(room.game as XOState, player.mark, input.index as number);
      else if (room.gameId === 'ludo' && input.type === 'roll') room.game = rollLudo(room.game as LudoState, secureInt(1, 6));
      else if (room.gameId === 'ludo' && input.type === 'move' && Number.isInteger(input.token)) room.game = moveLudo(room.game as LudoState, input.token as number);
      else if (room.gameId === 'dominoes' && input.type === 'action' && input.action && typeof input.action === 'object') room.game = applyDominoAction(room.game as DominoesState, input.action as DominoAction);
      else if (room.gameId === 'dominoes' && input.type === 'next-round') room.game = nextDominoesRound(room.game as DominoesState, secureRandom);
      else if (room.gameId === 'poker' && input.type === 'action' && input.action && typeof input.action === 'object') room.game = applyPokerAction(room.game as PokerState, playerIndex as 0 | 1, input.action as PokerAction);
      else return this.sendError(socket, 'Move is not allowed for this game.');
    } catch { return this.sendError(socket, 'That move is not allowed.'); }
    room.sequence++;
    const completion = gameComplete(room);
    if (completion.done) room.status = 'finished';
    try {
      await this.recordMove(room, player.id, { type: input.type, ...(Number.isInteger(input.index) ? { index: input.index } : {}), ...(Number.isInteger(input.token) ? { token: input.token } : {}), ...(input.action && typeof input.action === 'object' ? { action: input.action } : {}) }, completion.winner);
      await this.state.storage.put('room', room);
    } catch {
      room.game = previous;
      room.sequence--;
      room.status = 'active';
      return this.sendError(socket, 'Move could not be saved. Please try again.');
    }
    this.broadcast(room);
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.disconnect(socket); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.disconnect(socket); }

  async alarm(): Promise<void> {
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room) return;
    if (room.status === 'waiting' && room.expiresAt <= Date.now()) {
      room.status = 'cancelled';
      await this.state.storage.put('room', room);
      await this.env.DB.prepare("UPDATE game_rooms SET status = 'cancelled' WHERE id = ? AND status = 'waiting'").bind(room.code).run();
      this.broadcast(room);
      return;
    }
    if (room.status === 'active' && room.players.some((player) => !player.online)) {
      room.status = 'cancelled';
      await this.state.storage.put('room', room);
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE game_rooms SET status = 'cancelled' WHERE id = ?").bind(room.code),
        this.env.DB.prepare("UPDATE matches SET status = 'voided', ended_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'").bind(room.matchId),
        this.env.DB.prepare("UPDATE match_players SET result = 'void' WHERE match_id = ? AND result IS NULL").bind(room.matchId),
      ]);
      if (room.publicRoomId && room.matchId) {
        const market = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('public-room-marketplace'));
        await market.fetch('https://market/void', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code, matchId: room.matchId }) }).catch(() => undefined);
      }
      this.broadcast(room);
    }
  }

  private async joinRoom(request: Request): Promise<Response> {
    let input: { code?: unknown; userId?: unknown; displayName?: unknown };
    try { input = await request.json() as typeof input; } catch { return json({ error: 'Invalid room request.' }, 400); }
    if (typeof input.code !== 'string' || !Number.isSafeInteger(input.userId) || typeof input.displayName !== 'string') return json({ error: 'Invalid room request.' }, 400);
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room || room.code !== input.code) return json({ error: 'Room not found or expired.' }, 404);
    const userId = input.userId as number;
    const existing = room.players.find((player) => player.id === userId);
    if (existing) return json({ mark: existing.mark, status: room.status });
    if (room.status !== 'waiting' || room.players.length >= 2) return json({ error: 'Room is already full.' }, 409);
    if (room.hostId === userId) return json({ error: 'Join from the other player’s account.' }, 409);
    const hostMark: Mark = secureInt(0, 1) ? 'X' : 'O';
    room.players[0].mark = room.gameId === 'xo' ? hostMark : null;
    room.players.push({ id: userId, name: (input.displayName as string).slice(0, 32), mark: room.gameId === 'xo' ? (hostMark === 'X' ? 'O' : 'X') : null, online: false });
    room.game = room.gameId === 'xo' ? initXO(room.players.find((player) => player.mark === 'X')?.mark || 'X') : createGame(room.gameId);
    room.status = 'active';
    room.matchId = `${room.gameId}-${room.code}`;
    room.sequence = 0;
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE game_rooms SET status = 'active' WHERE id = ? AND status = 'waiting'").bind(room.code),
      this.env.DB.prepare("INSERT INTO matches (id, room_id, game_id, status, bot_match) VALUES (?, ?, ?, 'active', 0)").bind(room.matchId, room.code, room.gameId),
      ...room.players.map((player, seat) => this.env.DB.prepare('INSERT INTO match_players (match_id, user_id, seat) VALUES (?, ?, ?)').bind(room.matchId, player.id, seat)),
    ]);
    await this.state.storage.put('room', room);
    await this.state.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    this.broadcast(room);
    return json({ mark: room.players[1].mark, status: room.status });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
    const userId = Number(request.headers.get('X-Game-User'));
    const name = request.headers.get('X-Game-Name') || '';
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room || !Number.isSafeInteger(userId) || !room.players.some((player) => player.id === userId)) return json({ error: 'You are not seated in this room.' }, 403);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ userId, name: name.slice(0, 32) });
    this.state.acceptWebSocket(server);
    const seat = room.players.find((player) => player.id === userId)!;
    seat.online = true;
    await this.state.storage.put('room', room);
    if (room.status === 'waiting' || room.players.some((player) => !player.online)) await this.state.storage.setAlarm(room.status === 'waiting' ? room.expiresAt : Date.now() + RECONNECT_GRACE_MS);
    else await this.state.storage.deleteAlarm();
    this.broadcast(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async disconnect(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as { userId?: number } | null;
    if (!attachment?.userId) return;
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room) return;
    const stillConnected = this.state.getWebSockets().some((candidate) => (candidate.deserializeAttachment() as { userId?: number } | null)?.userId === attachment.userId);
    const player = room.players.find((entry) => entry.id === attachment.userId);
    if (player) player.online = stillConnected;
    await this.state.storage.put('room', room);
    if (!stillConnected && room.status === 'active') await this.state.storage.setAlarm(Date.now() + RECONNECT_GRACE_MS);
    this.broadcast(room);
  }

  private async recordMove(room: StoredRoom, userId: number, action: unknown, winner: number | 'draw' | null): Promise<void> {
    if (!room.matchId) return;
    const stateText = JSON.stringify(room.game);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(stateText)));
    const stateHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const event = this.env.DB.prepare('INSERT INTO match_events (match_id, sequence, actor_user_id, event_type, payload_json, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(room.matchId, room.sequence, userId, 'action', JSON.stringify({ action, state: roomAuditView(room) }), stateHash);
    const statements = [event];
    if (room.status === 'finished' && winner !== null) {
      const result = winner === 'draw' ? [ 'draw', 'draw' ] : room.players.map((_player, seat) => seat === winner ? 'win' : 'loss');
      statements.push(this.env.DB.prepare("UPDATE matches SET status = 'completed', ended_at = CURRENT_TIMESTAMP, result_json = ? WHERE id = ?")
        .bind(JSON.stringify({ winner, gameId: room.gameId }), room.matchId));
      statements.push(...room.players.map((player, seat) => this.env.DB.prepare('UPDATE match_players SET result = ? WHERE match_id = ? AND seat = ?').bind(result[seat], room.matchId, seat)));
      statements.push(this.env.DB.prepare("UPDATE game_rooms SET status = 'finished' WHERE id = ?").bind(room.code));
    }
    await this.env.DB.batch(statements);
    if (room.status === 'finished' && room.publicRoomId && room.matchId) {
      const market = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('public-room-marketplace'));
      await market.fetch('https://market/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: room.code, matchId: room.matchId }) }).catch(() => undefined);
    }
  }

  private broadcast(room: StoredRoom): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { userId?: number } | null;
      const seat = room.players.findIndex((player) => player.id === attachment?.userId);
      let game: unknown = room.game;
      if (room.gameId === 'dominoes' && seat >= 0) game = viewDominoes(room.game as DominoesState, seat as 0 | 1);
      if (room.gameId === 'poker' && seat >= 0) game = viewPoker(room.game as PokerState, seat as 0 | 1);
      try { socket.send(JSON.stringify({ type: 'state', code: room.code, gameId: room.gameId, status: room.status, players: room.players, game, you: room.players[seat]?.mark || null, seat,
        ...(room.publicRoomId ? { publicRoom: { id: room.publicRoomId, entryCredits: room.entryCredits || 0, commissionBps: room.commissionBps || 0, options: room.publicRoomOptions || {} } } : {}) })); }
      catch { socket.close(1011, 'Unable to send room update'); }
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    try { socket.send(JSON.stringify({ type: 'error', error: message })); } catch { socket.close(1011, 'Unable to send room error'); }
  }
}

export { Matchmaker };

export class Presence {
  constructor(_state: DurableObjectState, _env: Env) {}
  async fetch(): Promise<Response> { return json({ online: 0 }); }
}

export class RateLimiter {
  constructor(private readonly state: DurableObjectState, _env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const key = params.get('key');
    const limit = Number(params.get('limit') || 30);
    const windowSeconds = Number(params.get('window') || 60);
    if (!key || key.length > 128 || !Number.isInteger(limit) || limit < 1 || limit > 60 || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) return json({ error: 'Invalid rate-limit settings' }, 400);
    const now = Math.floor(Date.now() / 1000);
    await this.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    const rows = await this.state.storage.sql.exec<{ hits: number }>(`INSERT INTO limits (key, hits, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        hits = CASE WHEN limits.expires_at <= ? THEN 1 ELSE MIN(?, limits.hits + 1) END,
        expires_at = CASE WHEN limits.expires_at <= ? THEN ? ELSE limits.expires_at END
      RETURNING hits`, key, now + windowSeconds, now, limit + 1, now, now + windowSeconds).toArray();
    const hits = rows[0]?.hits ?? limit + 1;
    const allowed = hits <= limit;
    return json({ allowed, remaining: Math.max(0, limit - hits) }, allowed ? 200 : 429);
  }
}
