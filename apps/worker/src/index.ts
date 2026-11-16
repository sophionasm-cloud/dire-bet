import { PUBLIC_GAMES, TelegramAuthRequestSchema } from '@dire-bet/shared';
import { applyXO, initXO, type Mark, type XOState } from '@dire-bet/engines/xo';
import { initLudo, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyDominoAction, newDominoesGame, nextDominoesRound, viewDominoes, type DominoAction, type DominoesState } from '@dire-bet/engines/dominoes';
import { applyPokerAction, initTexasHoldem, viewPoker, type PokerAction, type PokerState } from '@dire-bet/engines/poker';

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
type StoredRoom = { code: string; gameId: RoomGame; hostId: number; status: 'waiting' | 'active' | 'finished' | 'cancelled'; players: RoomPlayer[]; game: RoomState; matchId: string | null; sequence: number; expiresAt: number };
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

async function connectRoom(request: Request, env: Env, code: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required.' }, 426);
  const ticket = await readRoomTicket(new URL(request.url).searchParams.get('ticket') || '', env.SESSION_SECRET);
  if (!ticket || ticket.code !== code) return json({ error: 'Room ticket is invalid or expired.' }, 401);
  const headers = new Headers(request.headers);
  headers.set('X-Game-User', String(ticket.userId));
  headers.set('X-Game-Name', ticket.displayName);
  const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(code));
  return stub.fetch(new Request(request, { headers }));
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
    inline_keyboard: [[{ text: roomPayload ? `Join game · ${roomPayload}` : 'Play DIRE BET', web_app: { url: roomPayload ? `${base}/?room=${roomPayload}` : base } }]],
  } : command === '/account' ? {
    inline_keyboard: [[{ text: 'Set up web login', web_app: { url: `${base}/?page=account` } }]],
  } : command === '/wallet' ? {
    inline_keyboard: [[{ text: 'Open demo wallet', web_app: { url: `${base}/?page=wallet` } }]],
  } : undefined;
  await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: message.chat.id,
    text: roomPayload ? `${welcome[lang]} Room ${roomPayload} is ready. Tap below to join.` : responses[command] || 'Use /play to open free practice games, or /help for help.',
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
  },
};

export class GameRoom {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/create' && request.method === 'POST') {
      const existing = await this.state.storage.get<StoredRoom>('room');
      if (existing) return json({ error: 'Room code is already in use.' }, 409);
      let input: { code?: unknown; gameId?: unknown; userId?: unknown; displayName?: unknown; expiresAt?: unknown };
      try { input = await request.json() as typeof input; } catch { return json({ error: 'Invalid room request.' }, 400); }
      if (typeof input.code !== 'string' || (input.gameId !== 'xo' && input.gameId !== 'ludo' && input.gameId !== 'dominoes' && input.gameId !== 'poker') || !Number.isSafeInteger(input.userId) || typeof input.displayName !== 'string' || !Number.isSafeInteger(input.expiresAt)) return json({ error: 'Invalid room request.' }, 400);
      const room: StoredRoom = { code: input.code, gameId: input.gameId, hostId: input.userId as number, status: 'waiting', players: [{ id: input.userId as number, name: input.displayName.slice(0, 32), mark: null, online: false }], game: createGame(input.gameId), matchId: null, sequence: 0, expiresAt: input.expiresAt as number };
      await this.state.storage.put('room', room);
      await this.state.storage.setAlarm(room.expiresAt);
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
  }

  private broadcast(room: StoredRoom): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { userId?: number } | null;
      const seat = room.players.findIndex((player) => player.id === attachment?.userId);
      let game: unknown = room.game;
      if (room.gameId === 'dominoes' && seat >= 0) game = viewDominoes(room.game as DominoesState, seat as 0 | 1);
      if (room.gameId === 'poker' && seat >= 0) game = viewPoker(room.game as PokerState, seat as 0 | 1);
      try { socket.send(JSON.stringify({ type: 'state', code: room.code, gameId: room.gameId, status: room.status, players: room.players, game, you: room.players[seat]?.mark || null, seat })); }
      catch { socket.close(1011, 'Unable to send room update'); }
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    try { socket.send(JSON.stringify({ type: 'error', error: message })); } catch { socket.close(1011, 'Unable to send room error'); }
  }
}

export class Matchmaker {
  constructor(_state: DurableObjectState, _env: Env) {}
  async fetch(): Promise<Response> { return json({ error: 'Online matchmaking is not enabled yet' }, 503); }
}

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
