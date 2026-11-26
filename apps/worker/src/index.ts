import { PUBLIC_GAMES, TelegramAuthRequestSchema, parseTransactionSms, type GameId } from '@dire-bet/shared';
import { applyXO, initXO, type Mark, type XOState } from '@dire-bet/engines/xo';
import { initLudo, legalLudoActions, moveLudo, rollLudo, type LudoState } from '@dire-bet/engines/ludo';
import { applyCheckerMove, newCheckersGame, type CheckersState } from '@dire-bet/engines/checkers';
import { applyPokerAction, initTexasHoldem, viewPoker, type PokerAction, type PokerState } from '@dire-bet/engines/poker';
import { Matchmaker } from './public-marketplace';
import { isMarketplaceGame } from './marketplace';
import { addisWeekStart } from './agent-report';
import { freePlayEligibilityError, moneyActivationRecorded, moneyEligibilityError } from './activation';
import { verifyDepositTransaction } from './bank-verifier';
export { moneyActivationRecorded } from './activation';

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
  SIMULATED_WALLET_ENABLED: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_CHANNEL_URL?: string;
  SESSION_SECRET?: string;
  SETUP_KEY?: string;
  SUPER_ADMIN_TELEGRAM_ID?: string;
}

const enc = new TextEncoder();
const ONE_HOUR = 60 * 60;
const SESSION_LIFETIME = 24 * 60 * 60;
const PASSWORD_SESSION_LIFETIME = 12 * 60 * 60;
const REFRESH_TOKEN_LIFETIME = 30 * 24 * 60 * 60;
const MAX_WEBHOOK_BYTES = 64 * 1024;
const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_TTL_MS = 15 * 60 * 1000;
const RECONNECT_GRACE_MS = 60 * 1000;
const LUDO_TURN_MS = 30 * 1000;

type RoomGame = 'xo' | 'ludo' | 'checkers' | 'poker';
type RoomState = XOState | LudoState | CheckersState | PokerState;
type RoomPlayer = { id: number; name: string; mark: Mark | null; online: boolean };
type RoomTerminal = { winner: number | 'draw'; reason: 'resign' | 'draw' | 'timeout' };
type StoredRoom = { code: string; gameId: RoomGame; hostId: number; status: 'waiting' | 'active' | 'finished' | 'cancelled'; players: RoomPlayer[]; game: RoomState; matchId: string | null; sequence: number; expiresAt: number; publicRoomId?: string; publicRoomOptions?: Record<string, unknown>; entryCredits?: number; terminal?: RoomTerminal; drawOfferBy?: number; turnDeadline?: number; timeoutRecorded?: boolean; reconnectDeadline?: number };
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

function createGame(gameId: RoomGame, publicRoomOptions?: Record<string, unknown>): RoomState {
  if (gameId === 'xo') return initXO();
  if (gameId === 'ludo') {
    const target = publicRoomOptions?.crownTarget;
    return initLudo(0, target === 1 || target === 2 || target === 4 ? target : 4);
  }
  if (gameId === 'checkers') return newCheckersGame(1);
  return initTexasHoldem(secureRandom, [1000, 1000]);
}

function gameTurn(room: StoredRoom): number | null {
  if (room.gameId === 'xo') return room.players.findIndex((player) => player.mark === (room.game as XOState).turn);
  if (room.gameId === 'ludo') return (room.game as LudoState).turn;
  if (room.gameId === 'checkers') return (room.game as CheckersState).turn;
  return (room.game as PokerState).turn;
}

function gameComplete(room: StoredRoom): { done: boolean; winner: number | 'draw' | null } {
  if (room.terminal) return { done: true, winner: room.terminal.winner };
  if (room.gameId === 'xo') {
    const game = room.game as XOState;
    return { done: game.winner !== null, winner: game.winner === 'draw' ? 'draw' : game.winner ? room.players.findIndex((player) => player.mark === game.winner) : null };
  }
  if (room.gameId === 'ludo') { const game = room.game as LudoState; return { done: game.winner !== null, winner: game.winner }; }
  if (room.gameId === 'checkers') { const game = room.game as CheckersState; return { done: game.winner !== null, winner: game.winner }; }
  const game = room.game as PokerState;
  return { done: game.street === 'showdown' || game.street === 'folded', winner: game.winner === 'split' ? 'draw' : game.winner };
}

function roomAuditView(room: StoredRoom): unknown {
  if (room.gameId === 'xo' || room.gameId === 'ludo' || room.gameId === 'checkers') return room.game;
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

function telegramAccountName(user: { first_name?: string | null; last_name?: string | null; username?: string | null; web_username?: string | null }): string {
  const first = typeof user.first_name === 'string' ? user.first_name.trim() : '';
  const last = typeof user.last_name === 'string' ? user.last_name.trim() : '';
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full && full !== 'Player') return full;
  if (typeof user.username === 'string' && user.username.trim()) return user.username.trim();
  if (full) return full;
  return user.web_username?.trim() || 'Player';
}

async function gameDisplayName(env: Env, userId: number): Promise<string | null> {
  const user = await env.DB.prepare('SELECT first_name, username, web_username, last_name FROM users WHERE id = ? AND status = ?').bind(userId, 'active').first<{ first_name: string; username: string | null; web_username: string | null; last_name?: string | null }>();
  if (!user) return null;
  return telegramAccountName(user).slice(0, 32);
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
  if (body.gameId !== 'xo' && body.gameId !== 'ludo' && body.gameId !== 'checkers') return json({ error: 'This game cannot be played online.' }, 409);
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
  if (row.game_id !== 'xo' && row.game_id !== 'ludo' && row.game_id !== 'checkers') return json({ error: 'This game is not available online yet.' }, 409);
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

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ALLOWED_ALERT_ETB = new Set([0, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000]);

async function ensureNotificationPrefsTable(db: D1Database): Promise<void> {
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      min_etb INTEGER NOT NULL DEFAULT 30,
      max_etb INTEGER NOT NULL DEFAULT 10000,
      five_rooms_alerted_at INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch {
    // Minimal test DB mocks may omit DDL support.
  }
}

async function notifyNewLudoRoom(
  env: Env,
  room: { creatorUserId: number; creatorName: string; roomCode: string; entryCredits: number; crownTarget: number; origin: string },
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await ensureNotificationPrefsTable(env.DB);
  const recipientsResult = await env.DB.prepare(`
    SELECT u.id, u.telegram_id, u.language, np.min_etb, np.max_etb, np.five_rooms_alerted_at
    FROM users u
    JOIN user_notification_preferences np ON np.user_id = u.id
    WHERE u.id != ?
      AND u.status = 'active'
      AND u.telegram_id > 0
      AND np.enabled = 1
      AND ? BETWEEN np.min_etb AND np.max_etb
      AND EXISTS (SELECT 1 FROM user_contacts c WHERE c.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1 FROM user_profiles p
        WHERE p.user_id = u.id
          AND (p.self_excluded_until > CURRENT_TIMESTAMP OR p.cooling_off_until > CURRENT_TIMESTAMP)
      )
    ORDER BY u.updated_at DESC
    LIMIT 40
  `).bind(room.creatorUserId, room.entryCredits).all<{ id: number; telegram_id: number; language?: string; min_etb: number; max_etb: number; five_rooms_alerted_at?: number }>().catch(() => null);
  const recipients = recipientsResult?.results || [];
  if (recipients.length === 0) return;

  const listRes = await publicMarketplace(env).fetch('https://market/list?gameId=ludo').catch(() => null);
  const listJson = listRes?.ok ? await listRes.json().catch(() => null) as { rooms?: Array<{ code?: string; entryCredits?: number }> } | null : null;
  const waitingLudoRooms = Array.isArray(listJson?.rooms) ? listJson.rooms : [];

  const safeCreator = escapeTelegramHtml(room.creatorName || 'Player');
  const lobbyUrl = `${room.origin}/?page=lobby`;
  const now = Date.now();

  for (const recipient of recipients) {
    if (!Number.isSafeInteger(recipient.telegram_id) || recipient.telegram_id <= 0) continue;
    const lang = botLanguage(recipient.language);
    const playLabel = ({ en: '▶ PLAY', am: '▶ ተጫወት', so: '▶ CIYAAR', om: '▶ TAPHADHU' })[lang];

    const matchingWaiting = waitingLudoRooms.filter((item) => {
      const stake = typeof item.entryCredits === 'number' ? item.entryCredits : 0;
      return stake >= recipient.min_etb && stake <= recipient.max_etb;
    });
    const includesNew = matchingWaiting.some((item) => item.code === room.roomCode);
    const totalEligible = includesNew ? matchingWaiting.length : matchingWaiting.length + 1;
    const prevEligible = includesNew ? matchingWaiting.length - 1 : matchingWaiting.length;
    const cooldownOk = now - (recipient.five_rooms_alerted_at || 0) > 10 * 60 * 1000;

    if (prevEligible <= 5 && totalEligible > 5 && cooldownOk) {
      const fiveDedupeId = `ludo-five:${Math.floor(now / (10 * 60 * 1000))}:${recipient.id}`;
      let sendFive = true;
      try {
        const outbox = await env.DB.prepare(
          `INSERT OR IGNORE INTO notification_outbox (id, user_id, payload_json, status) VALUES (?, ?, ?, 'sent')`
        ).bind(fiveDedupeId, recipient.id, JSON.stringify({ type: 'ludo_five_rooms', count: totalEligible })).run();
        if (outbox?.meta && typeof outbox.meta.changes === 'number') sendFive = outbox.meta.changes === 1;
      } catch {
        // Minimal mocks may skip outbox table.
      }
      if (sendFive) {
        const multiText = ({
          en: `🔥 <b>Multiple Ludo rooms are available!</b>\n\n<b>${totalEligible}</b> active rooms match your alert range (${recipient.min_etb}–${recipient.max_etb} ETB). Join a game now.`,
          am: `🔥 <b>ብዙ የሉዶ ክፍሎች ተከፍተዋል!</b>\n\nከእርስዎ ክልል (${recipient.min_etb}–${recipient.max_etb} ብር) ጋር የሚመሳሰሉ <b>${totalEligible}</b> ክፍሎች አሉ። አሁን ይቀላቀሉ።`,
          so: `🔥 <b>Qolal badan oo Ludo ah ayaa diyaar ah!</b>\n\n<b>${totalEligible}</b> qolal ayaa ku jira xadkaaga (${recipient.min_etb}–${recipient.max_etb} ETB). Hadda ku biir ciyaarta.`,
          om: `🔥 <b>Kutaan Ludo hedduun banamaniiru!</b>\n\nKutaan <b>${totalEligible}</b> daangaa keessan (${recipient.min_etb}–${recipient.max_etb} ETB) keessatti argamu. Amma taphatti makamaa.`,
        })[lang];
        await telegramApi<unknown>(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
          chat_id: recipient.telegram_id,
          text: multiText,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: playLabel, web_app: { url: lobbyUrl } }]] },
        }).catch(() => undefined);
        await env.DB.prepare('UPDATE user_notification_preferences SET five_rooms_alerted_at = ? WHERE user_id = ?').bind(now, recipient.id).run().catch(() => undefined);
        continue;
      }
    }

    const dedupeId = `ludo-room:${room.roomCode}:${recipient.id}`;
    let inserted = true;
    try {
      const outboxResult = await env.DB.prepare(
        `INSERT OR IGNORE INTO notification_outbox (id, user_id, payload_json, status) VALUES (?, ?, ?, 'sent')`
      ).bind(dedupeId, recipient.id, JSON.stringify({ type: 'ludo_room_created', roomCode: room.roomCode, entryCredits: room.entryCredits })).run();
      if (outboxResult?.meta && typeof outboxResult.meta.changes === 'number') {
        inserted = outboxResult.meta.changes === 1;
      }
    } catch {
      // Minimal test mocks without notification_outbox should not prevent notification delivery.
    }
    if (!inserted) continue;

    const stakeText = room.entryCredits === 0
      ? ({ en: 'FREE', am: 'ነፃ', so: 'Bilaash', om: 'Bilisa' }[lang])
      : `${room.entryCredits} ${lang === 'am' ? 'ብር' : 'ETB'}`;
    const text = ({
      en: `🎲 <b>New Ludo room created</b>\n\n👤 <b>${safeCreator}</b> opened a Ludo room (#<code>${room.roomCode}</code>)\n💰 Entry: <b>${stakeText}</b> · ♛ ${room.crownTarget}\n\nTap below to join before the seat fills.`,
      am: `🎲 <b>አዲስ የሉዶ ክፍል ተፈጥሯል</b>\n\n👤 <b>${safeCreator}</b> የሉዶ ክፍል ከፍቷል (#<code>${room.roomCode}</code>)\n💰 መግቢያ: <b>${stakeText}</b> · ♛ ${room.crownTarget}\n\nከመሙላቱ በፊት ለመቀላቀል ከታች ይንኩ።`,
      so: `🎲 <b>Qol cusub oo Ludo ah waa la furay</b>\n\n👤 <b>${safeCreator}</b> wuxuu furay qol Ludo (#<code>${room.roomCode}</code>)\n💰 Gelitaanka: <b>${stakeText}</b> · ♛ ${room.crownTarget}\n\nHoos taabo si aad ugu biirto.`,
      om: `🎲 <b>Kutaan Ludo haaraan uumameera</b>\n\n👤 <b>${safeCreator}</b> kutaa Ludo baneera (#<code>${room.roomCode}</code>)\n💰 Seensa: <b>${stakeText}</b> · ♛ ${room.crownTarget}\n\nOsooo hin guutiin itti makamuuf gadii tuqi.`,
    })[lang];

    await telegramApi<unknown>(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
      chat_id: recipient.telegram_id,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: playLabel, web_app: { url: lobbyUrl } }]] },
    }).catch(() => undefined);
  }
}
async function createPublicRoom(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const userId = await readSession(request, env.SESSION_SECRET);
  if (!userId) return json({ error: 'Open DIRE BET in Telegram to create a public room.' }, 401);
  if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your contact with the DIRE BET bot to finish registration.' }, 403);
  if (!(await allowRoomAction(env, userId, 'public-create'))) return json({ error: 'Too many room attempts. Try again shortly.' }, 429);
  const input = await request.json().catch(() => null) as { gameId?: unknown; entry?: unknown; options?: unknown; idempotencyKey?: unknown } | null;
  if (!input || !isMarketplaceGame(input.gameId) || input.gameId === 'poker') return json({ error: 'This game cannot be opened in the public room list.' }, 409);
  const game = await env.DB.prepare('SELECT enabled FROM games WHERE id = ?').bind(input.gameId).first<{ enabled: number }>();
  if (!game || game.enabled !== 1) return json({ error: 'This game is not open for online play.' }, 409);
  const displayName = await gameDisplayName(env, userId);
  if (!displayName) return json({ error: 'Player account is unavailable.' }, 401);
  const marketResponse = await publicMarketplace(env).fetch('https://market/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, userId, displayName }),
  });
  if (marketResponse.status === 201 && input.gameId === 'ludo' && env.TELEGRAM_BOT_TOKEN) {
    const createdBody = await marketResponse.clone().json().catch(() => null) as {
      room?: { code?: string; entryCredits?: number; creatorName?: string; options?: { crownTarget?: number } };
    } | null;
    if (createdBody?.room?.code) {
      const notifyTask = notifyNewLudoRoom(env, {
        creatorUserId: userId,
        creatorName: createdBody.room.creatorName || displayName,
        roomCode: createdBody.room.code,
        entryCredits: typeof createdBody.room.entryCredits === 'number' ? createdBody.room.entryCredits : 0,
        crownTarget: typeof createdBody.room.options?.crownTarget === 'number' ? createdBody.room.options.crownTarget : 1,
        origin: new URL(request.url).origin,
      }).catch(() => undefined);
      if (ctx) ctx.waitUntil(notifyTask);
      else await notifyTask;
    }
  }
  return marketResponse;
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

