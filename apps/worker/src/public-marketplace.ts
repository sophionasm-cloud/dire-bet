import {
  calculateSettlement,
  DEFAULT_MARKETPLACE_SETTINGS,
  isMarketplaceGame,
  parseEntryChoice,
  parseLudoRoomOptions,
  validateMarketplaceSettings,
  type MarketplaceSettings,
} from './marketplace';
import { moneyActivationRecorded, moneyEligibilityError, type ActivationEnv } from './activation';

type RoomGame = 'xo' | 'ludo' | 'checkers' | 'poker';
type PublicStatus = 'WAITING' | 'FULL' | 'STARTING' | 'IN_PROGRESS' | 'SETTLING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
type MarketEnv = ActivationEnv & { GAME_ROOM: DurableObjectNamespace; SESSION_SECRET?: string };
type RoomRow = {
  id: string; code: string; game_id: RoomGame; creator_id: number; creator_name: string; status: PublicStatus;
  capacity: number; player_count: number; entry_credits: number; options_json: string; created_at: number;
  expires_at: number; commission_bps: number; match_id: string | null; pool_tenths: number; game_ready: number;
  fee_tenths: number; payout_tenths: number; winner: number | null; wallet_kind: 'demo' | 'real' | 'free';
};
type PlayerRow = { user_id: number; display_name: string; seat: number; reserved_units: number };
type MarketPlayer = { name: string; avatar: string; seat: number };
type MarketRoom = {
  id: string; code: string; gameId: RoomGame; creatorName: string; creatorAvatar: string;
  players: MarketPlayer[]; playerCount: number; capacity: number; entryCredits: number;
  poolCredits: number; payoutCredits: number;
  mode: string; options: Record<string, unknown>; status: PublicStatus; createdAt: number; expiresAt: number;
  matchId: string | null; winner: number | null; walletKind: 'demo' | 'real' | 'free'; viewerSeat?: number; viewerIsCreator?: boolean;
};

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const marketId = 'public-room-marketplace';

function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function roomCode(): string {
  let value = '';
  while (value.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < Math.floor(256 / alphabet.length) * alphabet.length) value += alphabet[byte % alphabet.length];
      if (value.length === 6) break;
    }
  }
  return value;
}

function safeOptions(gameId: RoomGame, input: unknown): Record<string, unknown> | null {
  if (gameId === 'ludo') return parseLudoRoomOptions(input);
  if (input && typeof input === 'object' && Object.keys(input).length > 0) return null;
  return {};
}

function credits(tenths: number): number { return Math.round(tenths) / 10; }

