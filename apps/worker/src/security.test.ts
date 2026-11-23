import { describe, expect, it, vi } from 'vitest';
import worker, { moneyActivationRecorded, validateInitData } from './index';
import { freePlayEligibilityError } from './activation';
import { PUBLIC_GAMES } from '@dire-bet/shared';

const token = 'test-bot-token';
const encoder = new TextEncoder();

async function sign(keyText: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function hex(bytes: Uint8Array): string { return [...bytes].map((byte) => byte.toString(16).padStart(2,'0')).join(''); }
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function fromBase64url(value: string): Uint8Array { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0)); }

async function passwordHash(password: string, salt: string, secret: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(`${secret}\u0000${password}`), 'PBKDF2', false, ['deriveBits']);
  return base64url(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: ownedBuffer(fromBase64url(salt)), iterations: 600_000, hash: 'SHA-256' }, material, 256)));
}

async function initData(authDate: number): Promise<string> {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'practice-query',
    user: JSON.stringify({ id: 123456789, first_name: 'Practice', language_code: 'en' }),
  });
  const check = [...params.entries()].map(([key,value]) => `${key}=${value}`).sort().join('\n');
  const secret = await sign('WebAppData', token);
  const key = await crypto.subtle.importKey('raw', ownedBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  params.set('hash', hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(check)))));
  return params.toString();
}

async function signedSession(secret: string, userId: number): Promise<string> {
  const body = `${base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${base64url(encoder.encode(JSON.stringify({ sub: String(userId), exp: Math.floor(Date.now() / 1000) + 60 })))}`;
  return `${body}.${base64url(await sign(secret, body))}`;
}

async function refreshHash(secret: string, refreshToken: string): Promise<string> {
  return hex(await sign(secret, `dire-bet-refresh-v1:${refreshToken}`));
}

describe('Telegram initData verification', () => {
  it('accepts correctly signed, fresh user data', async () => {
    const verified = await validateInitData(await initData(Math.floor(Date.now()/1000)), token);
    expect(verified?.user.id).toBe(123456789);
  });
  it('rejects changed data and expired data', async () => {
    const valid = await initData(Math.floor(Date.now()/1000));
    expect(await validateInitData(`${valid}&first_name=attacker`, token)).toBeNull();
    expect(await validateInitData(await initData(Math.floor(Date.now()/1000)-3601), token)).toBeNull();
  });
  it('rejects duplicate fields', async () => {
    const valid = await initData(Math.floor(Date.now()/1000));
    expect(await validateInitData(`${valid}&user=%7B%7D`, token)).toBeNull();
  });
});

describe('account sign-in paths', () => {
  it('authenticates an existing Telegram account and returns its saved contact status', async () => {
    const statements: string[] = [];
    const db = { prepare: (sql: string) => ({ bind: () => ({
      first: async () => {
        statements.push(sql);
        if (sql.includes('INSERT INTO users (telegram_id')) return { id: 42 };
        if (sql.includes('SELECT id, first_name, web_username, language')) return { id: 42, first_name: 'Existing', web_username: 'existing_user', language: 'am', phone_shared: 1 };
        return null;
      },
      run: async () => { statements.push(sql); return { success: true, meta: { changes: 1 } }; },
    }) }) };
    const env = { TELEGRAM_BOT_TOKEN: token, SESSION_SECRET: 'session-secret', DB: db } as never;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: await initData(Math.floor(Date.now() / 1000)) }),
    }), env);
    expect(response.status).toBe(200);
    const data = await response.json() as { token: string; refreshToken: string; expiresIn: number };
    expect(data.refreshToken).toBeTruthy();
    expect(data.expiresIn).toBe(24 * 60 * 60);
    expect(statements.filter((sql) => sql.includes('INSERT INTO users (telegram_id'))).toHaveLength(1);
    expect(statements.find((sql) => sql.includes('INSERT INTO users (telegram_id'))).toContain('ON CONFLICT(telegram_id) DO UPDATE');
    expect(statements.some((sql) => sql.includes('INSERT INTO auth_sessions'))).toBe(true);
    const profile = await worker.fetch(new Request('https://dire-bet.test/api/me', { headers: { Authorization: `Bearer ${data.token}` } }), env);
    expect(profile.status).toBe(200);
    const user = (await profile.json() as { user: { displayName: string; phoneShared: boolean; ageEligibility?: string; ageReviewPending?: boolean } }).user;
    expect(user).toMatchObject({ displayName: 'existing_user', phoneShared: true });
    expect(user.ageEligibility).toBeUndefined();
    expect(user.ageReviewPending).toBeUndefined();
  });

  it('keeps the regular browser username and PIN login working', async () => {
    const secret = 'browser-session-secret';
    const salt = 'AAECAwQFBgcICQoLDA0ODw';
    const db = { prepare: () => ({ bind: () => ({
      first: async () => ({ id: 7, first_name: 'Browser', web_username: 'browser_user', password_salt: salt, password_hash: await passwordHash('12345678', salt, secret) }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }) }) };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }) };
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/password', {
      method: 'POST', headers: { Origin: 'https://dire-bet.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'browser_user', password: '12345678' }),
    }), { SESSION_SECRET: secret, DB: db, RATE_LIMITER: rateLimiter } as never);
    expect(response.status).toBe(200);
    expect(await response.json() as { token: string; refreshToken: string; user: { displayName: string } }).toMatchObject({ user: { displayName: 'browser_user' } });
  });
});