async function handlePublicMarketplace(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/public-rooms/config' && request.method === 'GET') return publicMarketplace(env).fetch('https://market/config');
  if (url.pathname === '/api/public-rooms/counts' && request.method === 'GET') return publicMarketplace(env).fetch('https://market/counts');
  if (url.pathname === '/api/public-rooms' && request.method === 'GET') {
    const gameId = url.searchParams.get('gameId') || '';
    if (gameId && (!isMarketplaceGame(gameId) || gameId === 'poker')) return json({ error: 'Game filter is invalid.' }, 400);
    return publicMarketplace(env).fetch(`https://market/list?gameId=${encodeURIComponent(gameId)}`);
  }
  if (url.pathname === '/api/public-rooms/notifications') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ error: 'Sign in through Telegram to manage room alerts.' }, 401);
    await ensureNotificationPrefsTable(env.DB);
    if (request.method === 'GET') {
      const prefs = await env.DB.prepare(
        'SELECT enabled, min_etb, max_etb FROM user_notification_preferences WHERE user_id = ?'
      ).bind(userId).first<{ enabled: number; min_etb: number; max_etb: number }>().catch(() => null);
      const rawMin = typeof prefs?.min_etb === 'number' ? prefs.min_etb : 30;
      const rawMax = typeof prefs?.max_etb === 'number' ? prefs.max_etb : 10000;
      return json({
        enabled: prefs?.enabled === 1,
        minEtb: rawMin === 10 ? 30 : rawMin,
        maxEtb: rawMax === 10 ? 30 : rawMax,
      });
    }
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null) as { enabled?: unknown; minEtb?: unknown; maxEtb?: unknown } | null;
      if (!body || typeof body.enabled !== 'boolean' || !ALLOWED_ALERT_ETB.has(Number(body.minEtb)) || !ALLOWED_ALERT_ETB.has(Number(body.maxEtb))) {
        return json({ error: 'Notification settings are invalid.' }, 400);
      }
      const minEtb = Number(body.minEtb);
      const maxEtb = Number(body.maxEtb);
      if (minEtb > maxEtb) return json({ error: 'Minimum ETB cannot exceed maximum ETB.' }, 400);
      await env.DB.prepare(`INSERT INTO user_notification_preferences (user_id, enabled, min_etb, max_etb, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, min_etb = excluded.min_etb, max_etb = excluded.max_etb, updated_at = CURRENT_TIMESTAMP`)
        .bind(userId, body.enabled ? 1 : 0, minEtb, maxEtb).run();
      return json({ enabled: body.enabled, minEtb, maxEtb });
    }
  }
  if (url.pathname === '/api/public-rooms/balance' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ error: 'Sign in to view your wallet balance.' }, 401);
    if (!(await hasRegisteredContact(env, userId))) return json({ error: 'Share your Telegram contact to view a room balance.' }, 403);
    return playerWalletBalance(env, userId);
  }
  if (url.pathname === '/api/public-rooms/mine' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ room: null });
    const gameId = url.searchParams.get('gameId') || '';
    return publicMarketplace(env).fetch(`https://market/mine?userId=${userId}&gameId=${encodeURIComponent(gameId)}`);
  }
  if (url.pathname === '/api/public-rooms' && request.method === 'POST') return createPublicRoom(request, env, ctx);
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
      const joinResponse = await publicMarketplace(env).fetch(`https://market/join/${code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, displayName }) });
            if (!joinResponse.ok) return joinResponse;
            const joinData = await joinResponse.json() as { room?: { id: string; code: string; gameId: GameId; status: string }; balance?: number; balanceSantim?: number };
            if (joinData?.room && ['IN_PROGRESS', 'SETTLING', 'STARTING'].includes(joinData.room.status)) {
              const ticket = await issueRoomTicket(userId, displayName, code, env.SESSION_SECRET || '');
              return json({ ...joinData, ticket, code, gameId: joinData.room.gameId }, 201);
            }
            return json(joinData, 201);
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
  const room = await env.DB.prepare('SELECT game_id FROM game_rooms WHERE id = ?').bind(code).first<{ game_id: string }>();
  if (room?.game_id === 'poker') return json({ error: 'American Texas is coming soon.' }, 409);
  const eligibilityError = await freePlayEligibilityError(env, ticket.userId);
  if (eligibilityError) return json({ error: eligibilityError }, 403);
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

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newRefreshToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashRefreshToken(token: string, secret: string): Promise<string> {
  return hex(await hmac(secret, `dire-bet-refresh-v1:${token}`));
}

async function createAuthSession(env: Env, userId: number, request: Request, familyId = crypto.randomUUID()): Promise<{ refreshToken: string; expiresIn: number }> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, family_id, expires_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), userId, await hashRefreshToken(refreshToken, env.SESSION_SECRET || ''), familyId, expiresAt, request.headers.get('User-Agent')?.slice(0, 200) || null).run();
  return { refreshToken, expiresIn: REFRESH_TOKEN_LIFETIME };
}

async function revokeRefreshToken(env: Env, refreshToken: string): Promise<void> {
  if (!env.SESSION_SECRET) return;
  const row = await env.DB.prepare('SELECT family_id FROM auth_sessions WHERE token_hash = ?')
    .bind(await hashRefreshToken(refreshToken, env.SESSION_SECRET)).first<{ family_id: string }>();
  if (!row) return;
  await env.DB.prepare('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE family_id = ? AND revoked_at IS NULL')
    .bind(row.family_id).run();
}

async function issueAuthResponse(env: Env, userId: number, request: Request, user: Record<string, unknown>, lifetime = SESSION_LIFETIME): Promise<Response> {
  const token = await issueSession(userId, env.SESSION_SECRET || '', lifetime);
  const refresh = await createAuthSession(env, userId, request);
  return json({ token, expiresIn: lifetime, refreshToken: refresh.refreshToken, refreshExpiresIn: refresh.expiresIn, user });
}

async function renewAuthSession(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  if (!env.SESSION_SECRET) return json({ error: 'Session renewal is not configured' }, 503);
  let body: { refreshToken?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request' }, 400); }
  if (typeof body.refreshToken !== 'string' || body.refreshToken.length < 20 || body.refreshToken.length > 200) return json({ error: 'Session renewal is invalid or expired' }, 401);
  const row = await env.DB.prepare(`SELECT s.id, s.user_id, s.family_id, s.expires_at, s.revoked_at,
      u.status, u.first_name, u.web_username, u.language
    FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .bind(await hashRefreshToken(body.refreshToken, env.SESSION_SECRET))
    .first<{ id: string; user_id: number; family_id: string; expires_at: string; revoked_at: string | null; status: string; first_name: string; web_username: string | null; language: string }>();
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now() || row.status !== 'active') {
    return json({ error: 'Session renewal is invalid or expired' }, 401);
  }
  const refreshToken = newRefreshToken();
  const newId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME * 1000).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, replaced_by = ?, last_used_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revoked_at IS NULL`).bind(newId, row.id),
    env.DB.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, family_id, expires_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(newId, row.user_id, await hashRefreshToken(refreshToken, env.SESSION_SECRET), row.family_id, expiresAt, request.headers.get('User-Agent')?.slice(0, 200) || null),
  ]);
  if (results[0]?.meta.changes !== 1) return json({ error: 'Session renewal is invalid or expired' }, 401);
  const token = await issueSession(row.user_id, env.SESSION_SECRET);
  return json({ token, expiresIn: SESSION_LIFETIME, refreshToken, refreshExpiresIn: REFRESH_TOKEN_LIFETIME,
    user: { displayName: row.web_username || row.first_name, webUsername: row.web_username, language: row.language } });
}

async function endAuthSession(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  let body: { refreshToken?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid request' }, 400); }
  if (typeof body.refreshToken === 'string' && body.refreshToken.length >= 20 && body.refreshToken.length <= 200) {
    await revokeRefreshToken(env, body.refreshToken).catch(() => undefined);
  }
  return json({ ok: true });
}

function validEvidenceReference(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 240;
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

type BotLanguage = 'en' | 'am' | 'so' | 'om';

const botLanguages = new Set<string>(['en', 'am', 'so', 'om']);

function botLanguage(code?: string): BotLanguage {
  return code && botLanguages.has(code) ? code as BotLanguage : 'am';
}

const welcome: Record<BotLanguage, string> = {
  en: `🎮 <b>DIRE BET</b>
<i>Play together. Win together.</i>

<b>XO · Ludo · Checkers · Texas Hold'em</b>

✅ Free practice against the bot
👥 Private rooms with friends
💰 Simple wallet for your balance

Play your favorite game in seconds.`,
  am: `🎮 <b>DIRE BET</b>
<i>አብረን እንጫወት። አብረን እናሸንፍ።</i>

<b>XO · ሉዶ · ቼከርስ · ቴክሳስ ሆልድኤም</b>

✅ ከቦት ጋር በነፃ ልምምድ
👥 ከጓደኞች ጋር የግል ክፍሎች
💰 ለቀሪ ሂሳብዎ ቀላል ዋሌት

የሚወዱትን ጨዋታ በሰከንዶች ይጀምሩ።`,
  so: `🎮 <b>DIRE BET</b>
<i>Wada ciyaar. Wada guulayso.</i>

<b>XO · Ludo · Checkers · Texas Hold'em</b>

✅ Tababar bilaash ah oo ka dhan ah bot
👥 Qolal gaar ah oo saaxiibbo la wadaago
💰 Jeeb fudud oo loogu talagalay hadhaagaaga

Ciyaarta aad jeceshahay ku bilow ilbiriqsiyo gudahood.`,
  om: `🎮 <b>DIRE BET</b>
<i>Waliin taphadhu. Waliin mo'adhu.</i>

<b>XO · Ludo · Checkers · Texas Hold'em</b>

✅ Bot waliin shaakala bilisaa
👥 Hiriyoota waliin kutaa dhuunfaa
💰 Haftee keetiif wallet salphaa

Tapha jaallattu sekondoota keessatti jalqabi.`,
};
const welcomeBack: Record<BotLanguage, string> = {
  en: `👋 <b>Welcome back to DIRE BET</b>
<i>Play together. Win together.</i>

Ready for another round? Choose a game below.`,
  am: `👋 <b>ወደ DIRE BET እንደገና እንኳን በደህና መጡ</b>
<i>አብረን እንጫወት። አብረን እናሸንፍ።</i>

ለሌላ ዙር ዝግጁ ነዎት? ከታች ጨዋታ ይምረጡ።`,
  so: `👋 <b>Ku soo dhawow DIRE BET</b>
<i>Wada ciyaar. Wada guulayso.</i>

Diyaar u tahay wareeg kale? Ciyaar hoos ka dooro.`,
  om: `👋 <b>Baga gara DIRE BET deebitan</b>
<i>Waliin taphadhu. Waliin mo'adhu.</i>

Yaada biraaaf qophii? Tapha gadii irraa filadhu.`,
};
const menuPrompt: Record<BotLanguage, string> = {
  en: 'Use the menu below to play, open your wallet, or add funds.',
  am: 'ከታች ያለውን ምናሌ ተጠቅመው ይጫወቱ፣ ዋሌትዎን ይክፈቱ ወይም ገንዘብ ያስገቡ።',
  so: 'Isticmaal menu-ga hoose si aad u ciyaarto, u furto jeebkaaga, ama lacag u dhigato.',
  om: 'Menuu gadii fayyadamuun taphadhu, wallet kee bani, yookaan maallaqa galchi.',
};
const registrationText: Record<BotLanguage, string> = {
  en: `📱 <b>One quick step</b>
Share your contact to create your player account. Your number is used only to link your account.

Optional web login: choose a username and 8-digit PIN after sharing.`,
  am: `📱 <b>አንድ ፈጣን እርምጃ</b>
የተጫዋች መለያዎን ለመፍጠር እውቂያዎን ያጋሩ። ቁጥርዎ መለያዎን ለማገናኘት ብቻ ይጠቀማል።

አማራጭ የድር መግቢያ፦ ካጋሩ በኋላ የተጠቃሚ ስምና 8 አሃዝ PIN ይምረጡ።`,
  so: `📱 <b>Tallaabo degdeg ah</b>
La wadaag xiriirkaaga si aad u abuurto akoonkaaga ciyaartoyga. Lambarkaaga waxaa loo isticmaalaa oo keliya in lagu xidho akoonkaaga.

