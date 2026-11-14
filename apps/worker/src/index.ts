import { PUBLIC_GAMES, TelegramAuthRequestSchema } from '@dire-bet/shared';

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
const MAX_WEBHOOK_BYTES = 64 * 1024;

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

async function issueSession(userId: number, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(enc.encode(JSON.stringify({ sub: String(userId), iat: now, exp: now + SESSION_LIFETIME })));
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
  let update: { message?: { text?: string; chat?: { id?: number }; from?: { language_code?: string } } };
  try { update = JSON.parse(text) as typeof update; } catch { return json({ ok: true }); }
  const message = update.message;
  if (!message?.text || typeof message.chat?.id !== 'number') return json({ ok: true });
  const command = message.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  const lang = ['am', 'so', 'om'].includes(message.from?.language_code || '') ? message.from?.language_code as string : 'en';
  const base = new URL(request.url).origin;
  const responses: Record<string, string> = {
    '/start': welcome[lang],
    '/play': welcome[lang],
    '/games': 'XO is available for free practice. Ludo, Dominoes and Poker are being prepared. Ethiopian 41 is unavailable.',
    '/profile': 'Open DIRE BET to view your player profile.',
    '/wallet': 'TEST MODE · Demo credits are not ETB cash. Live deposits and withdrawals are disabled.',
    '/leaderboard': 'The public leaderboard is not available yet.',
    '/help': 'DIRE BET free-play preview. Use /support for help.',
    '/support': 'Support tickets are not available yet. Please check back later.',
    '/stop': 'Promotional messages are not sent in this preview.',
  };
  const reply_markup = ['/start', '/play', '/games'].includes(command) ? {
    inline_keyboard: [[{ text: 'Play DIRE BET', web_app: { url: base } }]],
  } : undefined;
  await telegramApi(env.TELEGRAM_BOT_TOKEN, 'sendMessage', {
    chat_id: message.chat.id,
    text: responses[command] || 'Use /play to open free practice games, or /help for help.',
    ...(reply_markup ? { reply_markup } : {}),
  });
  return json({ ok: true });
}

async function setupTelegram(request: Request, env: Env): Promise<Response> {
  if (!env.SETUP_KEY || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return json({ error: 'Setup secrets are not configured' }, 503);
  if (request.headers.get('Authorization') !== `Bearer ${env.SETUP_KEY}`) return json({ error: 'Unauthorized' }, 401);
  const used = await env.DB.prepare("SELECT value FROM application_settings WHERE key = 'telegram_setup_used'").first<{ value: string }>();
  if (used?.value === 'true') return json({ error: 'Telegram setup has already been completed' }, 409);
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
  if (url.pathname === '/api/me' && request.method === 'GET') {
    const id = await readSession(request, env.SESSION_SECRET);
    if (!id) return json({ error: 'Authentication required' }, 401);
    const user = await env.DB.prepare('SELECT id, username, first_name, language FROM users WHERE id = ?').bind(id).first();
    return user ? json({ user }) : json({ error: 'Session is no longer valid' }, 401);
  }
  if (url.pathname === '/api/ws-ticket' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    const id = await readSession(request, env.SESSION_SECRET);
    if (!id) return json({ error: 'Authentication required' }, 401);
    return json({ error: 'Online rooms are not enabled yet' }, 503);
  }
  if (url.pathname.startsWith('/api/money') || url.pathname.startsWith('/api/deposit') || url.pathname.startsWith('/api/withdraw')) {
    return (await moneyActivationRecorded(env))
      ? json({ error: 'Provider-approved money flows are not implemented' }, 503)
      : json({ error: 'Live funds are disabled pending verified approvals' }, 403);
  }
  if (url.pathname === '/telegram/webhook' && request.method === 'POST') return handleTelegramWebhook(request, env);
  if (url.pathname === '/telegram/setup' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'Origin rejected' }, 403);
    return setupTelegram(request, env);
  }
  if (url.pathname.startsWith('/ws/')) return json({ error: 'Online rooms are not enabled yet' }, 503);
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
  constructor(private readonly state: DurableObjectState, _env: Env) {}
  async fetch(): Promise<Response> { return json({ error: 'Room protocol is not enabled yet' }, 503); }
  webSocketMessage(_socket: WebSocket, _message: string | ArrayBuffer): void {}
  webSocketClose(_socket: WebSocket): void {}
  async alarm(): Promise<void> {}
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
    const key = new URL(request.url).searchParams.get('key');
    if (!key || key.length > 128) return json({ error: 'Invalid rate-limit key' }, 400);
    const now = Math.floor(Date.now() / 1000);
    await this.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    const row = await this.state.storage.sql.exec<{ hits: number; expires_at: number }>('SELECT hits, expires_at FROM limits WHERE key = ?', key).toArray();
    const current = row[0];
    if (!current || current.expires_at <= now) {
      await this.state.storage.sql.exec('INSERT INTO limits (key, hits, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET hits = 1, expires_at = excluded.expires_at', key, now + 60);
      return json({ allowed: true, remaining: 29 });
    }
    if (current.hits >= 30) return json({ allowed: false, remaining: 0 }, 429);
    await this.state.storage.sql.exec('UPDATE limits SET hits = hits + 1 WHERE key = ?', key);
    return json({ allowed: true, remaining: 29 - current.hits });
  }
}