describe('American Texas listing', () => {
  it('stays listed but cannot be started', () => {
    expect(PUBLIC_GAMES.find((game) => game.id === 'poker')).toMatchObject({ title: 'American Texas', availability: 'coming-soon' });
  });

  it('rejects direct private and public room creation', async () => {
    const secret = 'coming-soon-room-secret';
    const authorization = `Bearer ${await signedSession(secret, 9)}`;
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => {
      if (sql.includes('SELECT status FROM users')) return { status: 'active' };
      if (sql.includes('FROM user_contacts')) return { user_id: 9 };
      return null;
    } }) }) };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }) };
    const env = { SESSION_SECRET: secret, DB: db, RATE_LIMITER: rateLimiter } as never;
    const privateRoom = await worker.fetch(new Request('https://dire-bet.test/api/rooms', {
      method: 'POST', headers: { Authorization: authorization, Origin: 'https://dire-bet.test', 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'poker' }),
    }), env);
    const publicRoom = await worker.fetch(new Request('https://dire-bet.test/api/public-rooms', {
      method: 'POST', headers: { Authorization: authorization, Origin: 'https://dire-bet.test', 'content-type': 'application/json' }, body: JSON.stringify({ gameId: 'poker', entry: 'free', idempotencyKey: 'american-texas-key' }),
    }), env);
    expect(privateRoom.status).toBe(409);
    expect(publicRoom.status).toBe(409);
  });
});

describe('real-money activation gate', () => {
  const evidence = { counselApproval:'signed opinion', licenseReview:'reviewed', licenseReferences:['license ref'], providerApprovals:{ telebirr:'merchant approval', ebirr:'merchant approval' }, telegramApproval:'written approval', nationalBankReview:'written review', ageVerificationMethod:'verified method', responsiblePlayPolicy:'approved policy', privacyReview:'approved policy', minimumAge:18, ownerSignedAt:'2026-11-15' };
  function env(flags: { real:string; demo:string; record?:string; audit?:boolean }) {
    const db = { prepare: (sql:string) => ({ bind: () => ({ first: async () => flags.audit ? { id:'activation-audit' } : null }), first: async () => sql.includes('activation_records') && flags.record ? { id:'record-1', evidence_json:flags.record, minimum_age:18 } : null }) };
    return { REAL_MONEY_ENABLED:flags.real, DEMO_MODE:flags.demo, DB:db } as never;
  }
  it('fails closed unless both flags, all evidence and the immutable audit row exist', async () => {
    expect(await moneyActivationRecorded(env({real:'false',demo:'true',record:JSON.stringify(evidence),audit:true}))).toBe(false);
    expect(await moneyActivationRecorded(env({real:'true',demo:'false',record:JSON.stringify(evidence)}))).toBe(false);
    expect(await moneyActivationRecorded(env({real:'true',demo:'false',record:'{}',audit:true}))).toBe(false);
    expect(await moneyActivationRecorded(env({real:'true',demo:'false',record:JSON.stringify(evidence),audit:true}))).toBe(true);
  });
});