Gelitaan web ikhtiyaari: ka dib markaad wadaagto, dooro magac isticmaale iyo PIN 8-god ah.`,
  om: `📱 <b>Tarkaanfii saffisaa</b>
Herrega taphataa uumuuuf quunnamtii kee qoodi. Lakkoofsi kee herrega kee walitti hidhuuf qofa fayyadama.

Seensa weebii filannoo: erga qoodde booda maqaa fayyadamaa fi PIN lakkoofsa 8 filadhu.`,
};
const botText: Record<string, Record<BotLanguage, string>> = {
  play: {
    en: `🎮 <b>Ready to play?</b>\nChoose a game, warm up against the bot, or open a private room with friends.`,
    am: `🎮 <b>ለመጫወት ዝግጁ ነዎት?</b>\nጨዋታ ይምረጡ፣ ከቦት ጋር ይለማመዱ ወይም ከጓደኞች ጋር የግል ክፍል ይክፈቱ።`,
    so: `🎮 <b>Diyaar ma u tahay inaad ciyaarto?</b>\nDooro ciyaar, la tababar bot, ama qol gaar ah u fur saaxiibbadaa.`,
    om: `🎮 <b>Taphachuuf qophii dhaa?</b>\nTapha filadhu, bot waliin shaakali, yookaan hiriyoota waliin kutaa dhuunfaa bani.`,
  },
  games: {
    en: `🎮 <b>Games on DIRE BET</b>\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nPlay free practice against the bot or open a private room with friends.`,
    am: `🎮 <b>በ DIRE BET ያሉ ጨዋታዎች</b>\n\n🎯 XO\n🎲 ሉዶ\n♟️ ቼከርስ\n🃏 ቴክሳስ ሆልድኤም\n\nከቦት ጋር በነፃ ይለማመዱ ወይም ከጓደኞች ጋር የግል ክፍል ይክፈቱ።`,
    so: `🎮 <b>Ciyaaraha DIRE BET</b>\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nTababar bilaash ah la ciyaar bot ama qol gaar ah u fur saaxiibbadaa.`,
    om: `🎮 <b>Taphoota DIRE BET</b>\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nBot waliin shaakala bilisaa taphadhu yookaan hiriyoota waliin kutaa dhuunfaa bani.`,
  },
  wallet: {
    en: `💰 <b>Your wallet</b>\nView your balance and follow deposit or withdrawal requests in one place.\n\n<i>Free-play balance only. Live cash payments are disabled.</i>`,
    am: `💰 <b>ዋሌትዎ</b>\nቀሪ ሂሳብዎን ይመልከቱ እና የተቀማጭ ወይም የማውጣት ጥያቄዎችን በአንድ ቦታ ይከታተሉ።\n\n<i>ለነፃ ጨዋታ ቀሪ ብቻ። ቀጥታ የገንዘብ ክፍያዎች ተዘግተዋል።</i>`,
    so: `💰 <b>Jeebkaaga</b>\nEeg hadhaagaaga oo la soco codsiyada dhigashada ama bixitaanka meel qudha.\n\n<i>Hadhaaga ciyaar bilaash oo keliya. Lacag-bixin toos ah waa xiran tahay.</i>`,
    om: `💰 <b>Wallet kee</b>\nHaftee kee ilaali, gaaffii kuusaa yookaan baasii iddoo tokkotti hordofi.\n\n<i>Haftee taphannaa bilisaa qofa. Kaffaltiin maallaqaa kallattii cufaa jira.</i>`,
  },
  deposit: {
    en: `💳 <b>Add funds</b>\nSubmit your Telebirr or eBirr payment SMS and our team will verify it before credit.\n\n<i>Free-play mode: do not send real money.</i>`,
    am: `💳 <b>ገንዘብ ማስገባት</b>\nየ Telebirr ወይም eBirr የክፍያ SMS ያስገቡ፤ ቡድናችን ከማስተላለፉ በፊት ያረጋግጣል።\n\n<i>የነፃ ጨዋታ ሁነታ፦ እውነተኛ ገንዘብ አይላኩ።</i>`,
    so: `💳 <b>Lacag dhigasho</b>\nGeli SMS-ka lacag-bixinta Telebirr ama eBirr, kooxdayaduna way hubin doontaa ka hor inta aan la xisaabin.\n\n<i>Habka ciyaar bilaash: ha dirin lacag dhab ah.</i>`,
    om: `💳 <b>Maallaqa galchi</b>\nSMS kaffaltii Telebirr yookaan eBirr galchi; gareen keenya dura galmee mirkaneessa.\n\n<i>Haala taphannaa bilisaa: maallaqa dhugaa hin ergin.</i>`,
  },
  channel: {
    en: `📢 <b>DIRE BET official channel</b>\nNews, promotions and new game announcements.`,
    am: `📢 <b>የ DIRE BET ኦፊሴላዊ ቻናል</b>\nዜናዎች፣ ማስተዋወቂያዎች እና አዲስ የጨዋታ ማስታወቂያዎች።`,
    so: `📢 <b>Kanaalka rasmiga ah ee DIRE BET</b>\nWarar, xayaysiisyo iyo ogeysiisyo ciyaar cusub.`,
    om: `📢 <b>Chaanaalii mootummaa DIRE BET</b>\nOduu, beeksisa fi beeksisa taphoota haaraa.`,
  },
  channelMissing: {
    en: `📢 <b>DIRE BET official channel</b>\nOur channel is being prepared. Please check back soon.`,
    am: `📢 <b>የ DIRE BET ኦፊሴላዊ ቻናል</b>\nቻናላችን በዝግጅት ላይ ነው። እባክዎ በቅርቡ ይመልከቱ።`,
    so: `📢 <b>Kanaalka rasmiga ah ee DIRE BET</b>\nKanaalkayaga waa la diyaarinayaa. Fadlan dib u soo eeg dhawaan.`,
    om: `📢 <b>Chaanaalii mootummaa DIRE BET</b>\nChaanaalli keenya qophaa'aa jira. Maaloo dhiyootti deebi'ii ilaali.`,
  },
  account: {
    en: `🔐 <b>Web login</b>\nShare your contact with the bot, then set an optional username and 8-digit PIN to sign in from a browser.`,
    am: `🔐 <b>የድር መግቢያ</b>\nእውቂያዎን ከቦት ጋር ያጋሩ፣ ከዚያ ከአሳሽ ለመግባት አማራጭ የተጠቃሚ ስምና 8 አሃዝ PIN ያዘጋጁ።`,
    so: `🔐 <b>Gelitaanka webka</b>\nLa wadaag bot-ka xiriirkaaga, kadib samee magac isticmaale iyo PIN 8-god ah oo ikhtiyaari ah si aad browserka uga soo gasho.`,
    om: `🔐 <b>Seensa weebii</b>\nQuunnamtii kee bot waliin qoodi, achiis maqaa fayyadamaa fi PIN lakkoofsa 8 filannoo ta'een browser irraa seenuuf qopheessi.`,
  },
  profile: {
    en: 'Your profile is inside DIRE BET. Open the app and tap your avatar to view your account.',
    am: 'መገለጫዎ በ DIRE BET ውስጥ ነው። መተግበሪያውን ከፍተው መለያዎን ለማየት ባለቀለሙን ምስልዎን ይንኩ።',
    so: 'Astaantaada waxay ku taal DIRE BET gudaheed. Fur app-ka oo taabo sawirkaaga si aad u aragto akoonkaaga.',
    om: 'Profaayiliin kee DIRE BET keessatti jira. Appii baniitii suuraa kee tuqiitii herrega kee ilaali.',
  },
  help: {
    en: `❓ <b>Need help?</b>\nTap Play to enjoy free practice and private rooms. For wallet or account help, open DIRE BET and tap Support.`,
    am: `❓ <b>እርዳታ ይፈልጋሉ?</b>\nበነፃ ልምምድና የግል ክፍሎች ለመደሰት መጫወትን ይንኩ። ለዋሌት ወይም ለመለያ እርዳታ DIRE BET ን ከፍተው ድጋፍን ይንኩ።`,
    so: `❓ <b>Caawimaad ma u baahan tahay?</b>\nTaabo Ciyaar si aad u hesho tababar bilaash ah iyo qolal gaar ah. Caawimaad jeeb ama akoon, fur DIRE BET oo taabo Taageero.`,
    om: `❓ <b>Gargaarsa barbaaddaa?</b>\nShaakala bilisaa fi kutaa dhuunfaa argachuuf Taphadhu tuqi. Gargaarsa wallet yookaan herregaaf, DIRE BET baniitii Deeggarsa tuqi.`,
  },
  contactRequired: {
    en: 'To register, use the Share contact button in this chat and share your own number.',
    am: 'ለመመዝገብ በዚህ ውይይት ያለውን እውቂያ አጋራ ቁልፍ ተጠቅመው የራስዎን ቁጥር ያጋሩ።',
    so: 'Si aad isu diiwaangeliso, taabo La wadaag xiriirka oo la wadaag lambarkaaga.',
    om: 'Galmaa’uuf, Quunnamtii qoodi jedhu tuqiitii lakkoofsa bilbilaa kee qoodi.',
  },
  contactLinked: {
    en: `✅ <b>Contact linked</b>\nYour player account is ready. Set an optional username and 8-digit PIN for web login, or open DIRE BET and start playing.`,
    am: `✅ <b>እውቂያ ተገናኝቷል</b>\nየተጫዋች መለያዎ ዝግጁ ነው። አማራጭ የተጠቃሚ ስምና 8 አሃዝ PIN ለድር መግቢያ ያዘጋጁ፣ ወይም DIRE BET ን ከፍተው ይጫወቱ።`,
    so: `✅ <b>Xiriirka waa la xidhay</b>\nAkoonkaaga ciyaartoyga waa diyaar. Samee magac isticmaale iyo PIN 8-god ah oo ikhtiyaari ah gelitaanka web, ama fur DIRE BET oo bilow ciyaar.`,
    om: `✅ <b>Quunnamtiin walitti hidhame</b>\nHerregni taphataa kee qophaa'eera. Maqaa fayyadamaa fi PIN lakkoofsa 8 filannoo ta'een seensa weebiif qopheessi, yookaan DIRE BET baniitii taphadhu.`,
  },
  promo: {
    en: `<b>DIRE BET</b> — Play together. Win together.\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nFree practice, private rooms and a simple wallet. Bring a friend and start a game.\n\n👉 Tap Play Now to open DIRE BET.`,
    am: `<b>DIRE BET</b> — አብረን እንጫወት። አብረን እናሸንፍ።\n\n🎯 XO\n🎲 ሉዶ\n♟️ ቼከርስ\n🃏 ቴክሳስ ሆልድኤም\n\nበነፃ ልምምድ፣ የግል ክፍሎች እና ቀላል ዋሌት። ጓደኛዎን ይዘው ጨዋታ ይጀምሩ።\n\n👉 DIRE BET ን ለመክፈት Play Now ን ይንኩ።`,
    so: `<b>DIRE BET</b> — Wada ciyaar. Wada guulayso.\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nTababar bilaash, qolal gaar ah iyo jeeb fudud. Saaxiib keen oo ciyaar bilow.\n\n👉 Taabo Play Now si aad u furto DIRE BET.`,
    om: `<b>DIRE BET</b> — Waliin taphadhu. Waliin mo'adhu.\n\n🎯 XO\n🎲 Ludo\n♟️ Checkers\n🃏 Texas Hold'em\n\nShaakala bilisaa, kutaa dhuunfaa fi wallet salphaa. Hiriyyaa fidiitii tapha jalqabi.\n\n👉 DIRE BET banuuf Play Now tuqi.`,
  },
  ownerOnly: {
    en: 'This command is available only to the DIRE BET owner.',
    am: 'ይህ ትዕዛዝ ለ DIRE BET ባለቤት ብቻ ነው።',
    so: 'Amarkan waxaa loo heli karaa oo keliya milkiilaha DIRE BET.',
    om: 'Ajajni kun abbootii DIRE BET qofaaf jira.',
  },
  roomReady: {
    en: `Room <code>{code}</code> is ready. Tap Play to join your friends.`,
    am: `ክፍል <code>{code}</code> ዝግጁ ነው። ጓደኞችዎን ለመቀላቀል መጫወትን ይንኩ።`,
    so: `Qolka <code>{code}</code> waa diyaar. Taabo Ciyaar si aad ugu biirto saaxiibbadaa.`,
    om: `Kutaan <code>{code}</code> qophaa'eera. Hiriyoota kee walitti makamuuf Taphadhu tuqi.`,
  },
  promoLinked: {
    en: `Promo code <code>{code}</code> is linked to your account.`,
    am: `የማስተዋወቂያ ኮድ <code>{code}</code> ከመለያዎ ጋር ተገናኝቷል።`,
    so: `Koodhka xayaysiiska <code>{code}</code> waa lagu xidhay akoonkaaga.`,
    om: `Koodii beeksisaa <code>{code}</code> herrega kee waliin hidhameera.`,
  },
  fallback: {
    en: 'Choose an option below or use /help to see what the bot can do.',
    am: 'ከታች አንድ አማራጭ ይምረጡ ወይም ቦቱ ምን ማድረግ እንደሚችል ለማየት /help ይጠቀሙ።',
    so: 'Dooro ikhtiyaar hoose ama isticmaal /help si aad u aragto waxa bot-ku qaban karo.',
    om: `Filannoo gadii filadhu yookaan /help fayyadamuun waan botni hojjechuu danda'u ilaali.`,
  },
};

const botMenuLabels: Record<BotLanguage, { play: string; wallet: string; deposit: string; channel: string; contact: string }> = {
  en: { play: '🎮 Play', wallet: '💰 Wallet', deposit: '💳 Deposit', channel: '📢 Channel', contact: '📱 Share contact' },
  am: { play: '🎮 መጫወት', wallet: '💰 ዋሌት', deposit: '💳 ማስገባት', channel: '📢 ቻናል', contact: '📱 እውቂያ አጋራ' },
  so: { play: '🎮 Ciyaar', wallet: '💰 Jeebka', deposit: '💳 Dhigasho', channel: '📢 Kanaalka', contact: '📱 Xiriir qood' },
  om: { play: '🎮 Taphadhu', wallet: '💰 Wallet', deposit: '💳 Galchi', channel: '📢 Chaanaalii', contact: '📱 Quunnamtii qoodi' },
};