export class Matchmaker {
  private moneyActive = false;
  constructor(private readonly state: DurableObjectState, private readonly env: MarketEnv) {}

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    this.moneyActive = await moneyActivationRecorded(this.env);
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/connect' && request.method === 'GET') return this.connect(request);
      if (path === '/list' && request.method === 'GET') return reply({ rooms: this.waitingRooms(url.searchParams.get('gameId'), this.moneyActive) });
      if (path === '/config' && request.method === 'GET') return reply(this.marketConfig());
      if (path === '/balance' && request.method === 'GET') return this.balance(Number(url.searchParams.get('userId')));
      if (path === '/mine' && request.method === 'GET') return reply({ room: this.myRoom(Number(url.searchParams.get('userId')), url.searchParams.get('gameId')) });
      if (path === '/create' && request.method === 'POST') return this.createRoom(request);
      if (path.startsWith('/join/') && request.method === 'POST') return this.joinRoom(request, path.slice('/join/'.length));
      if (path.startsWith('/cancel/') && request.method === 'POST') return this.cancelRoom(path.slice('/cancel/'.length), Number(request.headers.get('X-Market-User')), false);
      if (path.startsWith('/session/') && request.method === 'GET') return this.session(path.slice('/session/'.length), Number(url.searchParams.get('userId')));
      if (path === '/settle' && request.method === 'POST') return this.settle(request);
      if (path === '/void' && request.method === 'POST') return this.voidMatch(request);
      if (path === '/reconcile' && request.method === 'POST') return this.reconcile();
      if (path === '/admin/rooms' && request.method === 'GET') return this.adminRooms(url.searchParams.get('gameId'));
      if (path.startsWith('/admin/room/') && request.method === 'GET') return this.adminRoom(path.slice('/admin/room/'.length));
      if (path === '/admin/settings' && request.method === 'PUT') return this.updateSettings(request);
      if (path.startsWith('/admin/cancel/') && request.method === 'POST') return this.cancelRoom(path.slice('/admin/cancel/'.length), Number(request.headers.get('X-Market-Admin')), true);
      return reply({ error: 'Public room service route not found.' }, 404);
    } catch {
      return reply({ error: 'The public room service could not complete that request. Please try again.' }, 503);
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const input = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (input === 'ping') { try { socket.send('pong'); } catch { socket.close(1011, 'Unable to reply'); } }
  }

  webSocketClose(): void {}
  webSocketError(): void {}

  async alarm(): Promise<void> {
    this.ensureSchema();
    this.moneyActive = await moneyActivationRecorded(this.env);
    const now = Date.now();
    const expired = this.state.storage.sql.exec<{ id: string; code: string }>(
      "SELECT id, code FROM public_rooms WHERE status = 'WAITING' AND expires_at <= ? ORDER BY expires_at LIMIT 100", now,
    ).toArray();
    for (const room of expired) await this.expireRoom(room.id);
    await this.scheduleAlarm();
    this.broadcast();
  }

  private ensureSchema(): void {
    const sql = this.state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS public_rooms (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, game_id TEXT NOT NULL, creator_id INTEGER NOT NULL,
      creator_name TEXT NOT NULL, status TEXT NOT NULL, capacity INTEGER NOT NULL, player_count INTEGER NOT NULL,
      entry_credits INTEGER NOT NULL, options_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      commission_bps INTEGER NOT NULL, match_id TEXT, game_ready INTEGER NOT NULL DEFAULT 1, pool_tenths INTEGER NOT NULL DEFAULT 0,
      fee_tenths INTEGER NOT NULL DEFAULT 0, payout_tenths INTEGER NOT NULL DEFAULT 0, winner INTEGER,
      settled_at INTEGER, wallet_kind TEXT NOT NULL DEFAULT 'demo' CHECK (wallet_kind IN ('demo','real','free')))`);
    const roomColumns = sql.exec<{ name: string }>('PRAGMA table_info(public_rooms)').toArray();
    if (!roomColumns.some((column) => column.name === 'game_ready')) {
      sql.exec('ALTER TABLE public_rooms ADD COLUMN game_ready INTEGER NOT NULL DEFAULT 1');
    }
    if (!roomColumns.some((column) => column.name === 'wallet_kind')) {
      sql.exec("ALTER TABLE public_rooms ADD COLUMN wallet_kind TEXT NOT NULL DEFAULT 'demo' CHECK (wallet_kind IN ('demo','real','free'))");
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS public_rooms_status_time ON public_rooms(status, created_at DESC)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS public_room_players (
      room_id TEXT NOT NULL, user_id INTEGER NOT NULL, display_name TEXT NOT NULL, seat INTEGER NOT NULL,
      reserved_units INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL,
      PRIMARY KEY(room_id, user_id), UNIQUE(room_id, seat))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS public_room_players_user ON public_room_players(user_id, joined_at DESC)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS public_room_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, actor_user_id INTEGER,
      event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS public_room_events_room ON public_room_events(room_id, id)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS public_room_idempotency (user_id INTEGER NOT NULL, request_key TEXT NOT NULL, room_id TEXT NOT NULL, PRIMARY KEY(user_id, request_key))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS marketplace_settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS marketplace_admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, admin_user_id INTEGER NOT NULL, action TEXT NOT NULL,
      entity_id TEXT, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec('INSERT OR IGNORE INTO marketplace_settings (singleton, settings_json, updated_at) VALUES (1, ?, ?)', JSON.stringify(DEFAULT_MARKETPLACE_SETTINGS), Date.now());
  }

  private settings(): MarketplaceSettings {
    const raw = this.state.storage.sql.exec<{ settings_json: string }>('SELECT settings_json FROM marketplace_settings WHERE singleton = 1').toArray()[0]?.settings_json;
    try {
      return validateMarketplaceSettings(JSON.parse(raw || '')) || DEFAULT_MARKETPLACE_SETTINGS;
    }
    catch { return DEFAULT_MARKETPLACE_SETTINGS; }
  }

  private marketConfig(): MarketplaceSettings {
    const settings = this.settings();
    return { ...settings, standardAmounts: this.moneyActive ? settings.standardAmounts : [], customEnabled: this.moneyActive && settings.customEnabled, realMoneyEnabled: this.moneyActive };
  }

  private async balance(userId: number): Promise<Response> {
    if (!Number.isSafeInteger(userId) || userId <= 0) return reply({ error: 'Player account is unavailable.' }, 400);
    if (!this.moneyActive) return reply({ error: 'Wallet services are unavailable until required approvals are recorded.' }, 403);
    const eligibility = await moneyEligibilityError(this.env, userId);
    if (eligibility) return reply({ error: eligibility }, 403);
    const wallet = await this.env.DB.prepare("SELECT balance_santim FROM wallets WHERE user_id = ? AND wallet_kind = 'real'").bind(userId).first<{ balance_santim: number }>();
    return reply({ balanceSantim: wallet?.balance_santim || 0, balance: (wallet?.balance_santim || 0) / 100 });
  }

  private async reserveWallet(userId: number, amountSantim: number, key: string, reference: string): Promise<boolean> {
    const previous = await this.env.DB.prepare(`SELECT t.amount_santim, w.user_id FROM wallet_transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ? AND t.wallet_kind = 'real'`).bind(key).first<{ amount_santim: number; user_id: number }>();
    if (previous) return previous.user_id === userId && previous.amount_santim === -amountSantim;
    try {
      const result = await this.env.DB.prepare(`INSERT INTO wallet_transactions
        (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
        SELECT ?, id, 'real', 'match_entry', -?, balance_santim - ?, ?, 'user', ?, ?
        FROM wallets WHERE user_id = ? AND wallet_kind = 'real' AND balance_santim >= ?`)
        .bind(crypto.randomUUID(), amountSantim, amountSantim, key, String(userId), reference, userId, amountSantim).run();
      if (result.meta.changes === 1) return true;
    } catch { /* A concurrent request may have reserved these funds first. */ }
    const repeated = await this.env.DB.prepare(`SELECT t.amount_santim, w.user_id FROM wallet_transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ? AND t.wallet_kind = 'real'`).bind(key).first<{ amount_santim: number; user_id: number }>();
    return Boolean(repeated && repeated.user_id === userId && repeated.amount_santim === -amountSantim);
  }

  private async creditWallet(userId: number, amountSantim: number, category: 'match_payout' | 'refund', key: string, reference: string): Promise<boolean> {
    const previous = await this.env.DB.prepare(`SELECT t.amount_santim, w.user_id FROM wallet_transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ? AND t.wallet_kind = 'real'`).bind(key).first<{ amount_santim: number; user_id: number }>();
    if (previous) return previous.user_id === userId && previous.amount_santim === amountSantim;
    try {
      const result = await this.env.DB.prepare(`INSERT INTO wallet_transactions
        (id, wallet_id, wallet_kind, category, amount_santim, balance_after_santim, idempotency_key, actor_type, actor_id, reference)
        SELECT ?, id, 'real', ?, ?, balance_santim + ?, ?, 'system', NULL, ?
        FROM wallets WHERE user_id = ? AND wallet_kind = 'real'`)
        .bind(crypto.randomUUID(), category, amountSantim, amountSantim, key, reference, userId).run();
      if (result.meta.changes === 1) return true;
    } catch { /* The idempotency key can be written by a concurrent settlement. */ }
    const repeated = await this.env.DB.prepare(`SELECT t.amount_santim, w.user_id FROM wallet_transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ? AND t.wallet_kind = 'real'`).bind(key).first<{ amount_santim: number; user_id: number }>();
    return Boolean(repeated && repeated.user_id === userId && repeated.amount_santim === amountSantim);
  }

  private async refundWallet(userId: number, amountSantim: number, holdKey: string, reference: string): Promise<boolean> {
    const hold = await this.env.DB.prepare(`SELECT t.amount_santim, w.user_id FROM wallet_transactions t
      JOIN wallets w ON w.id = t.wallet_id WHERE t.idempotency_key = ? AND t.wallet_kind = 'real'`).bind(holdKey).first<{ amount_santim: number; user_id: number }>();
    if (!hold) return true;
    if (hold.user_id !== userId || hold.amount_santim !== -amountSantim) return false;
    return this.creditWallet(userId, amountSantim, 'refund', `room-refund:${holdKey}`, reference);
  }

  private async createRoom(request: Request): Promise<Response> {
    const raw = await request.json().catch(() => null);
    const input = raw as {
      gameId?: unknown; userId?: unknown; displayName?: unknown; entry?: unknown;
      options?: unknown; idempotencyKey?: unknown;
    } | null;
    if (!input) return reply({ error: 'Room details are invalid.' }, 400);
    if (!isMarketplaceGame(input.gameId) || input.gameId === 'poker' || !Number.isSafeInteger(input.userId) || (input.userId as number) <= 0 || typeof input.displayName !== 'string') return reply({ error: 'Room details are invalid.' }, 400);
    if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(input.idempotencyKey)) return reply({ error: 'Room request key is invalid.' }, 400);
    const options = safeOptions(input.gameId, input.options);
    if (!options) return reply({ error: 'Those game settings are not supported.' }, 400);
    const settings = this.settings();
    const entryAmount = parseEntryChoice(input.entry, settings);
    if (entryAmount === null) return reply({ error: 'Choose free play or an available ETB entry amount.' }, 400);
    const userId = input.userId as number;
    if (entryAmount > 0) {
      if (!this.moneyActive) return reply({ error: 'Paid rooms are unavailable until required approvals are recorded.' }, 403);
      const eligibility = await moneyEligibilityError(this.env, userId);
      if (eligibility) return reply({ error: eligibility }, 403);
    }
    const displayName = input.displayName.slice(0, 32);
    const createdAt = Date.now();
    const expiresAt = createdAt + settings.waitingSeconds * 1000;
    const transaction = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{ room_id: string }>('SELECT room_id FROM public_room_idempotency WHERE user_id = ? AND request_key = ?', userId, input.idempotencyKey).toArray()[0];
      if (existing) return { roomId: existing.room_id, created: false };
      let code = roomCode();
      for (let attempt = 0; attempt < 8 && this.roomRow(code); attempt++) code = roomCode();
      const walletKind = entryAmount > 0 ? 'real' : 'free';
      const reservedSantim = entryAmount * 100;
      this.state.storage.sql.exec(`INSERT INTO public_rooms (id, code, game_id, creator_id, creator_name, status, capacity, player_count,
        entry_credits, options_json, created_at, expires_at, commission_bps, match_id, game_ready, wallet_kind)
        VALUES (?, ?, ?, ?, ?, 'STARTING', 2, 1, ?, ?, ?, ?, 0, NULL, 0, ?)`,
        code, code, input.gameId, userId, displayName, entryAmount, JSON.stringify(options), createdAt, expiresAt, walletKind);
      this.state.storage.sql.exec('INSERT INTO public_room_players (room_id, user_id, display_name, seat, reserved_units, joined_at) VALUES (?, ?, ?, 0, ?, ?)', code, userId, displayName, reservedSantim, createdAt);
      this.state.storage.sql.exec('INSERT INTO public_room_idempotency (user_id, request_key, room_id) VALUES (?, ?, ?)', userId, input.idempotencyKey, code);
      this.recordEvent(code, userId, 'ROOM_CREATED', { gameId: input.gameId, entryAmount, options });
      return { roomId: code, created: true };
    });
    const room = this.roomRow(transaction.roomId);
    if (!room) return reply({ error: 'Room request could not be found.' }, 503);
    if (room.status === 'CANCELLED' || room.status === 'EXPIRED') return reply({ error: 'That room request could not be completed. Start a new request.' }, 409);
    if (!transaction.created && room.game_ready !== 1) return reply({ error: 'Room setup is still in progress. Refresh in a moment.' }, 409);
    if (transaction.created && entryAmount > 0) {
      const holdKey = `public-room-entry:${room.code}:0`;
      if (!(await this.reserveWallet(userId, entryAmount * 100, holdKey, room.code))) {
        await this.cancelBySystem(room.id, 'INSUFFICIENT_WALLET_BALANCE', false);
        return reply({ error: 'Your available wallet balance is too low for this room.' }, 402);
      }
    }
    if (transaction.created) {
      try {
        await this.env.DB.prepare(`INSERT INTO game_rooms (id, code, game_id, host_user_id, status, capacity, mode, expires_at, is_public, entry_amount_santim, wallet_kind)
          VALUES (?, ?, ?, ?, 'waiting', 2, 'free', ?, 1, ?, ?)`)
          .bind(room.code, room.code, room.game_id, userId, new Date(room.expires_at).toISOString(), entryAmount * 100, room.wallet_kind).run();
      } catch {
        await this.cancelBySystem(room.id, 'GAME_ROOM_RECORD_FAILED', false);
        return reply({ error: 'Could not save the game room. Any held wallet funds were returned.' }, 503);
      }
      const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(room.code));
      const initialized = await stub.fetch('https://room/create', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: room.code, gameId: room.game_id, userId, displayName, expiresAt,
          publicRoomId: room.id, publicRoomOptions: options, entryCredits: entryAmount }),
      });
      if (!initialized.ok) {
        await this.cancelBySystem(room.id, 'ROOM_SETUP_FAILED');
        return reply({ error: 'Could not start the room. Any held wallet funds were returned.' }, 503);
      }
      this.state.storage.sql.exec('UPDATE public_rooms SET game_ready = 1, status = \'WAITING\' WHERE id = ? AND status = \'STARTING\'', room.id);
      this.recordEvent(room.id, null, 'GAME_ROOM_READY', {});
    }
    await this.scheduleAlarm();
    this.broadcast();
    const wallet = this.moneyActive ? await this.env.DB.prepare("SELECT balance_santim FROM wallets WHERE user_id = ? AND wallet_kind = 'real'").bind(userId).first<{ balance_santim: number }>() : null;
    return reply({ room: this.roomViewForUser(room.id, userId), balanceSantim: wallet?.balance_santim || 0, balance: (wallet?.balance_santim || 0) / 100 }, transaction.created ? 201 : 200);
  }

  private async joinRoom(request: Request, id: string): Promise<Response> {
    const code = id.toUpperCase();
    const input = await request.json().catch(() => null) as { userId?: unknown; displayName?: unknown } | null;
    if (!/^[23456789A-HJ-NP-Z]{6}$/.test(code) || !input || !Number.isSafeInteger(input.userId) || (input.userId as number) <= 0 || typeof input.displayName !== 'string') return reply({ error: 'Room or player details are invalid.' }, 400);
    const room = this.roomRow(code);
    if (!room) return reply({ error: 'Public room not found.' }, 404);
    if (room.game_id === 'poker') return reply({ error: 'American Texas is coming soon.' }, 409);
    if (room.wallet_kind === 'demo') return reply({ error: 'This old preview room cannot accept players or move funds.' }, 409);
    if (this.isPlayer(code, input.userId as number)) return reply({ error: 'You already joined this room.' }, 409);
    if (room.status !== 'WAITING' || room.game_ready !== 1 || room.expires_at <= Date.now()) {
      if (room.status === 'WAITING' && room.expires_at <= Date.now()) await this.expireRoom(code);
      return reply({ error: room.status === 'WAITING' ? 'This room has expired.' : 'This room is no longer available.' }, 409);
    }
    const userId = input.userId as number;
    if (room.wallet_kind === 'real') {
      if (!this.moneyActive) return reply({ error: 'Paid rooms are unavailable until required approvals are recorded.' }, 403);
      const eligibility = await moneyEligibilityError(this.env, userId);
      if (eligibility) return reply({ error: eligibility }, 403);
    }
    const displayName = input.displayName.slice(0, 32);
    const joinedAt = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const current = this.roomRow(code);
      if (!current || current.status !== 'WAITING' || current.game_ready !== 1 || current.expires_at <= joinedAt || current.player_count >= current.capacity) return { ok: false as const, error: 'This room is full or no longer available.' };
      const seat = current.player_count;
      const reservedUnits = current.wallet_kind === 'real' ? current.entry_credits * 100 : 0;
      this.state.storage.sql.exec('INSERT INTO public_room_players (room_id, user_id, display_name, seat, reserved_units, joined_at) VALUES (?, ?, ?, ?, ?, ?)', code, userId, displayName, seat, reservedUnits, joinedAt);
      const playerCount = seat + 1;
      this.state.storage.sql.exec('UPDATE public_rooms SET player_count = ?, status = \'STARTING\' WHERE id = ? AND status = \'WAITING\'', playerCount, code);
      this.recordEvent(code, userId, 'PLAYER_JOIN_RESERVED', { seat, playerCount, capacity: current.capacity });
      return { ok: true as const, full: playerCount >= current.capacity, seat, amountSantim: reservedUnits };
    });
    if (!result.ok) return reply({ error: result.error }, 409);
    if (room.wallet_kind === 'real' && !(await this.reserveWallet(userId, result.amountSantim, `public-room-entry:${code}:${result.seat}`, code))) {
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec('DELETE FROM public_room_players WHERE room_id = ? AND user_id = ? AND seat = ?', code, userId, result.seat);
        this.state.storage.sql.exec("UPDATE public_rooms SET player_count = player_count - 1, status = 'WAITING' WHERE id = ? AND status = 'STARTING'", code);
        this.recordEvent(code, userId, 'PLAYER_JOIN_REJECTED_INSUFFICIENT_FUNDS', { seat: result.seat });
      });
      this.broadcast();
      return reply({ error: 'Your available wallet balance is too low for this room.' }, 402);
    }
    this.broadcast();
    if (result.full) {
      this.recordEvent(code, userId, 'GAME_STARTING', {});
      const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(code));
      const joined = await stub.fetch('https://room/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, userId, displayName }) });
      if (!joined.ok) {
        await this.cancelBySystem(code, 'GAME_START_FAILED');
        return reply({ error: 'The game could not start. Reserved funds are being returned.' }, 503);
      }
      const row = this.roomRow(code);
      const matchId = row ? `${row.game_id}-${row.code}` : null;
      const started = this.state.storage.transactionSync(() => {
        const current = this.roomRow(code);
        if (!current || current.status !== 'STARTING') return false;
        this.state.storage.sql.exec("UPDATE public_rooms SET status = 'IN_PROGRESS', match_id = ? WHERE id = ?", matchId, code);
        this.recordEvent(code, userId, 'GAME_STARTED', { matchId });
        return true;
      });
      if (!started) {
        await this.cancelGameRoom(code);
        return reply({ error: 'The room closed while the game was starting.' }, 409);
      }
      this.broadcast();
    } else {
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec("UPDATE public_rooms SET status = 'WAITING' WHERE id = ? AND status = 'STARTING'", code);
        this.recordEvent(code, userId, 'PLAYER_JOINED', { seat: result.seat, playerCount: result.seat + 1, capacity: room.capacity });
      });
    }
    const balance = this.moneyActive ? await this.env.DB.prepare("SELECT balance_santim FROM wallets WHERE user_id = ? AND wallet_kind = 'real'").bind(userId).first<{ balance_santim: number }>() : null;
    return reply({ room: this.roomViewForUser(code, userId), balanceSantim: balance?.balance_santim || 0, balance: (balance?.balance_santim || 0) / 100 }, 201);
  }

  private async cancelRoom(id: string, userId: number, administrator: boolean): Promise<Response> {
    const row = this.roomRow(id.toUpperCase());
    if (!row) return reply({ error: 'Public room not found.' }, 404);
    if (administrator) {
      if (!Number.isSafeInteger(userId) || userId <= 0) return reply({ error: 'Administrator identity is missing.' }, 401);
      if (row.status === 'COMPLETED' || row.status === 'CANCELLED' || row.status === 'EXPIRED') return reply({ error: 'This room is already closed.' }, 409);
      if (row.status === 'STARTING' || row.status === 'SETTLING') return reply({ error: 'This room is starting or settling and cannot be cancelled right now.' }, 409);
    } else {
      if (!Number.isSafeInteger(userId) || userId <= 0) return reply({ error: 'Sign in to cancel your room.' }, 401);
      if (row.creator_id !== userId) return reply({ error: 'Only the room creator can cancel this room.' }, 403);
      if (row.status !== 'WAITING') return reply({ error: 'This room can no longer be cancelled by its creator.' }, 409);
    }
    if (administrator && row.match_id) {
      const completed = await this.env.DB.prepare("SELECT id FROM matches WHERE id = ? AND status = 'completed'").bind(row.match_id).first();
      if (completed) return reply({ error: 'The verified match is complete and cannot be cancelled.' }, 409);
    }
    const cancelled = this.state.storage.transactionSync(() => {
      const current = this.roomRow(row.id);
      if (!current || ['COMPLETED', 'CANCELLED', 'EXPIRED', 'STARTING', 'SETTLING'].includes(current.status)) return false;
      if (!administrator && current.status !== 'WAITING') return false;
      this.state.storage.sql.exec("UPDATE public_rooms SET status = 'CANCELLED' WHERE id = ?", current.id);
      this.recordEvent(current.id, userId, administrator ? 'ADMIN_CANCELLED' : 'CREATOR_CANCELLED', { previousStatus: current.status });
      return true;
    });
    if (!cancelled) return reply({ error: 'This room is no longer available to cancel.' }, 409);
    const refunded = await this.refundRoom(row.id);
    await this.cancelGameRoom(row.code);
    if (administrator) this.adminAudit(userId, 'ROOM_CANCELLED', row.id, { previousStatus: row.status });
    this.broadcast();
    if (!refunded) return reply({ error: 'The room was closed, but a refund is pending reconciliation.' }, 503);
    return reply({ room: this.roomView(row.id) });
  }

  private session(id: string, userId: number): Response {
    const code = id.toUpperCase();
    const row = this.roomRow(code);
    if (!row || !this.isPlayer(code, userId)) return reply({ error: 'You are not a player in this room.' }, 403);
    if (row.game_id === 'poker') return reply({ error: 'American Texas is coming soon.' }, 409);
    if (row.status !== 'IN_PROGRESS' && row.status !== 'SETTLING' && row.status !== 'COMPLETED') return reply({ error: 'This room is still preparing the game.' }, 409);
    return reply({ code: row.code, gameId: row.game_id, matchId: row.match_id, room: this.roomViewForUser(row.id, userId) });
  }

  private async settle(request: Request): Promise<Response> {
    const input = await request.json().catch(() => null) as { code?: unknown; matchId?: unknown } | null;
    if (!input || typeof input.code !== 'string' || typeof input.matchId !== 'string') return reply({ error: 'Settlement reference is invalid.' }, 400);
    const row = this.roomRow(input.code.toUpperCase());
    if (!row || row.match_id !== input.matchId || !['IN_PROGRESS', 'SETTLING', 'COMPLETED'].includes(row.status)) return reply({ error: 'Match is not ready for settlement.' }, 409);
    const record = await this.env.DB.prepare('SELECT room_id, status, result_json FROM matches WHERE id = ?').bind(input.matchId).first<{ room_id: string; status: string; result_json: string | null }>();
    if (record?.room_id === row.id && record.status === 'voided') return this.refundVoidedMatch(row.id, input.matchId);
    if (!record || record.room_id !== row.id || record.status !== 'completed' || !record.result_json) return reply({ error: 'The match result has not been verified by the game service.' }, 409);
    let winner: number | 'draw';
    try {
      const result = JSON.parse(record.result_json) as { winner?: unknown };
      if (result.winner === 'draw') winner = 'draw';
      else if (Number.isInteger(result.winner) && (result.winner as number) >= 0 && (result.winner as number) < row.capacity) winner = result.winner as number;
      else return reply({ error: 'The match result is invalid.' }, 409);
    } catch { return reply({ error: 'The match result is invalid.' }, 409); }
    const players = this.state.storage.sql.exec<PlayerRow>('SELECT user_id, display_name, seat, reserved_units FROM public_room_players WHERE room_id = ? ORDER BY seat', row.id).toArray();
    if (players.length !== row.capacity) return reply({ error: 'The completed match has an incomplete room.' }, 409);
    const calculated = row.wallet_kind === 'real' ? calculateSettlement(row.entry_credits, players.length) : { poolTenths: 0, payoutTenths: 0, perWinnerTenths: 0 };
    const locked = this.state.storage.transactionSync(() => {
      const current = this.roomRow(row.id);
      if (!current || current.status === 'CANCELLED' || current.status === 'EXPIRED') return 'closed';
      if (current.status === 'COMPLETED') return 'already';
      if (current.status === 'IN_PROGRESS') {
        this.state.storage.sql.exec("UPDATE public_rooms SET status = 'SETTLING' WHERE id = ? AND status = 'IN_PROGRESS'", row.id);
        this.recordEvent(row.id, null, 'SETTLEMENT_STARTED', { matchId: input.matchId });
      }
      return 'settling';
    });
    if (locked === 'closed') return reply({ error: 'Room was closed before settlement.' }, 409);
    if (locked === 'already') {
      return reply({ settled: false, alreadySettled: true, room: this.roomView(row.id) });
    }

    if (row.wallet_kind === 'real') {
      for (const player of players) {
        const hold = await this.env.DB.prepare(`SELECT amount_santim FROM wallet_transactions
          WHERE idempotency_key = ? AND wallet_kind = 'real'`).bind(`public-room-entry:${row.code}:${player.seat}`).first<{ amount_santim: number }>();
        if (!hold || hold.amount_santim !== -player.reserved_units || player.reserved_units !== row.entry_credits * 100) {
          return reply({ error: 'The entry-fund record is incomplete; settlement is held for reconciliation.' }, 503);
        }
      }
      const payoutSantim = calculated.payoutTenths * 10;
      const payouts = winner === 'draw'
        ? players.map((player) => ({ player, amount: Math.floor(payoutSantim / players.length) + (player.seat === 0 ? payoutSantim % players.length : 0) }))
        : players.map((player) => ({ player, amount: player.seat === winner ? payoutSantim : 0 }));
      for (const payout of payouts) {
        if (payout.amount && !(await this.creditWallet(payout.player.user_id, payout.amount, 'match_payout', `public-room-payout:${row.code}:${payout.player.user_id}`, input.matchId))) {
          return reply({ error: 'The result is verified, but its wallet payout is pending reconciliation.' }, 503);
        }
      }
    }
    const settled = this.state.storage.transactionSync(() => {
      const current = this.roomRow(row.id);
      if (!current || current.status === 'COMPLETED') return false;
      if (current.status !== 'SETTLING') return false;
      this.state.storage.sql.exec(`UPDATE public_rooms SET status = 'COMPLETED', pool_tenths = ?, fee_tenths = 0,
        payout_tenths = ?, winner = ?, settled_at = ? WHERE id = ? AND status = 'SETTLING'`,
        calculated.poolTenths, calculated.payoutTenths, winner === 'draw' ? -1 : winner, Date.now(), row.id);
      this.state.storage.sql.exec('UPDATE public_room_players SET reserved_units = 0 WHERE room_id = ?', row.id);
      this.recordEvent(row.id, null, 'MATCH_SETTLED', { winner, poolTenths: calculated.poolTenths, payoutTenths: calculated.payoutTenths, walletKind: row.wallet_kind });
      return true;
    });
    if (!settled && this.roomRow(row.id)?.status !== 'COMPLETED') return reply({ error: 'Settlement is pending reconciliation.' }, 503);
    this.broadcast();
    return reply({ settled, alreadySettled: !settled, room: this.roomView(row.id) });
  }

  private async voidMatch(request: Request): Promise<Response> {
    const input = await request.json().catch(() => null) as { code?: unknown; matchId?: unknown } | null;
    if (!input || typeof input.code !== 'string' || typeof input.matchId !== 'string') return reply({ error: 'Match reference is invalid.' }, 400);
    const row = this.roomRow(input.code.toUpperCase());
    if (!row || row.match_id !== input.matchId) return reply({ error: 'Public match was not found.' }, 404);
    const record = await this.env.DB.prepare('SELECT room_id, status FROM matches WHERE id = ?').bind(input.matchId).first<{ room_id: string; status: string }>();
    if (!record || record.room_id !== row.id || record.status !== 'voided') return reply({ error: 'The game service has not voided this match.' }, 409);
    return this.refundVoidedMatch(row.id, input.matchId);
  }

  private async refundVoidedMatch(roomId: string, matchId: string): Promise<Response> {
    const cancelled = this.state.storage.transactionSync(() => {
      const current = this.roomRow(roomId);
      if (!current || current.match_id !== matchId) return false;
      if (current.status === 'CANCELLED') return true;
      if (current.status !== 'IN_PROGRESS') return false;
      this.state.storage.sql.exec("UPDATE public_rooms SET status = 'CANCELLED' WHERE id = ? AND status = 'IN_PROGRESS'", roomId);
      this.recordEvent(roomId, null, 'MATCH_VOIDED_REFUND_STARTED', { matchId });
      return true;
    });
    if (!cancelled) return reply({ error: 'Public match is no longer eligible for a refund.' }, 409);
    const refunded = await this.refundRoom(roomId);
    this.broadcast();
    if (!refunded) return reply({ error: 'The match was voided, but its wallet refund is pending reconciliation.' }, 503);
    return reply({ refunded: true, room: this.roomView(roomId) });
  }

  private async reconcile(): Promise<Response> {
    const rows = this.state.storage.sql.exec<{ id: string; match_id: string }>("SELECT id, match_id FROM public_rooms WHERE status IN ('IN_PROGRESS','SETTLING') AND match_id IS NOT NULL ORDER BY created_at LIMIT 100").toArray();
    let settled = 0;
    for (const row of rows) {
      const result = await this.settle(new Request('https://market/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: row.id, matchId: row.match_id }) }));
      if (result.ok) {
        const data = await result.json() as { settled?: boolean };
        if (data.settled) settled++;
      }
    }
    const refunds = this.state.storage.sql.exec<{ id: string }>(`SELECT DISTINCT r.id FROM public_rooms r
      JOIN public_room_players p ON p.room_id = r.id WHERE r.status IN ('CANCELLED','EXPIRED') AND p.reserved_units > 0 LIMIT 100`).toArray();
    let refunded = 0;
    for (const room of refunds) if (await this.refundRoom(room.id)) refunded++;
    return reply({ checked: rows.length, settled, refundsChecked: refunds.length, refundsReturned: refunded });
  }

  private async adminRooms(gameId: string | null): Promise<Response> {
    if (gameId && !isMarketplaceGame(gameId)) return reply({ error: 'Game filter is invalid.' }, 400);
    const filter = gameId ? 'WHERE game_id = ?' : '';
    const params = gameId ? [gameId] : [];
    const rows = this.state.storage.sql.exec<RoomRow>(`SELECT * FROM public_rooms ${filter} ORDER BY created_at DESC LIMIT 100`, ...params).toArray();
    const stats = this.state.storage.sql.exec<{ status: PublicStatus; count: number; volume: number; players: number }>(`SELECT status, COUNT(*) AS count,
      SUM(CASE WHEN status = 'COMPLETED' AND wallet_kind = 'real' THEN pool_tenths ELSE 0 END) AS volume,
      SUM(player_count) AS players FROM public_rooms ${filter} GROUP BY status`, ...params).toArray();
    const counts: Record<string, number> = { total: 0, active: 0, waiting: 0, full: 0, inProgress: 0, completed: 0, cancelled: 0, expired: 0, realVolumeEtb: 0, averagePlayers: 0 };
    for (const stat of stats) {
      counts.total += stat.count;
      if (stat.status === 'WAITING') counts.waiting = stat.count;
      if (stat.status === 'FULL') counts.full = stat.count;
      if (stat.status === 'IN_PROGRESS' || stat.status === 'STARTING' || stat.status === 'SETTLING') counts.inProgress += stat.count;
      if (stat.status === 'COMPLETED') counts.completed = stat.count;
      if (stat.status === 'CANCELLED') counts.cancelled = stat.count;
      if (stat.status === 'EXPIRED') counts.expired = stat.count;
      if (['WAITING', 'FULL', 'STARTING', 'IN_PROGRESS', 'SETTLING'].includes(stat.status)) counts.active += stat.count;
      counts.realVolumeEtb += credits(stat.volume || 0);
    }
    const totalPlayers = stats.reduce((sum, item) => sum + item.players, 0);
    counts.averagePlayers = counts.total ? Math.round((totalPlayers / counts.total) * 100) / 100 : 0;
    const audit = this.state.storage.sql.exec<{ admin_user_id: number; action: string; entity_id: string | null; payload_json: string; created_at: number }>(
      'SELECT admin_user_id, action, entity_id, payload_json, created_at FROM marketplace_admin_audit ORDER BY id DESC LIMIT 50',
    ).toArray().map((event) => ({ adminId: event.admin_user_id, action: event.action, entityId: event.entity_id, detail: JSON.parse(event.payload_json), createdAt: event.created_at }));
    return reply({ stats: counts, settings: this.settings(), rooms: rows.map((row) => this.roomView(row.id)).filter(Boolean), audit });
  }

  private adminRoom(id: string): Response {
    const row = this.roomRow(id.toUpperCase());
    if (!row) return reply({ error: 'Public room not found.' }, 404);
    const events = this.state.storage.sql.exec<{ event_type: string; actor_user_id: number | null; payload_json: string; created_at: number }>(
      'SELECT event_type, actor_user_id, payload_json, created_at FROM public_room_events WHERE room_id = ? ORDER BY id DESC LIMIT 100', row.id,
    ).toArray().map((event) => ({ type: event.event_type, actorId: event.actor_user_id, detail: JSON.parse(event.payload_json), createdAt: event.created_at }));
    return reply({ room: this.roomView(row.id), events });
  }

  private async updateSettings(request: Request): Promise<Response> {
    const input = await request.json().catch(() => null);
    const settings = validateMarketplaceSettings(input);
    if (!settings) return reply({ error: 'Settings are invalid. Check entry amounts, waiting time and maximum.' }, 400);
    const adminId = Number(request.headers.get('X-Market-Admin'));
    if (!Number.isSafeInteger(adminId) || adminId <= 0) return reply({ error: 'Administrator identity is missing.' }, 401);
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec('UPDATE marketplace_settings SET settings_json = ?, updated_at = ? WHERE singleton = 1', JSON.stringify(settings), Date.now());
      this.adminAudit(adminId, 'MARKETPLACE_SETTINGS_CHANGED', null, settings);
    });
    await this.scheduleAlarm();
    return reply({ settings });
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return reply({ error: 'WebSocket upgrade required.' }, 426);
    const gameId = new URL(request.url).searchParams.get('gameId') || '';
    if (!isMarketplaceGame(gameId)) return reply({ error: 'Game filter is invalid.' }, 400);
    if (gameId === 'poker') return reply({ error: 'American Texas is coming soon.' }, 409);
    const userId = Number(request.headers.get('X-Market-User') || 0);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ gameId, userId: Number.isSafeInteger(userId) ? userId : 0 });
    this.state.acceptWebSocket(server, [`market:${gameId}`]);
    try { server.send(JSON.stringify(this.snapshot(gameId, userId))); } catch { server.close(1011, 'Unable to load room list'); }
    return new Response(null, { status: 101, webSocket: client });
  }

  private snapshot(gameId: string, userId: number): unknown {
    return { type: 'market', rooms: this.waitingRooms(gameId), ownRoom: userId > 0 ? this.myRoom(userId, gameId) : null, serverTime: Date.now() };
  }

  private broadcast(): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { gameId?: string; userId?: number } | null;
      if (!attachment?.gameId) continue;
      try { socket.send(JSON.stringify(this.snapshot(attachment.gameId, attachment.userId || 0))); }
      catch { socket.close(1011, 'Unable to send room update'); }
    }
  }

  private waitingRooms(gameId: string | null, moneyActive = this.moneyActive): MarketRoom[] {
    const now = Date.now();
    const visibility = moneyActive ? "AND wallet_kind IN ('free','real')" : "AND wallet_kind = 'free'";
    const rows = gameId && isMarketplaceGame(gameId)
      ? this.state.storage.sql.exec<RoomRow>(`SELECT * FROM public_rooms WHERE status = 'WAITING' AND game_ready = 1 AND expires_at > ? AND game_id = ? AND game_id != 'poker' ${visibility} ORDER BY created_at DESC LIMIT 100`, now, gameId).toArray()
      : this.state.storage.sql.exec<RoomRow>(`SELECT * FROM public_rooms WHERE status = 'WAITING' AND game_ready = 1 AND expires_at > ? AND game_id != 'poker' ${visibility} ORDER BY created_at DESC LIMIT 100`, now).toArray();
    return rows.map((row) => this.roomView(row.id)!).filter(Boolean);
  }

  private myRoom(userId: number, gameId: string | null): MarketRoom | null {
    if (!Number.isSafeInteger(userId) || userId <= 0 || gameId === 'poker') return null;
    const row = gameId && isMarketplaceGame(gameId)
      ? this.state.storage.sql.exec<{ room_id: string }>(`SELECT p.room_id FROM public_room_players p JOIN public_rooms r ON r.id = p.room_id
        WHERE p.user_id = ? AND r.game_id = ? AND r.status IN ('WAITING','FULL','STARTING','IN_PROGRESS','SETTLING','CANCELLED','EXPIRED') ORDER BY p.joined_at DESC LIMIT 1`, userId, gameId).toArray()[0]
      : this.state.storage.sql.exec<{ room_id: string }>(`SELECT p.room_id FROM public_room_players p JOIN public_rooms r ON r.id = p.room_id
        WHERE p.user_id = ? AND r.status IN ('WAITING','FULL','STARTING','IN_PROGRESS','SETTLING','CANCELLED','EXPIRED') ORDER BY p.joined_at DESC LIMIT 1`, userId).toArray()[0];
    return row ? this.roomViewForUser(row.room_id, userId) : null;
  }

  private roomRow(id: string): RoomRow | null {
    return this.state.storage.sql.exec<RoomRow>('SELECT * FROM public_rooms WHERE id = ?', id).toArray()[0] || null;
  }

  private roomView(id: string): MarketRoom | null {
    const row = this.roomRow(id);
    if (!row) return null;
    const players = this.state.storage.sql.exec<PlayerRow>('SELECT user_id, display_name, seat, reserved_units FROM public_room_players WHERE room_id = ? ORDER BY seat', id).toArray();
    const expected = row.wallet_kind === 'real' ? calculateSettlement(row.entry_credits, row.capacity) : { poolTenths: 0, payoutTenths: 0, perWinnerTenths: 0 };
    let options: Record<string, unknown> = {};
    try { options = JSON.parse(row.options_json) as Record<string, unknown>; } catch { /* Keep malformed stored options out of the response. */ }
    return {
      id: row.id, code: row.code, gameId: row.game_id, creatorName: row.creator_name,
      creatorAvatar: (row.creator_name.trim()[0] || 'P').toUpperCase(),
      players: players.map((player) => ({ name: player.display_name, avatar: (player.display_name.trim()[0] || 'P').toUpperCase(), seat: player.seat })),
      playerCount: row.player_count, capacity: row.capacity, entryCredits: row.wallet_kind === 'demo' ? 0 : row.entry_credits,
      poolCredits: credits(row.status === 'COMPLETED' ? row.pool_tenths : expected.poolTenths),
      payoutCredits: credits(row.status === 'COMPLETED' ? row.payout_tenths : expected.payoutTenths),
      mode: row.game_id === 'ludo' ? `Classic · ${Number(options.crownTarget) || 4} ${Number(options.crownTarget) === 1 ? 'crown' : 'crowns'}` : row.game_id === 'poker' ? 'Heads-up' : row.game_id === 'checkers' ? 'American · two players' : 'Classic · two players',
      options, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at,
      matchId: row.match_id, winner: row.winner === -1 ? null : row.winner, walletKind: row.wallet_kind,
    };
  }

  private roomViewForUser(id: string, userId: number): MarketRoom | null {
    const room = this.roomView(id);
    if (!room) return null;
    const player = this.state.storage.sql.exec<{ seat: number }>('SELECT seat FROM public_room_players WHERE room_id = ? AND user_id = ?', id, userId).toArray()[0];
    return player ? { ...room, viewerSeat: player.seat, viewerIsCreator: this.roomRow(id)?.creator_id === userId } : room;
  }

  private isPlayer(roomId: string, userId: number): boolean {
    return Boolean(this.state.storage.sql.exec('SELECT 1 FROM public_room_players WHERE room_id = ? AND user_id = ?', roomId, userId).toArray().length);
  }

  private recordEvent(roomId: string, actor: number | null, event: string, payload: unknown): void {
    this.state.storage.sql.exec('INSERT INTO public_room_events (room_id, actor_user_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)', roomId, actor, event, JSON.stringify(payload), Date.now());
  }

  private adminAudit(adminId: number, action: string, entityId: string | null, payload: unknown): void {
    this.state.storage.sql.exec('INSERT INTO marketplace_admin_audit (admin_user_id, action, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)', adminId, action, entityId, JSON.stringify(payload), Date.now());
  }

  private async refundRoom(roomId: string): Promise<boolean> {
    const room = this.roomRow(roomId);
    if (!room) return false;
    const players = this.state.storage.sql.exec<PlayerRow>('SELECT user_id, display_name, seat, reserved_units FROM public_room_players WHERE room_id = ? AND reserved_units > 0', roomId).toArray();
    for (const player of players) {
      if (room.wallet_kind === 'real' && !(await this.refundWallet(player.user_id, player.reserved_units, `public-room-entry:${room.code}:${player.seat}`, room.code))) {
        this.recordEvent(roomId, null, 'WALLET_REFUND_PENDING', { userId: player.user_id, seat: player.seat });
        return false;
      }
      this.state.storage.sql.exec('UPDATE public_room_players SET reserved_units = 0 WHERE room_id = ? AND user_id = ? AND reserved_units = ?', roomId, player.user_id, player.reserved_units);
    }
    if (players.length) this.recordEvent(roomId, null, room.wallet_kind === 'real' ? 'WALLET_FUNDS_RETURNED' : 'LEGACY_PREVIEW_ROOM_CLOSED', { players: players.length });
    return true;
  }

  private async cancelBySystem(roomId: string, reason: string, cancelGameRoom = true): Promise<void> {
    const row = this.roomRow(roomId);
    if (!row) return;
    const shouldClose = this.state.storage.transactionSync(() => {
      const current = this.roomRow(roomId);
      if (!current || current.status === 'COMPLETED' || current.status === 'SETTLING') return false;
      if (current.status === 'CANCELLED' || current.status === 'EXPIRED') return true;
      this.state.storage.sql.exec("UPDATE public_rooms SET status = 'CANCELLED' WHERE id = ?", roomId);
      this.recordEvent(roomId, null, 'ROOM_CANCELLED_BY_SYSTEM', { reason });
      return true;
    });
    if (!shouldClose) return;
    if (!(await this.refundRoom(roomId))) this.recordEvent(roomId, null, 'WALLET_REFUND_PENDING', { reason });
    if (cancelGameRoom) await this.cancelGameRoom(row.code);
    this.broadcast();
  }

  private async expireRoom(roomId: string): Promise<void> {
    const row = this.roomRow(roomId);
    if (!row) return;
    const expired = this.state.storage.transactionSync(() => {
      const current = this.roomRow(roomId);
      if (!current || current.status !== 'WAITING' || current.expires_at > Date.now()) return current?.status === 'EXPIRED';
      this.state.storage.sql.exec("UPDATE public_rooms SET status = 'EXPIRED' WHERE id = ?", roomId);
      this.recordEvent(roomId, null, 'ROOM_EXPIRED', {});
      return true;
    });
    if (!expired) return;
    if (!(await this.refundRoom(roomId))) this.recordEvent(roomId, null, 'WALLET_REFUND_PENDING', { reason: 'ROOM_EXPIRED' });
    await this.cancelGameRoom(row.code);
    await this.scheduleAlarm();
    this.broadcast();
  }

  private async cancelGameRoom(code: string): Promise<void> {
    const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(code));
    await stub.fetch('https://room/cancel-public', { method: 'POST' }).catch(() => undefined);
  }

  private async scheduleAlarm(): Promise<void> {
    const next = this.state.storage.sql.exec<{ expires_at: number }>("SELECT MIN(expires_at) AS expires_at FROM public_rooms WHERE status = 'WAITING'").toArray()[0]?.expires_at;
    if (typeof next === 'number') await this.state.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.state.storage.deleteAlarm();
  }
}