describe('wallet proof and agent signup credit', () => {
  const secret = 'wallet-flow-test-secret';
  const evidence = { counselApproval:'signed opinion', licenseReview:'reviewed', licenseReferences:['license ref'], providerApprovals:{ telebirr:'merchant approval', ebirr:'merchant approval' }, telegramApproval:'written approval', nationalBankReview:'written review', ageVerificationMethod:'verified method', responsiblePlayPolicy:'approved policy', privacyReview:'approved policy', minimumAge:18, ownerSignedAt:'2026-11-15' };

  function walletEnv(captured: { sql: string; values: unknown[] }[], options: { activated?: boolean; simulated?: boolean; admin?: boolean; referredAge?: string | null } = {}) {
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) { this.values = values; return this; },
          first: async () => {
            if (sql.includes('FROM activation_records')) return options.activated ? { id:'activation-1', evidence_json:JSON.stringify(evidence), minimum_age:18 } : null;
            if (sql.includes("action = 'REAL_MONEY_ACTIVATION_RECORDED'")) return options.activated ? { id:'audit-1' } : null;
            if (sql.includes('SELECT u.status, p.age_eligibility')) return { status:'active', age_eligibility:'verified' };
            if (sql.includes('SELECT telegram_id FROM users')) return options.admin ? { telegram_id:7788 } : null;
            if (sql.includes('SELECT status, wallet_kind, simulation_only, user_id FROM')) return { status:'pending', wallet_kind:options.simulated ? 'demo' : 'real', simulation_only:options.simulated ? 1 : 0, user_id:71 };
            if (sql.includes('FROM payment_settings')) return { account_number:'0911111111', enabled:1, minimum_santim:5000, maximum_santim:1_000_000 };
            if (sql.includes('FROM agents WHERE referral_code')) return { id:'agent-1', user_id:2 };
            if (sql.includes('SELECT source_code FROM referrals')) return null;
            if (sql.includes('SELECT p.age_eligibility')) return { age_eligibility:options.referredAge || 'unverified', credited:0 };
            return null;
          },
          all: async () => ({ results:[] }),
          run: async () => { captured.push(statement); return { success:true, meta:{ changes:1 } }; },
        };
        return statement;
      },
      batch: async (statements: { sql: string; values: unknown[] }[]) => { captured.push(...statements); return []; },
    };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed:true }), { status:200 }) }) };
    return { DB:db, SESSION_SECRET:secret, SUPER_ADMIN_TELEGRAM_ID:options.admin ? '7788' : undefined, REAL_MONEY_ENABLED:options.activated ? 'true' : 'false', DEMO_MODE:'false', SIMULATED_WALLET_ENABLED:options.simulated ? 'true' : 'false', RATE_LIMITER:rateLimiter } as never;
  }

  async function deposit(body: Record<string, unknown>, captured: { sql: string; values: unknown[] }[]) {
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    return worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:JSON.stringify(body),
    }), walletEnv(captured, { activated:true }));
  }

  it('requires the payment SMS and ignores old receipt-only submissions', async () => {
    const input = { provider:'telebirr', amount:100, confirmationSms:'Dear customer, ETB 100 was paid. Trans ID: PAY12345 completed', idempotencyKey:'deposit-sms-test-0001' };
    const stored: { sql: string; values: unknown[] }[] = [];
    const accepted = await deposit(input, stored);
    expect(accepted.status).toBe(201);
    expect(stored.some((statement) => statement.sql.includes('confirmation_sms_ciphertext'))).toBe(true);
    expect(stored.some((statement) => statement.sql.includes('INSERT INTO receipt_blobs'))).toBe(false);

    const rejectedStatements: { sql: string; values: unknown[] }[] = [];
    const receiptOnly = await deposit({ ...input, confirmationSms: undefined, receiptData:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZ8AAAAASUVORK5CYII=' }, rejectedStatements);
    expect(receiptOnly.status).toBe(400);
    expect(rejectedStatements).toHaveLength(0);
  });

  it('links a referral and leaves its 10 Birr credit pending until the real-money age gate opens', async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/referrals/claim', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:JSON.stringify({ code:'AGENT1' }),
    }), walletEnv(statements));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ bonusBirr:10, bonusStatus:'pending_age', walletEnabled:false });
    expect(statements.some((statement) => statement.sql.includes('agent-signup-bonus:'))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes('age_eligibility = \'verified\'') && statement.sql.includes('1000'))).toBe(true);
  });

  describe('simulated wallet requests', () => {
  it('keeps simulation balance and deposits out of the real wallet', async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    const balance = await worker.fetch(new Request('https://dire-bet.test/api/wallet/balance', { headers:{ Authorization:authorization } }), walletEnv(statements, { simulated:true }));
    expect(await balance.json()).toMatchObject({ enabled:true, simulated:true, balance:0 });

    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' },
      body:JSON.stringify({ provider:'telebirr', amount:100, confirmationSms:'unparseable payment note with enough characters 12345', idempotencyKey:'simulation-deposit-test-01' }),
    }), walletEnv(statements, { simulated:true }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status:'pending', simulationOnly:true });
    expect(statements.some((statement) => statement.sql.includes('INSERT INTO deposit_requests') && statement.values.includes('demo') && statement.values.includes(1))).toBe(true);
    expect(statements.some((statement) => statement.sql.includes('INSERT INTO wallet_transactions'))).toBe(false);
  });

  it('submits simulated withdrawals and records admin approval without enabling live money', async () => {
    const statements: { sql: string; values: unknown[] }[] = [];
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    const withdrawal = await worker.fetch(new Request('https://dire-bet.test/api/wallet/withdrawals', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' },
      body:JSON.stringify({ provider:'ebirr', amount:100, destinationPhone:'0912345678', idempotencyKey:'simulation-withdrawal-test-01' }),
    }), walletEnv(statements, { simulated:true }));
    expect(withdrawal.status).toBe(201);
    expect(await withdrawal.json()).toMatchObject({ status:'pending', simulationOnly:true });
    expect(statements.some((statement) => statement.sql.includes('INSERT INTO withdrawal_requests') && statement.values.includes('demo') && statement.values.includes(1))).toBe(true);

    const adminAuthorization = `Bearer ${await signedSession(secret, 77)}`;
    const review = await worker.fetch(new Request('https://dire-bet.test/api/admin/wallet/withdrawals/WD-simulation-test', {
      method:'PATCH', headers:{ Authorization:adminAuthorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:JSON.stringify({ status:'approved' }),
    }), walletEnv(statements, { simulated:true, admin:true }));
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ ok:true, status:'approved', simulationOnly:true });
    expect(statements.some((statement) => statement.sql.includes('UPDATE withdrawal_requests') && statement.values.includes('77'))).toBe(true);
  });

  it('keeps simulated requests closed when the simulation flag is off', async () => {
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:'{}',
    }), walletEnv([], {}));
    expect(response.status).toBe(403);
  });
  });
});