const botButtons: Record<BotLanguage, { play: string; wallet: string; deposit: string; login: string; channel: string }> = {
  en: { play: '🎮 Play now', wallet: '💰 Open wallet', deposit: '💳 Open deposit', login: '🔐 Set up web login', channel: '📢 Open channel' },
  am: { play: '🎮 አሁን ተጫወት', wallet: '💰 ዋሌት ክፈት', deposit: '💳 ማስገቢያ ክፈት', login: '🔐 የድር መግቢያ አዘጋጅ', channel: '📢 ቻናሉን ክፈት' },
  so: { play: '🎮 Hadda ciyaar', wallet: '💰 Fur jeebka', deposit: '💳 Fur dhigashada', login: '🔐 Samee gelitaan web', channel: '📢 Fur kanaalka' },
  om: { play: '🎮 Amma taphadhu', wallet: '💰 Wallet bani', deposit: '💳 Galchaa bani', login: '🔐 Seensa weebii qopheessi', channel: '📢 Chaanaalii bani' },
};

const botProfileDescription = `DIRE BET — Play together. Win together.

Enjoy XO, Ludo, Checkers and Texas Hold'em with friends. Free practice, private rooms and a simple wallet for your balance.

Free-play balance only; live cash payments are disabled.`;
const botProfileShortDescription = `Play XO, Ludo, Checkers and Texas Hold'em with friends. Free practice, private rooms and a simple wallet.`;

function telegramChannelUrl(value?: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^@[A-Za-z0-9_]{4,}$/.test(raw)) return `https://t.me/${raw.slice(1)}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 't.me' && url.hostname !== 'telegram.me') return null;
    return url.toString();
  } catch { return null; }
}

function botMenuKeyboard(base: string, lang: BotLanguage, hasContact: boolean, playUrl = base) {
  const labels = botMenuLabels[lang];
  return {
    keyboard: [
      [{ text: labels.play, web_app: { url: playUrl } }],
      [
        { text: labels.wallet, web_app: { url: `${base}/?page=wallet` } },
        { text: labels.deposit, web_app: { url: `${base}/?page=wallet&view=deposit` } },
      ],
      [{ text: labels.channel }],
      ...(hasContact ? [] : [[{ text: labels.contact, request_contact: true }]]),
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Choose an option',
  };
}

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
    const language = ['am', 'so', 'om'].includes(message.from.language_code || '') ? message.from.language_code as string : 'am';
    const user = await env.DB.prepare(`INSERT INTO users (telegram_id, username, first_name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username), first_name = excluded.first_name, updated_at = CURRENT_TIMESTAMP
      RETURNING id`).bind(telegramId, username, firstName, language).first<{ id: number }>();
    if (user && user.id !== agent.user_id) {
      await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO referrals (id, referred_user_id, agent_id, source_code) VALUES (?, ?, ?, ?)`)
          .bind(crypto.randomUUID(), user.id, agent.id, agentCode),
        ...agentSignupBonusStatements(env, user.id),
      ]);
    }
  }
  const lang = botLanguage(message.from?.language_code);
  const telegramId = Number.isSafeInteger(message.from?.id) && (message.from?.id || 0) > 0 ? message.from!.id! : null;
  const account = telegramId ? await env.DB.prepare(`SELECT u.id,
      EXISTS(SELECT 1 FROM user_contacts c WHERE c.user_id = u.id) AS phone_shared
    FROM users u WHERE u.telegram_id = ?`).bind(telegramId).first<{ id: number; phone_shared: number }>() : null;
  const hasContact = account?.phone_shared === 1;
  const base = new URL(request.url).origin;
  const chatId = message.chat!.id;
  const isOwner = Boolean(env.SUPER_ADMIN_TELEGRAM_ID && message.from && String(message.from.id) === env.SUPER_ADMIN_TELEGRAM_ID);
  const channelUrl = telegramChannelUrl(env.TELEGRAM_CHANNEL_URL);
  const channelLabels = new Set(Object.values(botMenuLabels).map((labels) => labels.channel));
  const send = (text: string, reply_markup?: unknown) => telegramApi<unknown>(env.TELEGRAM_BOT_TOKEN!, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(reply_markup ? { reply_markup } : {}),
  });
  const webAppButton = (label: string, path: string) => ({
    inline_keyboard: [[{ text: label, web_app: { url: `${base}${path}` } }]],
  });
  const menu = (playUrl = base) => botMenuKeyboard(base, lang, hasContact, playUrl);
  const ownerButton = isOwner ? [{ text: 'Owner dashboard', web_app: { url: `${base}/admin` } }] : [];

  if (command === '/channel' || channelLabels.has(message.text.trim())) {
    await send(
      channelUrl ? botText.channel[lang] : botText.channelMissing[lang],
      channelUrl ? { inline_keyboard: [[{ text: botButtons[lang].channel, url: channelUrl }]] } : undefined,
    );
    return json({ ok: true });
  }

  if (command === '/promo') {
    if (!isOwner) {
      await send(botText.ownerOnly[lang]);
      return json({ ok: true });
    }
    const promoMarkup = { inline_keyboard: [[{ text: 'Play Now', url: `https://t.me/${(env.BOT_USERNAME || 'Dire_Bet_bot').replace(/^@/, '')}` }]] };
    try {
      await telegramApi<unknown>(env.TELEGRAM_BOT_TOKEN, 'sendPhoto', {
        chat_id: chatId,
        photo: `${base}/promotions/play-together.png`,
        caption: botText.promo[lang],
        parse_mode: 'HTML',
        reply_markup: promoMarkup,
      });
    } catch {
      await send(botText.promo[lang], promoMarkup);
    }
    return json({ ok: true });
  }

  if (command === '/admin') {
    await send(
      isOwner ? 'Owner access verified. Open the dashboard below.' : 'The owner dashboard is available only to the configured owner Telegram account.',
      isOwner ? { inline_keyboard: [ownerButton] } : undefined,
    );
    return json({ ok: true });
  }

  if (command === '/start') {
    const playUrl = roomPayload ? `${base}/?room=${roomPayload}` : agentCode && agent ? `${base}/?ref=${encodeURIComponent(agentCode)}` : base;
    const notice = roomPayload
      ? `\n\n${botText.roomReady[lang].replace('{code}', roomPayload)}`
      : agentCode && agent ? `\n\n${botText.promoLinked[lang].replace('{code}', agentCode)}` : '';
    const intro = hasContact ? welcomeBack[lang] : welcome[lang];
    const introMarkup = {
      inline_keyboard: [
        [{ text: roomPayload ? `🎮 Join room · ${roomPayload}` : botButtons[lang].play, web_app: { url: playUrl } }],
        ...(isOwner ? [ownerButton] : []),
      ],
    };
    if (hasContact) {
      await send(`${intro}${notice}`, introMarkup);
    } else {
      try {
        await telegramApi<unknown>(env.TELEGRAM_BOT_TOKEN, 'sendPhoto', {
          chat_id: chatId,
          photo: `${base}/promotions/play-together.png`,
          caption: `${intro}${notice}`,
          parse_mode: 'HTML',
          reply_markup: introMarkup,
        });
      } catch {
        await send(`${intro}${notice}`, introMarkup);
      }
    }
    await send(hasContact ? menuPrompt[lang] : registrationText[lang], menu(playUrl));
    return json({ ok: true });
  }

  if (command === '/play' || command === '/games') {
    await send(botText[command === '/play' ? 'play' : 'games'][lang], webAppButton(botButtons[lang].play, '/'));
    return json({ ok: true });
  }

  if (command === '/wallet') {
    await send(botText.wallet[lang], webAppButton(botButtons[lang].wallet, '/?page=wallet'));
    return json({ ok: true });
  }

  if (command === '/deposit') {
    await send(botText.deposit[lang], webAppButton(botButtons[lang].deposit, '/?page=wallet&view=deposit'));
    return json({ ok: true });
  }

  if (command === '/account') {
    await send(botText.account[lang], webAppButton(botButtons[lang].login, '/?page=account'));
    return json({ ok: true });
  }

  if (command === '/profile') {
    await send(botText.profile[lang], webAppButton(botButtons[lang].play, '/'));
    return json({ ok: true });
  }

  if (command === '/help' || command === '/support') {
    await send(botText.help[lang], {
      inline_keyboard: [
        [{ text: botButtons[lang].play, web_app: { url: base } }],
        [{ text: botButtons[lang].wallet, web_app: { url: `${base}/?page=wallet` } }],
      ],
    });
    return json({ ok: true });
  }

  await send(botText.fallback[lang], menu());
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
      { command: 'start', description: 'Open DIRE BET' },
      { command: 'play', description: 'Play a game' },
      { command: 'games', description: 'See available games' },
      { command: 'wallet', description: 'Open your wallet' },
      { command: 'deposit', description: 'Add funds' },
      { command: 'channel', description: 'Open the official channel' },
      { command: 'account', description: 'Set up web login' },
      { command: 'help', description: 'Get help' },
    ] });
    await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Play', web_app: { url: origin } } });
    await call('setMyDescription', { description: botProfileDescription });
    await call('setMyShortDescription', { short_description: botProfileShortDescription });
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
  const lang = typeof user.language_code === 'string' && ['am', 'so', 'om'].includes(user.language_code) ? user.language_code : 'am';
  try {
    const result = await env.DB.prepare(`INSERT INTO users (telegram_id, username, first_name, last_name, language, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
      last_name = excluded.last_name, updated_at = CURRENT_TIMESTAMP RETURNING id`).bind(id, username, firstName, lastName, lang).first<{ id: number }>();
    if (!result) return json({ error: 'Could not create session' }, 500);
    if (parsed.data.refreshToken) await revokeRefreshToken(env, parsed.data.refreshToken).catch(() => undefined);
    const displayName = telegramAccountName({ first_name: firstName, last_name: lastName, username });
    return await issueAuthResponse(env, result.id, request, { displayName, username, language: lang });
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
  return await issueAuthResponse(env, user.id, request, { displayName: user.web_username }, PASSWORD_SESSION_LIFETIME);
}

async function storeTelegramContact(message: { chat?: { id?: number }; from?: { id?: number; username?: string; first_name?: string; last_name?: string; language_code?: string }; contact?: { user_id?: number; phone_number?: string; first_name?: string } }, env: Env, origin: string): Promise<void> {
  const telegramId = message.from?.id;
  const phone = message.contact?.phone_number?.trim();
  const language = botLanguage(message.from?.language_code);
  if (!env.SESSION_SECRET || !Number.isSafeInteger(telegramId) || telegramId! <= 0 || message.contact?.user_id !== telegramId || !phone || !/^[+\d().\s-]{7,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7 || phone.replace(/\D/g, '').length > 15) {
    if (typeof message.chat?.id === 'number' && env.TELEGRAM_BOT_TOKEN) await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', { chat_id: message.chat.id, text: botText.contactRequired[language], parse_mode: 'HTML' });
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
    await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: botText.contactLinked[language],
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: botButtons[language].login, web_app: { url: `${origin}/?page=account` } }]] },
    });
    await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
      chat_id: message.chat.id,
      text: menuPrompt[language],
      parse_mode: 'HTML',
      reply_markup: botMenuKeyboard(origin, language, true),
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

function validEthiopianPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.trim().replace(/[^\d+]/g, '');
  if (/^\+251[79]\d{8}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^251[79]\d{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^0[79]\d{8}$/.test(digits)) return digits;
  return null;
}

function validRequestAmount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 50 && (value as number) <= 10_000 ? value as number : null;
}

async function smsSha256(value: string): Promise<string> {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(normalized)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reviewFlags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
  } catch { return []; }
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

async function depositProofCanBeReviewed(env: Env, requestId: string): Promise<boolean> {
  const request = await env.DB.prepare('SELECT proof_method, confirmation_sms_ciphertext FROM deposit_requests WHERE id = ?').bind(requestId).first<{ proof_method: 'receipt' | 'sms'; confirmation_sms_ciphertext: string | null }>();
  if (!request) return false;
  if (request.proof_method === 'sms') {
    try { return Boolean(request.confirmation_sms_ciphertext && (await decryptContact(request.confirmation_sms_ciphertext, env.SESSION_SECRET || '')).trim().length >= 8); }
    catch { return false; }
  }
  const receipt = await env.DB.prepare('SELECT content_type, encrypted_blob FROM receipt_blobs WHERE deposit_request_id = ?').bind(requestId).first<{ content_type: 'image/png' | 'image/jpeg'; encrypted_blob: ArrayBuffer | Uint8Array }>();
  if (!receipt) return false;
  try {
    const bytes = receipt.encrypted_blob instanceof Uint8Array ? receipt.encrypted_blob : new Uint8Array(receipt.encrypted_blob);
    const encoded = await decryptContact(new TextDecoder().decode(bytes), env.SESSION_SECRET || '');
    const image = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const png = image.length >= 8 && image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47 && image[4] === 0x0d && image[5] === 0x0a && image[6] === 0x1a && image[7] === 0x0a;
    const jpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
    return receipt.content_type === 'image/png' ? png : jpeg;
  } catch { return false; }
}

async function recordAdminAudit(env: Env, adminId: number, action: string, entityType: string, entityId: string, before: unknown, after: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json)
    VALUES (?, 'admin', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), String(adminId), action, entityType, entityId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)).run();
}

async function adminActivationStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT minimum_age, approved_at FROM activation_records ORDER BY approved_at DESC, id DESC LIMIT 1').first<{ minimum_age: number; approved_at: string }>();
  return json({ active: await moneyActivationRecorded(env), simulationEnabled: env.SIMULATED_WALLET_ENABLED === 'true', configured: env.REAL_MONEY_ENABLED === 'true' && env.DEMO_MODE === 'false', record: row || null });
}

