import { describe, expect, it } from 'vitest';
import { parseTransactionSms } from '@dire-bet/shared';
import { verifyDepositTransaction } from './bank-verifier';
import worker from './index';

const secret = 'test-sms-deposit-secret';
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function sign(keyText: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(keyText), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

async function signedSession(userId: number): Promise<string> {
  const body = `${base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))}.${base64url(encoder.encode(JSON.stringify({ sub: String(userId), exp: Math.floor(Date.now() / 1000) + 3600 })))}`;
  return `${body}.${base64url(await sign(secret, body))}`;
}

describe('SMS parser (parseTransactionSms)', () => {
  it('extracts standard Telebirr English SMS', () => {
    const text = 'Dear customer, you have transferred ETB 250.00 to DIRE BET. Trans ID: FT2412345678 on 2026-11-22 18:30:00. Completed.';
    const parsed = parseTransactionSms(text, 'telebirr');
    expect(parsed?.amount).toBe(250);
    expect(parsed?.reference).toBe('FT2412345678');
    expect(parsed?.isCrediblePaymentSms).toBe(true);
  });

  it('extracts Amharic Telebirr SMS', () => {
    const parsed = parseTransactionSms('100.00 ብር ወደ 0911111111 ተላልፏል። የግብይት ቁጥር፡ FT8899001122 ተሳክቷል።', 'telebirr');
    expect(parsed?.amount).toBe(100);
    expect(parsed?.reference).toBe('FT8899001122');
  });

  it('rejects arbitrary text', () => {
    expect(parseTransactionSms('Hello how are you doing today')).toBeNull();
  });
});

describe('Bank Verifier (verifyDepositTransaction)', () => {
  function mockDb(existingRef = false) {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => existingRef && sql.includes('FROM deposit_requests WHERE provider = ? AND provider_reference = ?')
            ? { id: 'DP-EXISTING-1', status: 'approved' } : null,
        }),
      }),
    } as unknown as D1Database;
  }

  it('prevents duplicate reference', async () => {
    const outcome = await verifyDepositTransaction({ DB: mockDb(true) }, {
      provider: 'telebirr', reference: 'FTDUPLICATE01', expectedAmountSantim: 10000,
      extractedSms: parseTransactionSms('Trans ID: FTDUPLICATE01 ETB 100 completed', 'telebirr'),
      walletKind: 'demo', simulationOnly: true,
    });
    expect(outcome.duplicate).toBe(true);
  });

  it('flags amount mismatch as pending', async () => {
    const outcome = await verifyDepositTransaction({ DB: mockDb(false) }, {
      provider: 'telebirr', reference: 'FTVALID1234', expectedAmountSantim: 20000,
      extractedSms: parseTransactionSms('Trans ID: FTVALID1234 ETB 100.00 completed', 'telebirr'),
      walletKind: 'demo', simulationOnly: true,
    });
    expect(outcome.autoApprove).toBe(false);
    expect(outcome.status).toBe('pending');
  });
});

describe('Worker simplified wallet endpoints', () => {
  function makeMockEnv(captured: { sql: string; values: unknown[] }[], options: { existingRef?: boolean; existingSmsHash?: boolean; withdrawalEnabled?: boolean; withdrawalMin?: number } = {}) {
    const db = {
      prepare(sql: string) {
        const stmt = {
          sql,
          values: [] as unknown[],
          bind(...v: unknown[]) { this.values = v; return this; },
          first: async () => {
            if (sql.includes('FROM payment_settings')) return { account_number: '0911111111', enabled: options.withdrawalEnabled === false ? 0 : 1, minimum_santim: 5000, maximum_santim: 1_000_000, withdrawal_minimum_santim: options.withdrawalMin ?? 10000, withdrawal_maximum_santim: 1_000_000 };
            if (sql.includes('SELECT u.status, p.age_eligibility')) return { status: 'active', age_eligibility: 'verified' };
            if (sql.includes('FROM deposit_requests WHERE idempotency_key = ?')) return null;
            if (sql.includes('FROM withdrawal_requests WHERE idempotency_key = ?')) return null;
            if (sql.includes('FROM deposit_requests WHERE sms_sha256 = ?')) return options.existingSmsHash ? { id: 'DP-SMS-OLD' } : null;
            if (sql.includes('FROM deposit_requests WHERE provider = ? AND provider_reference = ?')) return options.existingRef ? { id: 'DP-OLD', status: 'approved' } : null;
            return null;
          },
          run: async () => { captured.push(stmt); return { success: true, meta: { changes: 1 } }; },
        };
        return stmt;
      },
      batch: async (statements: { sql: string; values: unknown[] }[]) => { captured.push(...statements); return []; },
    };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }) };
    return { DB: db, SESSION_SECRET: secret, REAL_MONEY_ENABLED: 'false', DEMO_MODE: 'false', SIMULATED_WALLET_ENABLED: 'true', RATE_LIMITER: rateLimiter } as never;
  }

  it('accepts deposit without sender phone/reference and stores raw SMS', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured);
    const auth = `Bearer ${await signedSession(42)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telebirr', amount: 100, confirmationSms: 'this is an unparsed sms payment note but valid length', idempotencyKey: 'deposit-no-ref-test-01' }),
    }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as { status: string };
    expect(body.status).toBe('pending');
    const insert = captured.find((s) => s.sql.includes('INSERT INTO deposit_requests'));
    expect(insert).toBeTruthy();
    expect(insert?.sql).toContain('sms_sha256');
  });

  it('accepts unparseable SMS as pending manual review', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured);
    const auth = `Bearer ${await signedSession(7)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'ebirr', amount: 50, confirmationSms: 'Payment message without normal refs 12345', idempotencyKey: 'deposit-unparsed-test-01' }),
    }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as { status: string; autoApproved: boolean };
    expect(body.status).toBe('pending');
    expect(body.autoApproved).toBe(false);
  });

  it('rejects duplicate SMS', async () => {
    const env = makeMockEnv([], { existingSmsHash: true });
    const auth = `Bearer ${await signedSession(42)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telebirr', amount: 100, confirmationSms: 'Dear customer ETB 100 Trans ID: FT12345678 Completed', idempotencyKey: 'deposit-dupe-sms-test-01' }),
    }), env);
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('sms');
  });

  it('accepts withdrawal without account holder name', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured);
    const auth = `Bearer ${await signedSession(42)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/withdrawals', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telebirr', amount: 100, destinationPhone: '0912345678', idempotencyKey: 'withdrawal-no-name-test-01' }),
    }), env);
    expect(response.status).toBe(201);
    const insert = captured.find((s) => s.sql.includes('INSERT INTO withdrawal_requests'));
    expect(insert).toBeTruthy();
  });

  it('rejects invalid withdrawal phone', async () => {
    const env = makeMockEnv([]);
    const auth = `Bearer ${await signedSession(42)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/withdrawals', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telebirr', amount: 100, destinationPhone: '12345', idempotencyKey: 'withdrawal-bad-phone-test-01' }),
    }), env);
    expect(response.status).toBe(400);
  });

  it('rejects below-minimum withdrawal', async () => {
    const env = makeMockEnv([], { withdrawalMin: 10000 });
    const auth = `Bearer ${await signedSession(42)}`;
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/withdrawals', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'telebirr', amount: 50, destinationPhone: '0912345678', idempotencyKey: 'withdrawal-low-test-01' }),
    }), env);
    expect(response.status).toBe(400);
  });
});