describe('free-play eligibility', () => {
  const env = (row: { status: string } | null) => ({ DB: {
    prepare: () => ({ bind: () => ({ first: async () => row }) }),
  } } as never);
  it('blocks missing and inactive accounts', async () => {
    expect(await freePlayEligibilityError(env(null), 1)).toContain('not eligible');
    expect(await freePlayEligibilityError(env({ status:'suspended' }), 1)).toContain('not eligible');
  });
  it('allows active accounts without an age review', async () => {
    expect(await freePlayEligibilityError(env({ status:'active' }), 1)).toBeNull();
  });
  it('does not apply an age gate to signed-in API routes', async () => {
    const secret = 'test-session-secret';
    const session = await signedSession(secret, 1);
    const response = await worker.fetch(new Request('https://dire-bet.test/api/rooms', {
      method:'POST', headers:{ Authorization:`Bearer ${session}`, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:'{}',
    }), { SESSION_SECRET:secret, DB:{ prepare: () => ({ bind: () => ({ first:async() => ({ user_id: 1 }) }) }) }, RATE_LIMITER: { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed:true }), { status:200 }) }) } } as never);
    expect(response.status).toBe(409);
    expect((await response.json() as { error:string }).error).toBe('This game cannot be played online.');
  });
});

describe('persistent sessions', () => {
  const secret = 'refresh-test-secret';
  const refreshToken = 'r'.repeat(32);

  it('rotates the refresh token and issues a fresh access token', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) { this.values = values; return this; },
          first: async () => sql.includes('FROM auth_sessions s') ? {
            id: 'session-old', user_id: 42, family_id: 'family-1',
            expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null,
            status: 'active', first_name: 'Existing', web_username: 'existing_user', language: 'en',
          } : null,
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        captured.push(statement);
        return statement;
      },
      batch: async (statements: { sql: string; values: unknown[] }[]) => { captured.push(...statements); return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }]; },
    };
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    }), { SESSION_SECRET: secret, DB: db } as never);
    expect(response.status).toBe(200);
    const data = await response.json() as { token: string; refreshToken: string; expiresIn: number; user: { displayName: string } };
    expect(data.token).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.refreshToken).not.toBe(refreshToken);
    expect(data.expiresIn).toBe(24 * 60 * 60);
    expect(data.user.displayName).toBe('existing_user');
    expect(captured.some((statement) => statement.sql.includes('UPDATE auth_sessions SET revoked_at'))).toBe(true);
    expect(captured.some((statement) => statement.sql.includes('INSERT INTO auth_sessions'))).toBe(true);
    expect(captured.find((statement) => statement.sql.includes('SELECT s.id'))?.values).toContain(await refreshHash(secret, refreshToken));
  });

  it('rejects a revoked refresh token', async () => {
    const db = { prepare: () => ({ bind: () => ({
      first: async () => ({ id: 'session-old', user_id: 42, family_id: 'family-1', expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: '2026-11-20T00:00:00Z', status: 'active', first_name: 'Existing', web_username: null, language: 'en' }),
    }) }) };
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    }), { SESSION_SECRET: secret, DB: db } as never);
    expect(response.status).toBe(401);
  });

  it('revokes the refresh token family on logout', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const db = { prepare: (sql: string) => {
      const statement = {
        sql,
        values: [] as unknown[],
        bind(...values: unknown[]) { this.values = values; return this; },
        first: async () => sql.includes('SELECT family_id FROM auth_sessions') ? { family_id: 'family-1' } : null,
        run: async () => { captured.push(statement); return { success: true, meta: { changes: 1 } }; },
      };
      return statement;
    } };
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/logout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    }), { SESSION_SECRET: secret, DB: db } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const update = captured.find((statement) => statement.sql.includes('UPDATE auth_sessions SET revoked_at'));
    expect(update).toBeTruthy();
    expect(update?.values).toContain('family-1');
  });

  it('removes the simulation age-review routes', async () => {
    const secret = 'removed-age-route-secret';
    const player = `Bearer ${await signedSession(secret, 1)}`;
    const admin = `Bearer ${await signedSession(secret, 7788)}`;
    const env = { SESSION_SECRET: secret, SUPER_ADMIN_TELEGRAM_ID: '7788', DB: { prepare: (sql: string) => ({ bind: () => ({ first: async () => sql.includes('SELECT telegram_id FROM users') ? { telegram_id: 7788 } : null }) }) } } as never;
    const submit = await worker.fetch(new Request('https://dire-bet.test/api/account/age-verification', {
      method: 'POST', headers: { Authorization: player, 'content-type': 'application/json' }, body: JSON.stringify({ confirmsAdult: true, verificationReference: 'ref' }),
    }), env);
    const list = await worker.fetch(new Request('https://dire-bet.test/api/admin/identity/age-requests', { headers: { Authorization: admin } }), env);
    const review = await worker.fetch(new Request('https://dire-bet.test/api/admin/identity/age-requests/1', {
      method: 'PATCH', headers: { Authorization: admin, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'verified', verifiedAge: 18 }),
    }), env);
    expect(submit.status).toBe(404);
    expect(list.status).toBe(404);
    expect(review.status).toBe(404);
  });
});