async function recordActivationEvidence(request: Request, env: Env, adminId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as {
    counselApproval?: unknown; licenseReview?: unknown; licenseReferences?: unknown; providerApprovals?: unknown;
    telegramApproval?: unknown; nationalBankReview?: unknown; ageVerificationMethod?: unknown;
    responsiblePlayPolicy?: unknown; privacyReview?: unknown; minimumAge?: unknown; ownerSignedAt?: unknown;
  } | null;
  const providers = input?.providerApprovals as { telebirr?: unknown; ebirr?: unknown } | undefined;
  const licenseReferences = input?.licenseReferences;
  if (!input || !validEvidenceReference(input.counselApproval) || !validEvidenceReference(input.licenseReview)
    || !Array.isArray(licenseReferences) || licenseReferences.length < 1 || licenseReferences.length > 20 || !licenseReferences.every(validEvidenceReference)
    || !validEvidenceReference(providers?.telebirr) || !validEvidenceReference(providers?.ebirr)
    || !validEvidenceReference(input.telegramApproval) || !validEvidenceReference(input.nationalBankReview)
    || !validEvidenceReference(input.ageVerificationMethod) || !validEvidenceReference(input.responsiblePlayPolicy)
    || !validEvidenceReference(input.privacyReview) || !Number.isInteger(input.minimumAge) || (input.minimumAge as number) < 18 || (input.minimumAge as number) > 120
    || typeof input.ownerSignedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.ownerSignedAt)
    || !Number.isFinite(Date.parse(`${input.ownerSignedAt}T00:00:00Z`)) || Date.parse(`${input.ownerSignedAt}T00:00:00Z`) > Date.now()) {
    return json({ error: 'Record the legal, license, Telebirr, eBirr, Telegram, age, responsible-play, privacy and owner approval references before activation.' }, 400);
  }
  const evidence = {
    counselApproval: input.counselApproval.trim(), licenseReview: input.licenseReview.trim(),
    licenseReferences: licenseReferences.map((value) => value.trim()),
    providerApprovals: { telebirr: providers!.telebirr!.trim(), ebirr: providers!.ebirr!.trim() },
    telegramApproval: input.telegramApproval.trim(), nationalBankReview: input.nationalBankReview.trim(),
    ageVerificationMethod: input.ageVerificationMethod.trim(), responsiblePlayPolicy: input.responsiblePlayPolicy.trim(),
    privacyReview: input.privacyReview.trim(), minimumAge: input.minimumAge, ownerSignedAt: input.ownerSignedAt,
  };
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO activation_records (id, evidence_json, minimum_age, approved_by) VALUES (?, ?, ?, ?)')
      .bind(id, JSON.stringify(evidence), input.minimumAge, String(adminId)),
    env.DB.prepare(`INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, after_json)
      VALUES (?, 'admin', ?, 'REAL_MONEY_ACTIVATION_RECORDED', 'activation_record', ?, ?)`)
      .bind(crypto.randomUUID(), String(adminId), id, JSON.stringify({ minimumAge: input.minimumAge, evidence })),
  ]);
  return json({ recorded: true, active: await moneyActivationRecorded(env), configured: env.REAL_MONEY_ENABLED === 'true' && env.DEMO_MODE === 'false', id }, 201);
}

async function walletMode(env: Env): Promise<'real' | 'simulation' | null> {
  if (await moneyActivationRecorded(env)) return 'real';
  return env.SIMULATED_WALLET_ENABLED === 'true' ? 'simulation' : null;
}

async function publicPaymentSettings(env: Env): Promise<Response> {
  const mode = await walletMode(env);
  const result = await env.DB.prepare(`SELECT provider, account_label, account_number, enabled, minimum_santim, maximum_santim,
    withdrawal_minimum_santim, withdrawal_maximum_santim
    FROM payment_settings WHERE provider IN ('telebirr','ebirr') ORDER BY provider`).all<{
      provider: PaymentProvider; account_label: string | null; account_number: string | null; enabled: number; minimum_santim: number | null; maximum_santim: number | null;
      withdrawal_minimum_santim: number | null; withdrawal_maximum_santim: number | null;
    }>();
  return json({ moneyEnabled: mode === 'real', simulationOnly: mode === 'simulation', providers: result.results.map((row) => ({
    provider: row.provider, accountLabel: mode && row.enabled === 1 ? row.account_label || '' : '',
    accountNumber: mode && row.enabled === 1 ? row.account_number || '' : '',
    enabled: mode !== null && row.enabled === 1,
    minimumAmount: Math.ceil((row.minimum_santim || 5000) / 100),
    maximumAmount: Math.floor((row.maximum_santim || 1_000_000) / 100),
    withdrawalMinimumAmount: Math.ceil((row.withdrawal_minimum_santim || 10000) / 100),
    withdrawalMaximumAmount: Math.floor((row.withdrawal_maximum_santim || 1_000_000) / 100),
  })) });
}

async function playerWalletBalance(env: Env, userId: number): Promise<Response> {
  const mode = await walletMode(env);
  if (!mode) return json({ enabled: false, balance: null, simulated: false, error: 'Wallet services are unavailable until required approvals are recorded.' }, 403);
  if (mode === 'real') {
    const eligibility = await moneyEligibilityError(env, userId);
    if (eligibility) return json({ enabled: true, balance: null, simulated: false, error: eligibility }, 403);
  }
  const kind = mode === 'real' ? 'real' : 'demo';
  const row = await env.DB.prepare('SELECT balance_santim FROM wallets WHERE user_id = ? AND wallet_kind = ?').bind(userId, kind).first<{ balance_santim: number }>();
  return json({ enabled: true, simulated: mode === 'simulation', balanceSantim: row?.balance_santim || 0, balance: (row?.balance_santim || 0) / 100 });
}

