import { describe, expect, it, vi } from 'vitest';
import worker, { moneyActivationRecorded, validateInitData } from './index';
import { ageEligibilityError } from './activation';
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
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => {
      statements.push(sql);
      if (sql.includes('INSERT INTO users (telegram_id')) return { id: 42 };
      if (sql.includes('SELECT id, first_name, web_username, language')) return { id: 42, first_name: 'Existing', web_username: 'existing_user', language: 'am', age_eligibility: 'verified', age_review_pending: 0, phone_shared: 1 };
      return null;
    } }) }) };
    const env = { TELEGRAM_BOT_TOKEN: token, SESSION_SECRET: 'session-secret', DB: db } as never;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: await initData(Math.floor(Date.now() / 1000)) }),
    }), env);
    expect(response.status).toBe(200);
    const data = await response.json() as { token: string };
    expect(statements.filter((sql) => sql.includes('INSERT INTO users (telegram_id'))).toHaveLength(1);
    expect(statements[0]).toContain('ON CONFLICT(telegram_id) DO UPDATE');
    const profile = await worker.fetch(new Request('https://dire-bet.test/api/me', { headers: { Authorization: `Bearer ${data.token}` } }), env);
    expect(profile.status).toBe(200);
    expect((await profile.json() as { user: { displayName: string; phoneShared: boolean } }).user).toMatchObject({ displayName: 'existing_user', phoneShared: true });
  });

  it('keeps the regular browser username and PIN login working', async () => {
    const secret = 'browser-session-secret';
    const salt = 'AAECAwQFBgcICQoLDA0ODw';
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 7, first_name: 'Browser', web_username: 'browser_user', password_salt: salt, password_hash: await passwordHash('12345678', salt, secret) }) }) }) };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }) };
    const response = await worker.fetch(new Request('https://dire-bet.test/api/auth/password', {
      method: 'POST', headers: { Origin: 'https://dire-bet.test', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'browser_user', password: '12345678' }),
    }), { SESSION_SECRET: secret, DB: db, RATE_LIMITER: rateLimiter } as never);
    expect(response.status).toBe(200);
    expect((await response.json() as { token: string; user: { displayName: string } })).toMatchObject({ user: { displayName: 'browser_user' } });
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
      if (sql.includes('LEFT JOIN user_profiles')) return { status: 'active', age_eligibility: 'verified' };
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

  function walletEnv(captured: { sql: string; values: unknown[] }[], options: { activated?: boolean; referredAge?: string | null } = {}) {
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
            if (sql.includes('FROM payment_settings')) return { account_number:'0911111111', enabled:1, minimum_santim:5000, maximum_santim:1_000_000 };
            if (sql.includes('FROM agents WHERE referral_code')) return { id:'agent-1', user_id:2 };
            if (sql.includes('SELECT source_code FROM referrals')) return null;
            if (sql.includes('SELECT p.age_eligibility')) return { age_eligibility:options.referredAge || 'unverified', credited:0 };
            return null;
          },
          all: async () => ({ results:[] }),
          run: async () => ({ success:true, meta:{ changes:1 } }),
        };
        return statement;
      },
      batch: async (statements: { sql: string; values: unknown[] }[]) => { captured.push(...statements); return []; },
    };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed:true }), { status:200 }) }) };
    return { DB:db, SESSION_SECRET:secret, REAL_MONEY_ENABLED:options.activated ? 'true' : 'false', DEMO_MODE:'false', RATE_LIMITER:rateLimiter } as never;
  }

  async function deposit(body: Record<string, unknown>, captured: { sql: string; values: unknown[] }[]) {
    const authorization = `Bearer ${await signedSession(secret, 71)}`;
    return worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method:'POST', headers:{ Authorization:authorization, Origin:'https://dire-bet.test', 'Content-Type':'application/json' }, body:JSON.stringify(body),
    }), walletEnv(captured, { activated:true }));
  }

  it('saves an SMS-only deposit proof and rejects a submission with both proof types', async () => {
    const input = { provider:'telebirr', amount:100, senderPhone:'0912345678', transactionReference:'PAY12345', proofMethod:'sms', confirmationSms:'Payment received successfully', idempotencyKey:'deposit-sms-test-0001' };
    const stored: { sql: string; values: unknown[] }[] = [];
    const accepted = await deposit(input, stored);
    expect(accepted.status).toBe(201);
    expect(stored.some((statement) => statement.sql.includes('confirmation_sms_ciphertext'))).toBe(true);
    expect(stored.some((statement) => statement.sql.includes('INSERT INTO receipt_blobs'))).toBe(false);

    const rejectedStatements: { sql: string; values: unknown[] }[] = [];
    const both = await deposit({ ...input, receiptData:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dZ8AAAAASUVORK5CYII=' }, rejectedStatements);
    expect(both.status).toBe(400);
    expect(rejectedStatements).toHaveLength(0);
  });

  it('links a referral and leaves its 10 Birr credit pending until age approval', async () => {
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
});

describe('adult access gate', () => {
  const env = (row: { status: string; age_eligibility: string | null } | null) => ({ DB: {
    prepare: () => ({ bind: () => ({ first: async () => row }) }),
  } } as never);
  it('blocks missing, unverified and inactive accounts', async () => {
    expect(await ageEligibilityError(env(null), 1)).toContain('not eligible');
    expect(await ageEligibilityError(env({ status:'active', age_eligibility:'unverified' }), 1)).toContain('18+');
    expect(await ageEligibilityError(env({ status:'suspended', age_eligibility:'verified' }), 1)).toContain('not eligible');
  });
  it('allows active accounts after admin age approval', async () => {
    expect(await ageEligibilityError(env({ status:'active', age_eligibility:'verified' }), 1)).toBeNull();
  });
  it('blocks unverified signed-in players from protected API routes', async () => {
    const secret = 'test-session-secret';
    const body = `${base64url(encoder.encode(JSON.stringify({ alg:'HS256', typ:'JWT' })))}.${base64url(encoder.encode(JSON.stringify({ sub:'1', exp:Math.floor(Date.now()/1000)+60 })))}`;
    const session = `${body}.${base64url(await sign(secret, body))}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/rooms', {
      method:'POST', headers:{ Authorization:`Bearer ${session}`, 'Content-Type':'application/json' }, body:'{}',
    }), { SESSION_SECRET:secret, DB:{ prepare:() => ({ bind:() => ({ first:async() => ({ status:'active', age_eligibility:'unverified' }) }) }) } } as never);
    expect(response.status).toBe(403);
    expect((await response.json() as { error:string }).error).toContain('18+');
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