describe('Telegram /start contact prompt', () => {
  async function startKeyboard(hasContact: boolean) {
    const calls: Record<string, unknown>[] = [];
    const telegram = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 42, phone_shared: hasContact ? 1 : 0 }) }) }) };
    try {
      const response = await worker.fetch(new Request('https://dire-bet.test/telegram/webhook', {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret', 'content-type': 'application/json' },
        body: JSON.stringify({ message: { text: '/start', chat: { id: 99 }, from: { id: 123456789, first_name: 'Existing', language_code: 'en' } } }),
      }), { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: 'hook-secret', DB: db } as never);
      expect(response.status).toBe(200);
    } finally {
      telegram.mockRestore();
    }
    const call = calls.find((entry) => (entry.reply_markup as { keyboard?: unknown } | undefined)?.keyboard);
    expect(call).toBeTruthy();
    return call as { text: string; reply_markup: { keyboard: Array<Array<Record<string, unknown>>> } };
  }

  it('does not ask a registered user to share contact again', async () => {
    const call = await startKeyboard(true);
    const flat = call.reply_markup.keyboard.flat();
    expect(flat.some((button) => button.request_contact === true)).toBe(false);
    expect(call.text).toContain('menu below');
  });

  it('asks a new user to share contact only once during registration', async () => {
    const call = await startKeyboard(false);
    const flat = call.reply_markup.keyboard.flat();
    expect(flat.some((button) => button.request_contact === true)).toBe(true);
    expect(call.text).toContain('Optional web login');
  });
});

describe('Telegram setup recovery', () => {
  it('can refresh the bot webhook after setup has already run', async () => {
    const telegram = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = {
      SETUP_KEY: 'setup-key',
      TELEGRAM_BOT_TOKEN: 'saved-token',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      DB: { prepare: () => ({ run: async () => ({ success: true }) }) },
      ASSETS: { fetch: async () => new Response('') },
    } as never;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await worker.fetch(new Request('https://dire-bet.test/telegram/setup', {
          method: 'POST',
          headers: { Authorization: 'Bearer setup-key', 'Content-Type': 'application/json' },
          body: '{}',
        }), env);
        expect(response.status, `${await response.clone().text()} (${telegram.mock.calls.length} Telegram calls)`).toBe(200);
      }
      expect(telegram).toHaveBeenCalledTimes(8);
    } finally {
      telegram.mockRestore();
    }
  });
});