async function playerWalletRequests(env: Env, userId: number): Promise<Response> {
  const mode = await walletMode(env);
  if (!mode) return json({ deposits: [], withdrawals: [], lastWithdrawalPhone: null });
  const walletKind = mode === 'real' ? 'real' : 'demo';
  const simulationOnly = mode === 'simulation' ? 1 : 0;
  const [deposits, withdrawals, lastWithdrawal] = await Promise.all([
    env.DB.prepare(`SELECT id, provider, amount_santim, provider_reference, status, review_reason, created_at, reviewed_at
      FROM deposit_requests WHERE user_id = ? AND wallet_kind = ? AND simulation_only = ? ORDER BY created_at DESC LIMIT 30`).bind(userId, walletKind, simulationOnly).all<{
        id: string; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      }>(),
    env.DB.prepare(`SELECT id, provider, amount_santim, status, review_reason, created_at, reviewed_at
      FROM withdrawal_requests WHERE user_id = ? AND wallet_kind = ? AND simulation_only = ? ORDER BY created_at DESC LIMIT 30`).bind(userId, walletKind, simulationOnly).all<{
        id: string; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      }>(),
    env.DB.prepare(`SELECT destination_phone_ciphertext FROM withdrawal_requests
      WHERE user_id = ? AND wallet_kind = ? AND simulation_only = ? AND destination_phone_ciphertext IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).bind(userId, walletKind, simulationOnly).first<{ destination_phone_ciphertext: string }>(),
  ]);
  let lastWithdrawalPhone: string | null = null;
  try {
    if (lastWithdrawal?.destination_phone_ciphertext) lastWithdrawalPhone = await decryptContact(lastWithdrawal.destination_phone_ciphertext, env.SESSION_SECRET || '');
  } catch { /* The saved number is optional; the form stays editable. */ }
  return json({
    simulationOnly: mode === 'simulation',
    deposits: deposits.results.map((row) => ({ ...row, amount: row.amount_santim / 100 })),
    withdrawals: withdrawals.results.map((row) => ({ ...row, amount: row.amount_santim / 100 })),
    lastWithdrawalPhone,
  });
}

async function createRealDeposit(request: Request, env: Env, userId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const mode = await walletMode(env);
  if (!mode) return json({ error: 'Deposits are unavailable until required approvals are recorded.' }, 403);
  if (mode === 'real') {
    const eligibility = await moneyEligibilityError(env, userId);
    if (eligibility) return json({ error: eligibility }, 403);
  }
  if (!(await allowRateLimit(env, `wallet:${userId}`, 'deposit-request', 5, 3600))) return json({ error: 'Too many requests. Try again later.' }, 429);
  const input = await request.json().catch(() => null) as { provider?: unknown; amount?: unknown; senderPhone?: unknown; transactionReference?: unknown; confirmationSms?: unknown; idempotencyKey?: unknown } | null;
  const provider = paymentProvider(input?.provider);
  const amount = validRequestAmount(input?.amount);
  const confirmationSms = typeof input?.confirmationSms === 'string' ? input.confirmationSms.trim() : '';
  const idempotencyKey = validIdempotencyKey(input?.idempotencyKey);
  if (!input || !provider || !amount || !idempotencyKey) return json({ error: 'Check the payment method and whole-birr amount.' }, 400);
  if (confirmationSms.length < 8) return json({ error: 'Paste the payment confirmation SMS.' }, 400);
  if (confirmationSms.length > 1000) return json({ error: 'The confirmation SMS must be 1,000 characters or fewer.' }, 400);

  const extractedSms = parseTransactionSms(confirmationSms, provider);
  const senderPhone = validPaymentPhone(input.senderPhone) || validPaymentPhone(extractedSms?.senderPhone) || null;
  const typedReference = typeof input.transactionReference === 'string' ? input.transactionReference.trim() : '';
  const reference = typedReference || extractedSms?.reference || null;
  if (reference && (reference.length < 5 || reference.length > 80 || !/^[\p{L}\p{N}._/-]+$/u.test(reference))) {
    return json({ error: 'The transaction reference could not be read. Paste the full SMS and try again.' }, 400);
  }

  const settings = await env.DB.prepare('SELECT account_number, enabled, minimum_santim, maximum_santim FROM payment_settings WHERE provider = ?').bind(provider).first<{ account_number: string | null; enabled: number; minimum_santim: number | null; maximum_santim: number | null }>();
  if (!settings || settings.enabled !== 1 || !settings.account_number) return json({ error: 'That payment method is not available.' }, 409);
  if (amount * 100 < (settings.minimum_santim || 5000) || amount * 100 > (settings.maximum_santim || 1_000_000)) return json({ error: 'The amount is outside the configured request range.' }, 400);

  const old = await env.DB.prepare('SELECT id, user_id, status FROM deposit_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; user_id: number; status: string }>();
  if (old) return old.user_id === userId ? json({ requestId: old.id, status: old.status, repeated: true }) : json({ error: 'Request key was already used.' }, 409);

  const smsHash = await smsSha256(confirmationSms);
  const duplicateSms = await env.DB.prepare('SELECT id FROM deposit_requests WHERE sms_sha256 = ?').bind(smsHash).first<{ id: string }>();
  if (duplicateSms) return json({ error: 'That payment SMS was already submitted.' }, 409);
  if (reference) {
    const existingRef = await env.DB.prepare('SELECT id FROM deposit_requests WHERE provider = ? AND provider_reference = ?').bind(provider, reference).first();
    if (existingRef) return json({ error: 'That transaction reference was already submitted.' }, 409);
  }

  const walletKind = mode === 'real' ? 'real' : 'demo';
  const verification = reference
    ? await verifyDepositTransaction(env, {
        provider,
        reference,
        expectedAmountSantim: amount * 100,
        extractedSms,
        walletKind,
        simulationOnly: mode === 'simulation',
      })
    : { verified: false, autoApprove: false, status: 'pending' as const, reason: 'No transaction reference was found in the SMS; queued for manual admin review.' };
  if (verification.duplicate) return json({ error: verification.error || 'That transaction reference was already submitted.' }, 409);

  const flags: string[] = [];
  if (!extractedSms) flags.push('unreadable_sms');
  else {
    if (extractedSms.amountSantim !== null && extractedSms.amountSantim !== amount * 100) flags.push('amount_mismatch');
    if (extractedSms.status === 'failed') flags.push('failed_sms');
    if (!extractedSms.isCrediblePaymentSms) flags.push('unverified_sms');
  }

  const id = `DP-${Date.now().toString(36).toUpperCase()}-${randomCode(4)}`;
  const senderCiphertext = senderPhone ? await encryptContact(senderPhone, env.SESSION_SECRET || '') : null;
  const smsCiphertext = await encryptContact(confirmationSms, env.SESSION_SECRET || '');
  const statements = [env.DB.prepare(`INSERT INTO deposit_requests
    (id, user_id, wallet_kind, simulation_only, provider, amount_santim, provider_reference, status, idempotency_key, sender_phone_ciphertext, proof_method, confirmation_sms_ciphertext, sms_sha256, review_flags)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'sms', ?, ?, ?)`)
    .bind(id, userId, walletKind, mode === 'simulation' ? 1 : 0, provider, amount * 100, reference, idempotencyKey, senderCiphertext, smsCiphertext, smsHash, flags.length ? JSON.stringify(flags) : null)];
  if (verification.autoApprove) {
    statements.push(env.DB.prepare(`UPDATE deposit_requests SET status = 'approved', reviewed_by = 'system:auto-verified', reviewed_at = CURRENT_TIMESTAMP, review_reason = ? WHERE id = ? AND status = 'pending'`).bind(verification.reason, id));
  }
  try { await env.DB.batch(statements); }
  catch { return json({ error: 'That request could not be saved. Check whether its payment SMS was already used.' }, 409); }
  return json({ requestId: id, status: verification.autoApprove ? 'approved' : 'pending', verified: verification.autoApprove, autoApproved: verification.autoApprove, simulationOnly: mode === 'simulation' }, 201);
}

async function createRealWithdrawal(request: Request, env: Env, userId: number): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const mode = await walletMode(env);
  if (!mode) return json({ error: 'Withdrawals are unavailable until required approvals are recorded.' }, 403);
  if (mode === 'real') {
    const eligibility = await moneyEligibilityError(env, userId);
    if (eligibility) return json({ error: eligibility }, 403);
  }
  if (!(await allowRateLimit(env, `wallet:${userId}`, 'withdrawal-request', 5, 3600))) return json({ error: 'Too many requests. Try again later.' }, 429);
  const input = await request.json().catch(() => null) as { provider?: unknown; amount?: unknown; destinationPhone?: unknown; accountHolderName?: unknown; idempotencyKey?: unknown } | null;
  const provider = paymentProvider(input?.provider);
  const amount = validRequestAmount(input?.amount);
  const destination = validEthiopianPhone(input?.destinationPhone);
  const accountHolderText = typeof input?.accountHolderName === 'string' ? input.accountHolderName.trim() : '';
  const accountHolder = accountHolderText.length >= 2 && accountHolderText.length <= 100 ? accountHolderText : null;
  const idempotencyKey = validIdempotencyKey(input?.idempotencyKey);
  if (!input || !provider || !amount || !destination || !idempotencyKey) return json({ error: 'Check the payment method, whole-birr amount and phone number.' }, 400);
  const settings = await env.DB.prepare('SELECT enabled, minimum_santim, maximum_santim, withdrawal_minimum_santim, withdrawal_maximum_santim FROM payment_settings WHERE provider = ?').bind(provider).first<{
    enabled: number; minimum_santim: number | null; maximum_santim: number | null; withdrawal_minimum_santim: number | null; withdrawal_maximum_santim: number | null;
  }>();
  if (!settings || settings.enabled !== 1) return json({ error: 'That withdrawal method is not available.' }, 409);
  const minimumSantim = settings.withdrawal_minimum_santim || 10000;
  const maximumSantim = settings.withdrawal_maximum_santim || 1_000_000;
  if (amount * 100 < minimumSantim || amount * 100 > maximumSantim) return json({ error: `Enter a withdrawal amount from ${Math.ceil(minimumSantim / 100)} to ${Math.floor(maximumSantim / 100)} Birr.` }, 400);
  const old = await env.DB.prepare('SELECT id, user_id, status FROM withdrawal_requests WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; user_id: number; status: string }>();
  if (old) return old.user_id === userId ? json({ requestId: old.id, status: old.status, repeated: true }) : json({ error: 'Request key was already used.' }, 409);
  const id = `WD-${Date.now().toString(36).toUpperCase()}-${randomCode(4)}`;
  const phoneCiphertext = await encryptContact(destination, env.SESSION_SECRET || '');
  const nameCiphertext = accountHolder ? await encryptContact(accountHolder, env.SESSION_SECRET || '') : null;
  const walletKind = mode === 'real' ? 'real' : 'demo';
  const simulationOnly = mode === 'simulation' ? 1 : 0;
  try {
    await env.DB.prepare(`INSERT INTO withdrawal_requests
      (id, user_id, wallet_kind, simulation_only, amount_santim, provider, status, idempotency_key, destination_phone_ciphertext, account_holder_ciphertext)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .bind(id, userId, walletKind, simulationOnly, amount * 100, provider, idempotencyKey, phoneCiphertext, nameCiphertext).run();
  } catch { return json({ error: 'The request could not be saved. Check the available wallet balance and try again.' }, 409); }
  return json({ requestId: id, status: 'pending', simulationOnly: mode === 'simulation' }, 201);
}

async function adminWalletList(env: Env, adminId: number, kind: 'deposits' | 'withdrawals'): Promise<Response> {
  const mode = await walletMode(env);
  if (!mode) return json({ requests: [], count: 0, simulationOnly: false });
  const walletKind = mode === 'real' ? 'real' : 'demo';
  const simulationOnly = mode === 'simulation' ? 1 : 0;
  if (kind === 'deposits') {
    const rows = await env.DB.prepare(`SELECT d.id, d.user_id, d.provider, d.amount_santim, d.provider_reference, d.status, d.review_reason, d.created_at, d.reviewed_at,
      d.simulation_only, u.first_name, u.username, u.web_username, d.proof_method, d.review_flags, EXISTS(SELECT 1 FROM receipt_blobs b WHERE b.deposit_request_id = d.id) AS has_receipt,
      CASE WHEN d.confirmation_sms_ciphertext IS NOT NULL THEN 1 ELSE 0 END AS has_sms
      FROM deposit_requests d JOIN users u ON u.id = d.user_id WHERE d.wallet_kind = ? AND d.simulation_only = ? ORDER BY d.created_at DESC LIMIT 100`).bind(walletKind, simulationOnly).all<{
        id: string; user_id: number; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
        simulation_only: number; first_name: string; username: string | null; web_username: string | null; proof_method: 'receipt' | 'sms'; review_flags: string | null; has_receipt: number; has_sms: number;
      }>();
    const details = await Promise.all(rows.results.map(async (row) => {
      const protectedFields = await env.DB.prepare('SELECT sender_phone_ciphertext, confirmation_sms_ciphertext FROM deposit_requests WHERE id = ?').bind(row.id).first<{ sender_phone_ciphertext: string | null; confirmation_sms_ciphertext: string | null }>();
      let senderPhone = ''; let confirmationSmsPreview = '';
      try { if (protectedFields?.sender_phone_ciphertext) senderPhone = await decryptContact(protectedFields.sender_phone_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
      try {
        if (protectedFields?.confirmation_sms_ciphertext) {
          const sms = await decryptContact(protectedFields.confirmation_sms_ciphertext, env.SESSION_SECRET || '');
          confirmationSmsPreview = sms.length > 140 ? `${sms.slice(0, 140)}…` : sms;
        }
      } catch { /* The request remains visible without its protected field. */ }
      return { ...row, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, senderPhone, confirmationSmsPreview, flags: reviewFlags(row.review_flags), simulationOnly: row.simulation_only === 1 };
    }));
    return json({ requests: details, count: details.length, simulationOnly: mode === 'simulation' });
  }
  const rows = await env.DB.prepare(`SELECT w.id, w.user_id, w.provider, w.amount_santim, w.status, w.review_reason, w.created_at, w.reviewed_at,
    w.simulation_only, COALESCE(wallet.balance_santim, 0) AS balance_santim, u.first_name, u.username, u.web_username
    FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
    LEFT JOIN wallets wallet ON wallet.user_id = w.user_id AND wallet.wallet_kind = w.wallet_kind
    WHERE w.wallet_kind = ? AND w.simulation_only = ? ORDER BY w.created_at DESC LIMIT 100`).bind(walletKind, simulationOnly).all<{
      id: string; user_id: number; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
      simulation_only: number; balance_santim: number;
      first_name: string; username: string | null; web_username: string | null;
    }>();
  const details = await Promise.all(rows.results.map(async (row) => {
    const protectedFields = await env.DB.prepare('SELECT destination_phone_ciphertext, account_holder_ciphertext FROM withdrawal_requests WHERE id = ?').bind(row.id).first<{ destination_phone_ciphertext: string | null; account_holder_ciphertext: string | null }>();
    let destinationPhone = ''; let accountHolderName = '';
    try { if (protectedFields?.destination_phone_ciphertext) destinationPhone = await decryptContact(protectedFields.destination_phone_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
    try { if (protectedFields?.account_holder_ciphertext) accountHolderName = await decryptContact(protectedFields.account_holder_ciphertext, env.SESSION_SECRET || ''); } catch { /* The request remains visible without its protected field. */ }
    return { ...row, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, balance: row.balance_santim / 100, destinationPhone, accountHolderName, simulationOnly: row.simulation_only === 1 };
  }));
  return json({ requests: details, count: details.length, simulationOnly: mode === 'simulation' });
}

async function adminWalletSummary(env: Env): Promise<Response> {
  const mode = await walletMode(env);
  if (!mode) return json({ simulationOnly: false, pendingDeposits: 0, pendingWithdrawals: 0, approvedWithdrawals: 0, completedWithdrawals: 0, totalWithdrawalAmount: 0 });
  const walletKind = mode === 'real' ? 'real' : 'demo';
  const simulationOnly = mode === 'simulation' ? 1 : 0;
  const [deposits, withdrawals] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS count FROM deposit_requests WHERE wallet_kind = ? AND simulation_only = ? AND status IN ('pending','needs_info')`).bind(walletKind, simulationOnly).first<{ count: number }>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status IN ('pending','reviewing') THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status != 'rejected' THEN amount_santim ELSE 0 END) AS total_santim
      FROM withdrawal_requests WHERE wallet_kind = ? AND simulation_only = ?`).bind(walletKind, simulationOnly).first<{ pending: number | null; approved: number | null; completed: number | null; total_santim: number | null }>(),
  ]);
  return json({ simulationOnly: mode === 'simulation', pendingDeposits: deposits?.count || 0,
    pendingWithdrawals: withdrawals?.pending || 0, approvedWithdrawals: withdrawals?.approved || 0,
    completedWithdrawals: withdrawals?.completed || 0, totalWithdrawalAmount: (withdrawals?.total_santim || 0) / 100 });
}

async function reviewWalletRequest(request: Request, env: Env, adminId: number, kind: 'deposits' | 'withdrawals', id: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
  const input = await request.json().catch(() => null) as { status?: unknown; reason?: unknown; paymentReference?: unknown } | null;
  if (!input || typeof input.status !== 'string') return json({ error: 'Choose a valid review action.' }, 400);
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if ((input.status === 'needs_info' || input.status === 'rejected') && reason.length < 3) return json({ error: 'Add a short note for this request.' }, 400);
  const mode = await walletMode(env);
  if (!mode) return json({ error: 'Wallet requests are unavailable until required approvals are recorded.' }, 403);
  const walletKind = mode === 'real' ? 'real' : 'demo';
  const simulationOnly = mode === 'simulation' ? 1 : 0;
  const table = kind === 'deposits' ? 'deposit_requests' : 'withdrawal_requests';
  const old = await env.DB.prepare(`SELECT status, wallet_kind, simulation_only, user_id FROM ${table} WHERE id = ?`).bind(id).first<{ status: string; wallet_kind: string; simulation_only: number; user_id: number }>();
  if (!old) return json({ error: 'Request not found.' }, 404);
  if (old.wallet_kind !== walletKind || old.simulation_only !== simulationOnly) return json({ error: 'This request belongs to a different wallet mode.' }, 409);
  const transitions = kind === 'deposits'
    ? { pending: ['needs_info', 'approved', 'rejected'], needs_info: ['needs_info', 'approved', 'rejected'] } as Record<string, string[]>
    : { pending: ['reviewing', 'approved', 'rejected'], reviewing: ['approved', 'rejected'], approved: ['paid', 'rejected'] } as Record<string, string[]>;
  if (!transitions[old.status]?.includes(input.status)) return json({ error: 'This request cannot move to that status.' }, 409);
  if (input.status === 'approved' && mode === 'real') {
    const eligibility = await moneyEligibilityError(env, old.user_id);
    if (eligibility) return json({ error: eligibility }, 409);
    if (kind === 'deposits') {
      if (!(await depositProofCanBeReviewed(env, id))) return json({ error: 'A readable receipt photo or payment SMS is required before approving this deposit.' }, 409);
    }
  }
  const paymentReference = typeof input.paymentReference === 'string' ? input.paymentReference.trim().slice(0, 100) : '';
  if (input.status === 'paid' && paymentReference.length < 3) return json({ error: 'Enter the payout transfer reference before marking it complete.' }, 400);
  let result: D1Result;
  try {
    result = kind === 'deposits'
      ? await env.DB.prepare(`UPDATE deposit_requests SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND wallet_kind = ? AND simulation_only = ? AND status = ?`)
        .bind(input.status, reason || null, String(adminId), id, walletKind, simulationOnly, old.status).run()
      : await env.DB.prepare(`UPDATE withdrawal_requests SET status = ?, review_reason = ?, reviewed_by = ?,
          approved_by = CASE WHEN ? = 'approved' THEN ? ELSE approved_by END,
          paid_at = CASE WHEN ? = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END,
          payment_reference = CASE WHEN ? = 'paid' THEN ? ELSE payment_reference END,
          reviewed_at = CURRENT_TIMESTAMP
          WHERE id = ? AND wallet_kind = ? AND simulation_only = ? AND status = ?`)
        .bind(input.status, reason || null, String(adminId), input.status, String(adminId), input.status, input.status, paymentReference || null, id, walletKind, simulationOnly, old.status).run();
  } catch { return json({ error: 'The review could not be saved. No status or balance was changed.' }, 409); }
  if (!result.meta.changes) return json({ error: 'This request has already been reviewed.' }, 409);
  return json({ ok: true, status: input.status, simulationOnly: mode === 'simulation', balanceChanged: (kind === 'deposits' && input.status === 'approved') || (kind === 'withdrawals' && input.status === 'rejected') });
}

async function adminPaymentSettings(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`SELECT provider, account_label, account_number, enabled, minimum_santim, maximum_santim,
    withdrawal_minimum_santim, withdrawal_maximum_santim, updated_at
    FROM payment_settings WHERE provider IN ('telebirr','ebirr') ORDER BY provider`).all<{
      provider: PaymentProvider; account_label: string | null; account_number: string | null; enabled: number; minimum_santim: number | null; maximum_santim: number | null;
      withdrawal_minimum_santim: number | null; withdrawal_maximum_santim: number | null; updated_at: string;
    }>();
  return json({ simulationEnabled: env.SIMULATED_WALLET_ENABLED === 'true', providers: result.results.map((row) => ({
    provider: row.provider, accountLabel: row.account_label || '', accountNumber: row.account_number || '', enabled: row.enabled === 1,
    minimumAmount: Math.ceil((row.minimum_santim || 5000) / 100), maximumAmount: Math.floor((row.maximum_santim || 1_000_000) / 100),
    withdrawalMinimumAmount: Math.ceil((row.withdrawal_minimum_santim || 10000) / 100), withdrawalMaximumAmount: Math.floor((row.withdrawal_maximum_santim || 1_000_000) / 100),
    updatedAt: row.updated_at,
  })) });
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
    const accountNumber = typeof row.accountNumber === 'string' ? row.accountNumber.trim() : '';
    const number = accountNumber ? validPaymentPhone(accountNumber) : null;
    if (!provider || label.length > 100 || (accountNumber && !number) || (row.enabled === true && !number) || typeof row.enabled !== 'boolean') return null;
    return { provider, label, number, enabled: row.enabled };
  });
  if (parsed.some((item) => item === null) || new Set(parsed.map((item) => item?.provider)).size !== 2) return json({ error: 'Check both account names, numbers and enabled switches.' }, 400);
  if (parsed.some((row) => row?.enabled) && !(await moneyActivationRecorded(env)) && env.SIMULATED_WALLET_ENABLED !== 'true') return json({ error: 'Payment methods cannot be shown until the legal and provider approval gate is active.' }, 403);
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
  return json({ agents: result.results.map((row) => ({ id: row.id, userId: row.user_id, telegramId: row.telegram_id, name: row.web_username || row.username || row.first_name || 'Unlinked account', code: row.referral_code, status: row.status, referrals: row.referrals, createdAt: row.created_at })) });
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
      .bind(id, user.id, code, JSON.stringify({ basis: 'referrals_only' }), String(adminId)).run();
  } catch { return json({ error: 'That user or promo code is already assigned.' }, 409); }
  await recordAdminAudit(env, adminId, 'AGENT_CREATED', 'agent', id, null, { userId: user.id, code, status: 'active', earnings: 'disabled' });
  return json({ agent: { id, userId: user.id, telegramId, code, status: 'active' } }, 201);
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

function agentSignupBonusStatements(env: Env, userId: number) {
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO wallets (id, user_id, wallet_kind, balance_santim)
      SELECT 'real-' || ?, ?, 'real', 0
      WHERE EXISTS (SELECT 1 FROM referrals WHERE referred_user_id = ? AND agent_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM user_profiles WHERE user_id = ? AND age_eligibility = 'verified')`)
      .bind(userId, userId, userId, userId),
    env.DB.prepare(`INSERT OR IGNORE INTO wallet_transactions
      (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, reference)
      SELECT lower(hex(randomblob(16))), w.id, 'real', 'promo_credit', 1000, w.balance_santim + 1000,
        'agent-signup-bonus:' || r.referred_user_id, 'system', r.source_code
      FROM referrals r JOIN user_profiles p ON p.user_id = r.referred_user_id
        JOIN wallets w ON w.user_id = r.referred_user_id AND w.wallet_kind = 'real'
      WHERE r.referred_user_id = ? AND r.agent_id IS NOT NULL AND p.age_eligibility = 'verified'
        AND NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = 'agent-signup-bonus:' || r.referred_user_id)`)
      .bind(userId),
  ];
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
  if (existing && existing.source_code.toUpperCase() !== code) return json({ error: 'A promo code is already linked to this account.' }, 409);
  try {
    await env.DB.batch([
      ...(existing ? [] : [env.DB.prepare(`INSERT INTO referrals (id, referred_user_id, agent_id, source_code) VALUES (?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), userId, agent.id, code)]),
      ...agentSignupBonusStatements(env, userId),
    ]);
  } catch { return json({ error: 'That promo code could not be applied.' }, 409); }
  const bonus = await env.DB.prepare(`SELECT p.age_eligibility,
      EXISTS(SELECT 1 FROM wallet_transactions WHERE idempotency_key = 'agent-signup-bonus:' || r.referred_user_id) AS credited
    FROM referrals r LEFT JOIN user_profiles p ON p.user_id = r.referred_user_id WHERE r.referred_user_id = ?`).bind(userId)
    .first<{ age_eligibility: string | null; credited: number }>();
  return json({ ok: true, alreadyApplied: Boolean(existing), bonusBirr: 10,
    bonusStatus: bonus?.credited ? 'credited' : bonus?.age_eligibility === 'blocked' ? 'withheld' : 'pending_age',
    walletEnabled: await moneyActivationRecorded(env) });
}

async function agentDashboard(env: Env, userId: number): Promise<Response> {
  const agent = await env.DB.prepare(`SELECT id, referral_code, status FROM agents WHERE user_id = ?`).bind(userId).first<{ id: string; referral_code: string; status: string }>();
  if (!agent || agent.status !== 'active') return json({ error: agent ? 'Agent access is suspended.' : 'This Telegram account is not an active agent.' }, 403);
  const referrals = await env.DB.prepare(`SELECT u.first_name, u.username, u.web_username, r.created_at
    FROM referrals r JOIN users u ON u.id = r.referred_user_id WHERE r.agent_id = ? ORDER BY r.created_at DESC LIMIT 100`).bind(agent.id).all<{ first_name: string; username: string | null; web_username: string | null; created_at: string }>();
  return json({ agent: { code: agent.referral_code, status: agent.status },
    shareLink: `https://t.me/${encodeURIComponent('Dire_Bet_bot')}?start=agent_${agent.referral_code}`,
    referrals: referrals.results.map((row) => ({ name: row.web_username || (row.username ? `@${row.username}` : row.first_name), joinedAt: row.created_at })) });
}

async function handleWalletAndStaff(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/api/wallet/settings' && request.method === 'GET') return publicPaymentSettings(env);
  if (url.pathname.startsWith('/api/wallet/')) {
    const userId = await readSession(request, env.SESSION_SECRET);
    if (!userId) return json({ error: 'Sign in through Telegram or your web account to continue.' }, 401);
    if (url.pathname === '/api/wallet/balance' && request.method === 'GET') return playerWalletBalance(env, userId);
    if (url.pathname === '/api/wallet/requests' && request.method === 'GET') return playerWalletRequests(env, userId);
    if (url.pathname === '/api/wallet/deposits' && request.method === 'POST') return createRealDeposit(request, env, userId);
    if (url.pathname === '/api/wallet/withdrawals' && request.method === 'POST') return createRealWithdrawal(request, env, userId);
  }
  if (url.pathname === '/api/referrals/claim' && request.method === 'POST') {
    const userId = await readSession(request, env.SESSION_SECRET);
    return userId ? claimAgentReferral(request, env, userId) : json({ error: 'Sign in before applying a promo code.' }, 401);
  }
  if (url.pathname === '/api/agent/dashboard' && request.method === 'GET') {
    const userId = await readSession(request, env.SESSION_SECRET);
    return userId ? agentDashboard(env, userId) : json({ error: 'Sign in with the agent Telegram account.' }, 401);
  }
  if (url.pathname.startsWith('/api/admin/identity') || url.pathname.startsWith('/api/admin/wallet') || url.pathname.startsWith('/api/admin/agents') || url.pathname.startsWith('/api/admin/activation')) {
    const adminId = await superAdmin(request, env);
    if (adminId instanceof Response) return adminId;
    if (url.pathname === '/api/admin/identity' && request.method === 'GET') return json({ isSuperAdmin: true });
    if (url.pathname === '/api/admin/activation' && request.method === 'GET') return adminActivationStatus(env);
    if (url.pathname === '/api/admin/activation' && request.method === 'POST') return recordActivationEvidence(request, env, adminId);
    if (url.pathname === '/api/admin/wallet/settings' && request.method === 'GET') return adminPaymentSettings(env);
    if (url.pathname === '/api/admin/wallet/settings' && request.method === 'PUT') return updateAdminPaymentSettings(request, env, adminId);
    if (url.pathname === '/api/admin/wallet/summary' && request.method === 'GET') return adminWalletSummary(env);
    if (url.pathname === '/api/admin/wallet/deposits' && request.method === 'GET') return adminWalletList(env, adminId, 'deposits');
    if (url.pathname === '/api/admin/wallet/withdrawals' && request.method === 'GET') return adminWalletList(env, adminId, 'withdrawals');
    const detail = url.pathname.match(/^\/api\/admin\/wallet\/(deposits|withdrawals)\/([A-Za-z0-9-]+)$/);
    if (detail && request.method === 'GET') {
      const mode = await walletMode(env);
      if (!mode) return json({ error: 'Wallet requests are unavailable until required approvals are recorded.' }, 403);
      const walletKind = mode === 'real' ? 'real' : 'demo';
      const simulationOnly = mode === 'simulation' ? 1 : 0;
      if (detail[1] === 'deposits') {
        const row = await env.DB.prepare(`SELECT d.id, d.user_id, d.wallet_kind, d.simulation_only, d.provider, d.amount_santim, d.provider_reference, d.status, d.review_reason, d.created_at, d.reviewed_at,
          u.first_name, u.username, u.web_username, d.sender_phone_ciphertext, d.proof_method, d.confirmation_sms_ciphertext, d.review_flags FROM deposit_requests d JOIN users u ON u.id = d.user_id
          WHERE d.id = ? AND d.wallet_kind = ? AND d.simulation_only = ?`).bind(detail[2], walletKind, simulationOnly).first<{
            id: string; user_id: number; provider: PaymentProvider; amount_santim: number; provider_reference: string | null; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
            wallet_kind: string; simulation_only: number; first_name: string; username: string | null; web_username: string | null; sender_phone_ciphertext: string | null; proof_method: 'receipt' | 'sms'; confirmation_sms_ciphertext: string | null; review_flags: string | null;
          }>();
        if (!row) return json({ error: 'Request not found.' }, 404);
        const { sender_phone_ciphertext: senderPhoneCiphertext, confirmation_sms_ciphertext: confirmationSmsCiphertext, review_flags: reviewFlagsJson, ...safeRow } = row;
        const blob = await env.DB.prepare('SELECT content_type, encrypted_blob FROM receipt_blobs WHERE deposit_request_id = ?').bind(row.id).first<{ content_type: 'image/png' | 'image/jpeg'; encrypted_blob: ArrayBuffer }>();
        let senderPhone = ''; let receiptData = ''; let confirmationSms = '';
        try { if (senderPhoneCiphertext) senderPhone = await decryptContact(senderPhoneCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
        try { if (confirmationSmsCiphertext) confirmationSms = await decryptContact(confirmationSmsCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
        try {
          if (blob) {
            const bytes = blob.encrypted_blob instanceof Uint8Array ? blob.encrypted_blob : new Uint8Array(blob.encrypted_blob);
            const encrypted = new TextDecoder().decode(bytes);
            receiptData = `data:${blob.content_type};base64,${await decryptContact(encrypted, env.SESSION_SECRET || '')}`;
          }
        } catch { /* Leave the receipt unavailable rather than exposing encrypted bytes. */ }
        return json({ request: { ...safeRow, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, senderPhone, receiptData, confirmationSms, flags: reviewFlags(reviewFlagsJson), simulationOnly: row.simulation_only === 1 } });
      }
      const row = await env.DB.prepare(`SELECT w.id, w.user_id, w.simulation_only, w.provider, w.amount_santim, w.status, w.review_reason, w.created_at, w.reviewed_at,
        w.destination_phone_ciphertext, w.account_holder_ciphertext, COALESCE(wallet.balance_santim, 0) AS balance_santim,
        u.first_name, u.username, u.web_username FROM withdrawal_requests w JOIN users u ON u.id = w.user_id
        LEFT JOIN wallets wallet ON wallet.user_id = w.user_id AND wallet.wallet_kind = w.wallet_kind
        WHERE w.id = ? AND w.wallet_kind = ? AND w.simulation_only = ?`).bind(detail[2], walletKind, simulationOnly).first<{
          id: string; user_id: number; provider: PaymentProvider; amount_santim: number; status: string; review_reason: string | null; created_at: string; reviewed_at: string | null;
          simulation_only: number; balance_santim: number; destination_phone_ciphertext: string | null; account_holder_ciphertext: string | null; first_name: string; username: string | null; web_username: string | null;
        }>();
      if (!row) return json({ error: 'Request not found.' }, 404);
      const { destination_phone_ciphertext: destinationPhoneCiphertext, account_holder_ciphertext: accountHolderCiphertext, ...safeRow } = row;
      let destinationPhone = ''; let accountHolderName = '';
      try { if (destinationPhoneCiphertext) destinationPhone = await decryptContact(destinationPhoneCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
      try { if (accountHolderCiphertext) accountHolderName = await decryptContact(accountHolderCiphertext, env.SESSION_SECRET || ''); } catch { /* Leave protected data blank if it cannot be decrypted. */ }
      return json({ request: { ...safeRow, player: row.web_username || (row.username ? `@${row.username}` : row.first_name), amount: row.amount_santim / 100, balance: row.balance_santim / 100, destinationPhone, accountHolderName, simulationOnly: row.simulation_only === 1 } });
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

async function handleRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: securityHeaders });
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return json({ ok: true, mode: await moneyActivationRecorded(env) ? 'real' : 'free-play', realMoneyAvailable: await moneyActivationRecorded(env) });
  }
  if (url.pathname === '/api/games' && request.method === 'GET') {
    return json({ games: PUBLIC_GAMES, liveMoney: await moneyActivationRecorded(env) });
  }
  if (url.pathname === '/api/auth/telegram' && request.method === 'POST') return authenticate(request, env);
  if (url.pathname === '/api/auth/password' && request.method === 'POST') return authenticatePassword(request, env);
  if (url.pathname === '/api/auth/refresh' && request.method === 'POST') return renewAuthSession(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') return endAuthSession(request, env);
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
  const publicMarketplaceResponse = await handlePublicMarketplace(request, env, ctx);
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
    if (!isMarketplaceGame(gameId) || gameId === 'poker') return json({ error: 'Game filter is invalid.' }, 400);
    const headers = new Headers(request.headers);
    headers.delete('X-Market-User');
    const ticketValue = url.searchParams.get('ticket');
    if (ticketValue) {
      const ticket = await readRoomTicket(ticketValue, env.SESSION_SECRET);
      if (!ticket || ticket.code !== 'MARKET') return json({ error: 'Room list connection ticket is invalid or expired.' }, 401);
      const eligibilityError = await freePlayEligibilityError(env, ticket.userId);
      if (eligibilityError) return json({ error: eligibilityError }, 403);
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
  if (url.pathname.startsWith('/api/')) return json({ error: 'API route not found.' }, 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try { return await handleRequest(request, env, ctx); }
    catch { return json({ error: 'Service temporarily unavailable' }, 503); }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP").run().then(() => undefined).catch(() => undefined));
    ctx.waitUntil(env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < CURRENT_TIMESTAMP OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-7 days'))").run().then(() => undefined).catch(() => undefined));
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
      let input: { code?: unknown; gameId?: unknown; userId?: unknown; displayName?: unknown; expiresAt?: unknown; publicRoomId?: unknown; publicRoomOptions?: unknown; entryCredits?: unknown };
      try { input = await request.json() as typeof input; } catch { return json({ error: 'Invalid room request.' }, 400); }
      if (typeof input.code !== 'string' || (input.gameId !== 'xo' && input.gameId !== 'ludo' && input.gameId !== 'checkers' && input.gameId !== 'poker') || !Number.isSafeInteger(input.userId) || typeof input.displayName !== 'string' || !Number.isSafeInteger(input.expiresAt)) return json({ error: 'Invalid room request.' }, 400);
      const publicRoomOptions = input.publicRoomOptions && typeof input.publicRoomOptions === 'object' ? input.publicRoomOptions as Record<string, unknown> : undefined;
      const room: StoredRoom = { code: input.code, gameId: input.gameId, hostId: input.userId as number, status: 'waiting', players: [{ id: input.userId as number, name: input.displayName.slice(0, 32), mark: null, online: false }], game: createGame(input.gameId, publicRoomOptions), matchId: null, sequence: 0, expiresAt: input.expiresAt as number,
        ...(typeof input.publicRoomId === 'string' ? { publicRoomId: input.publicRoomId } : {}),
        ...(publicRoomOptions ? { publicRoomOptions } : {}),
        ...(Number.isSafeInteger(input.entryCredits) ? { entryCredits: input.entryCredits as number } : {}) };
      await this.state.storage.put('room', room);
      await this.state.storage.setAlarm(room.expiresAt);
      return json({ ok: true });
    }
    if (path === '/cancel-public' && request.method === 'POST') {
      const room = await this.state.storage.get<StoredRoom>('room');
      if (!room || !room.publicRoomId) return json({ error: 'Public room not found.' }, 404);
      if (room.status === 'cancelled' || room.status === 'finished') return json({ ok: true });
      room.status = 'cancelled';
      room.turnDeadline = undefined;
      room.timeoutRecorded = undefined;
      room.reconnectDeadline = undefined;
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
    const eligibilityError = await freePlayEligibilityError(this.env, userId);
    if (eligibilityError) { this.sendError(socket, eligibilityError); socket.close(1008, 'Account not eligible'); return; }
    let input: { type?: unknown; index?: unknown; token?: unknown; action?: unknown; from?: unknown; to?: unknown };
    try { input = JSON.parse(text) as typeof input; } catch { return this.sendError(socket, 'Move could not be read.'); }
    if (typeof input.type !== 'string') return this.sendError(socket, 'Move is not allowed.');
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room || room.status !== 'active' || !room.matchId) return this.sendError(socket, 'This room is not active.');
    const player = room.players.find((entry) => entry.id === userId);
    const playerIndex = room.players.findIndex((entry) => entry.id === userId);
    if (!player || playerIndex < 0) return this.sendError(socket, 'You are not seated in this room.');
    if (room.gameId === 'ludo' && room.status === 'active' && room.turnDeadline && room.turnDeadline <= Date.now() && !room.terminal) {
      await this.autoPlayLudoTimeout(room);
      return this.sendError(socket, 'The turn timer expired. An automatic move was made.');
    }
    if (room.terminal) return this.sendError(socket, 'This match has finished.');
    const control = input.type === 'resign' || input.type === 'draw-offer' || input.type === 'draw-accept' || input.type === 'draw-decline';
    if (!control && gameTurn(room) !== playerIndex) return this.sendError(socket, 'Please wait for your turn.');
    const turnBefore = gameTurn(room);
    const previous = { game: room.game, status: room.status, terminal: room.terminal, drawOfferBy: room.drawOfferBy, turnDeadline: room.turnDeadline, timeoutRecorded: room.timeoutRecorded };
    try {
      if (control) {
        if (room.gameId !== 'checkers') return this.sendError(socket, 'Move is not allowed for this game.');
        if (input.type === 'resign') {
          room.terminal = { winner: playerIndex === 0 ? 1 : 0, reason: 'resign' };
          room.status = 'finished';
        } else if (input.type === 'draw-offer') {
          if (room.drawOfferBy !== undefined) return this.sendError(socket, 'A draw offer is already pending.');
          room.drawOfferBy = playerIndex;
        } else if (input.type === 'draw-accept') {
          if (room.drawOfferBy === undefined || room.drawOfferBy === playerIndex) return this.sendError(socket, 'There is no draw offer to accept.');
          room.terminal = { winner: 'draw', reason: 'draw' };
          room.drawOfferBy = undefined;
          room.status = 'finished';
        } else {
          if (room.drawOfferBy === undefined || room.drawOfferBy === playerIndex) return this.sendError(socket, 'There is no draw offer to decline.');
          room.drawOfferBy = undefined;
        }
      } else {
        room.drawOfferBy = undefined;
        if (room.gameId === 'xo' && input.type === 'move' && Number.isInteger(input.index) && player.mark) room.game = applyXO(room.game as XOState, player.mark, input.index as number);
        else if (room.gameId === 'ludo' && input.type === 'roll') room.game = rollLudo(room.game as LudoState, secureInt(1, 6));
        else if (room.gameId === 'ludo' && input.type === 'move' && Number.isInteger(input.token)) room.game = moveLudo(room.game as LudoState, input.token as number);
        else if (room.gameId === 'checkers' && input.type === 'move' && Number.isInteger(input.from) && Number.isInteger(input.to)) room.game = applyCheckerMove(room.game as CheckersState, input.from as number, input.to as number);
        else if (room.gameId === 'poker' && input.type === 'action' && input.action && typeof input.action === 'object') room.game = applyPokerAction(room.game as PokerState, playerIndex as 0 | 1, input.action as PokerAction);
        else return this.sendError(socket, 'Move is not allowed for this game.');
      }
    } catch { return this.sendError(socket, 'That move is not allowed.'); }
    room.sequence++;
    const completion = gameComplete(room);
    if (completion.done) room.status = 'finished';
    if (room.status === 'finished') {
      room.turnDeadline = undefined;
    } else if (room.gameId === 'ludo' && (gameTurn(room) !== turnBefore || !room.turnDeadline)) {
      this.startTurnClock(room);
    }
    try {
      await this.recordMove(room, player.id, { type: input.type, ...(Number.isInteger(input.index) ? { index: input.index } : {}), ...(Number.isInteger(input.token) ? { token: input.token } : {}), ...(Number.isInteger(input.from) ? { from: input.from } : {}), ...(Number.isInteger(input.to) ? { to: input.to } : {}), ...(input.action && typeof input.action === 'object' ? { action: input.action } : {}) }, completion.winner);
      await this.state.storage.put('room', room);
    } catch {
      room.game = previous.game;
      room.sequence--;
      room.status = previous.status;
      room.terminal = previous.terminal;
      room.drawOfferBy = previous.drawOfferBy;
      room.turnDeadline = previous.turnDeadline;
      room.timeoutRecorded = previous.timeoutRecorded;
      return this.sendError(socket, 'Move could not be saved. Please try again.');
    }
    await this.scheduleRoomAlarm(room);
    this.broadcast(room);
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.disconnect(socket); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.disconnect(socket); }

  async alarm(): Promise<void> {
    const room = await this.state.storage.get<StoredRoom>('room');
    if (!room) return;
    if (room.status === 'waiting' && room.expiresAt <= Date.now()) {
      room.status = 'cancelled';
      room.turnDeadline = undefined;
      room.timeoutRecorded = undefined;
      room.reconnectDeadline = undefined;
      await this.state.storage.put('room', room);
      await this.env.DB.prepare("UPDATE game_rooms SET status = 'cancelled' WHERE id = ? AND status = 'waiting'").bind(room.code).run();
      this.broadcast(room);
      return;
    }
    if (room.status === 'active' && room.gameId === 'ludo' && room.turnDeadline && room.turnDeadline <= Date.now() && !room.terminal) {
      await this.autoPlayLudoTimeout(room);
      return;
    }
    if (room.status === 'active' && room.players.some((player) => !player.online) && (!room.reconnectDeadline || room.reconnectDeadline <= Date.now())) {
      room.status = 'cancelled';
      room.turnDeadline = undefined;
      room.timeoutRecorded = undefined;
      room.reconnectDeadline = undefined;
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
      return;
    }
    if (room.status === 'active' && room.gameId === 'ludo' && !room.turnDeadline && !room.terminal) this.startTurnClock(room);
    await this.scheduleRoomAlarm(room);
  }

  private startTurnClock(room: StoredRoom): void {
    room.turnDeadline = Date.now() + LUDO_TURN_MS;
    room.timeoutRecorded = undefined;
  }

  private async scheduleRoomAlarm(room: StoredRoom): Promise<void> {
    if (room.status === 'finished' || room.status === 'cancelled') {
      await this.state.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const deadlines: number[] = [];
    if (room.status === 'waiting') deadlines.push(room.expiresAt);
    if (room.status === 'active') {
      if (room.gameId === 'ludo' && room.turnDeadline) deadlines.push(room.turnDeadline);
      if (room.players.some((player) => !player.online)) deadlines.push(room.reconnectDeadline ?? now + RECONNECT_GRACE_MS);
    }
    if (!deadlines.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  private async autoPlayLudoTimeout(room: StoredRoom): Promise<boolean> {
    if (room.status !== 'active' || room.gameId !== 'ludo' || room.terminal || room.timeoutRecorded) return false;
    if (!room.turnDeadline || room.turnDeadline > Date.now()) return false;
    const seat = gameTurn(room);
    if (seat === null) return false;
    const previous = { game: room.game, status: room.status, terminal: room.terminal, timeoutRecorded: room.timeoutRecorded, turnDeadline: room.turnDeadline, sequence: room.sequence };
    const game = room.game as LudoState;
    const dice = game.dice === null ? secureInt(1, 6) : null;
    const rolled = dice === null ? game : rollLudo(game, dice);
    const token = legalLudoActions(rolled)[0];
    room.game = token === undefined ? rolled : moveLudo(rolled, token);
    room.sequence++;
    room.timeoutRecorded = true;
    const completion = gameComplete(room);
    if (completion.done) room.status = 'finished';
    if (room.status === 'finished') room.turnDeadline = undefined;
    else this.startTurnClock(room);
    try {
      await this.recordMove(room, room.players[seat]?.id ?? 0, { type: 'auto-turn', ...(dice === null ? {} : { dice }), ...(token === undefined ? {} : { token }) }, completion.winner);
      await this.state.storage.put('room', room);
    } catch {
      room.game = previous.game;
      room.status = previous.status;
      room.terminal = previous.terminal;
      room.timeoutRecorded = previous.timeoutRecorded;
      room.turnDeadline = previous.turnDeadline;
      room.sequence = previous.sequence;
      await this.state.storage.setAlarm(Date.now() + 5_000);
      return false;
    }
    await this.scheduleRoomAlarm(room);
    this.broadcast(room);
    return true;
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
    room.game = room.gameId === 'xo' ? initXO(room.players.find((player) => player.mark === 'X')?.mark || 'X') : createGame(room.gameId, room.publicRoomOptions);
    room.status = 'active';
    room.matchId = `${room.gameId}-${room.code}`;
    room.sequence = 0;
    room.terminal = undefined;
    room.drawOfferBy = undefined;
    room.turnDeadline = undefined;
    room.timeoutRecorded = undefined;
    room.reconnectDeadline = room.players.some((player) => !player.online) ? Date.now() + RECONNECT_GRACE_MS : undefined;
    if (room.gameId === 'ludo') this.startTurnClock(room);
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE game_rooms SET status = 'active' WHERE id = ? AND status = 'waiting'").bind(room.code),
      this.env.DB.prepare("INSERT INTO matches (id, room_id, game_id, status, bot_match) VALUES (?, ?, ?, 'active', 0)").bind(room.matchId, room.code, room.gameId),
      ...room.players.map((player, seat) => this.env.DB.prepare('INSERT INTO match_players (match_id, user_id, seat) VALUES (?, ?, ?)').bind(room.matchId, player.id, seat)),
    ]);
    await this.state.storage.put('room', room);
    await this.scheduleRoomAlarm(room);
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
    if (room.players.every((player) => player.online)) room.reconnectDeadline = undefined;
    if (room.status === 'active' && room.gameId === 'ludo' && !room.turnDeadline && !room.terminal) this.startTurnClock(room);
    await this.state.storage.put('room', room);
    if (room.status === 'active' && room.gameId === 'ludo' && room.turnDeadline && room.turnDeadline <= Date.now() && !room.terminal) {
      if (!(await this.autoPlayLudoTimeout(room))) this.broadcast(room);
    } else {
      await this.scheduleRoomAlarm(room);
      this.broadcast(room);
    }
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
    if (room.players.every((entry) => entry.online)) room.reconnectDeadline = undefined;
    else if (room.status === 'active') room.reconnectDeadline ??= Date.now() + RECONNECT_GRACE_MS;
    await this.state.storage.put('room', room);
    await this.scheduleRoomAlarm(room);
    this.broadcast(room);
  }

  private async recordMove(room: StoredRoom, userId: number, action: unknown, winner: number | 'draw' | null): Promise<void> {
    if (!room.matchId) return;
    const stateText = JSON.stringify(room.game);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(stateText)));
    const stateHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const event = this.env.DB.prepare('INSERT OR IGNORE INTO match_events (match_id, sequence, actor_user_id, event_type, payload_json, state_hash) VALUES (?, ?, ?, ?, ?, ?)')
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
      if (room.gameId === 'poker' && seat >= 0) game = viewPoker(room.game as PokerState, seat as 0 | 1);
      try { socket.send(JSON.stringify({ type: 'state', code: room.code, gameId: room.gameId, status: room.status, players: room.players, game, you: room.players[seat]?.mark || null, seat, matchId: room.matchId, terminal: room.terminal || null, drawOfferBy: room.drawOfferBy ?? null,
        turnDeadline: room.status === 'active' && room.gameId === 'ludo' ? room.turnDeadline ?? null : null, serverTime: Date.now(),
        ...(room.publicRoomId ? { publicRoom: { id: room.publicRoomId, entryCredits: room.entryCredits || 0, options: room.publicRoomOptions || {} } } : {}) })); }
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
