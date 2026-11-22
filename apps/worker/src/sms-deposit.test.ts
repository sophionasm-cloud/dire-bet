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
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(250);
    expect(parsed?.amountSantim).toBe(25000);
    expect(parsed?.reference).toBe('FT2412345678');
    expect(parsed?.provider).toBe('telebirr');
    expect(parsed?.status).toBe('successful');
    expect(parsed?.isCrediblePaymentSms).toBe(true);
  });

  it('extracts Amharic Telebirr SMS with Ethiopic punctuation', () => {
    const text = '100.00 ብር ወደ 0911111111 ተላልፏል። የግብይት ቁጥር፡ FT8899001122 ተሳክቷል።';
    const parsed = parseTransactionSms(text, 'telebirr');
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(100);
    expect(parsed?.reference).toBe('FT8899001122');
    expect(parsed?.status).toBe('successful');
    expect(parsed?.isCrediblePaymentSms).toBe(true);
  });

  it('extracts CBE Commercial Bank of Ethiopia SMS', () => {
    const text = 'Dear Customer, ETB 500.00 debited from your account on 22/11/2026. Ref: FT9988776655. Successful.';
    const parsed = parseTransactionSms(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(500);
    expect(parsed?.reference).toBe('FT9988776655');
    expect(parsed?.provider).toBe('cbe');
    expect(parsed?.status).toBe('successful');
    expect(parsed?.isCrediblePaymentSms).toBe(true);
  });

  it('extracts eBirr SMS', () => {
    const text = 'You have paid 150 Birr to Dire Bet. Trx ID: EB98765432. Status: Completed.';
    const parsed = parseTransactionSms(text, 'ebirr');
    expect(parsed).not.toBeNull();
    expect(parsed?.amount).toBe(150);
    expect(parsed?.reference).toBe('EB98765432');
    expect(parsed?.provider).toBe('ebirr');
    expect(parsed?.status).toBe('successful');
    expect(parsed?.isCrediblePaymentSms).toBe(true);
  });

  it('rejects failed or reversed transactions', () => {
    const text = 'Dear customer, transfer of ETB 100.00 failed. Trans ID: FT11223344. Reversed.';
    const parsed = parseTransactionSms(text, 'telebirr');
    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('failed');
    expect(parsed?.isCrediblePaymentSms).toBe(false);
  });

  it('rejects arbitrary or non-payment text', () => {
    expect(parseTransactionSms('Hello how are you doing today')).toBeNull();
    expect(parseTransactionSms('Payment received successfully')).toBeNull();
  });
});

describe('Bank Verifier (verifyDepositTransaction)', () => {
  function mockDb(existingRef: boolean = false) {
    return {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => existingRef && sql.includes('FROM deposit_requests WHERE provider = ? AND provider_reference = ?')
            ? { id: 'DP-EXISTING-1', status: 'approved' }
            : null,
        }),
      }),
    } as unknown as D1Database;
  }

  it('prevents duplicate transactions with same reference', async () => {
    const db = mockDb(true);
    const outcome = await verifyDepositTransaction({ DB: db }, {
      provider: 'telebirr',
      reference: 'FTDUPLICATE01',
      expectedAmountSantim: 10000,
      extractedSms: parseTransactionSms('Trans ID: FTDUPLICATE01 ETB 100 completed', 'telebirr'),
      walletKind: 'real',
      simulationOnly: false,
    });
    expect(outcome.duplicate).toBe(true);
    expect(outcome.autoApprove).toBe(false);
    expect(outcome.status).toBe('pending');
  });

  it('detects amount mismatch and keeps pending for admin review', async () => {
    const db = mockDb(false);
    const outcome = await verifyDepositTransaction({ DB: db }, {
      provider: 'telebirr',
      reference: 'FTVALID1234',
      expectedAmountSantim: 20000, // Expected 200 ETB
      extractedSms: parseTransactionSms('Trans ID: FTVALID1234 ETB 100.00 completed', 'telebirr'), // SMS says 100 ETB
      walletKind: 'demo',
      simulationOnly: true,
    });
    expect(outcome.autoApprove).toBe(false);
    expect(outcome.status).toBe('pending');
    expect(outcome.reason).toContain('does not match requested amount');
  });

  it('auto-approves in simulated / demo mode for valid SMS', async () => {
    const db = mockDb(false);
    const outcome = await verifyDepositTransaction({ DB: db, SIMULATED_WALLET_ENABLED: 'true' }, {
      provider: 'telebirr',
      reference: 'FTSIM001',
      expectedAmountSantim: 10000,
      extractedSms: parseTransactionSms('Dear customer, you have transferred ETB 100.00. Trans ID: FTSIM001. Completed.', 'telebirr'),
      walletKind: 'demo',
      simulationOnly: true,
    });
    expect(outcome.autoApprove).toBe(true);
    expect(outcome.status).toBe('approved');
  });

  it('keeps real money deposit pending for admin review when external bank API is unconfigured', async () => {
    const db = mockDb(false);
    const outcome = await verifyDepositTransaction({ DB: db, REAL_MONEY_ENABLED: 'true' }, {
      provider: 'telebirr',
      reference: 'FTREAL001',
      expectedAmountSantim: 10000,
      extractedSms: parseTransactionSms('Dear customer, you have transferred ETB 100.00. Trans ID: FTREAL001. Completed.', 'telebirr'),
      walletKind: 'real',
      simulationOnly: false,
    });
    expect(outcome.autoApprove).toBe(false);
    expect(outcome.status).toBe('pending');
    expect(outcome.reason).toContain('Authoritative bank verification integration unavailable');
  });
});

describe('Worker automatic deposit endpoint (/api/wallet/deposits)', () => {
  function makeMockEnv(captured: { sql: string; values: unknown[] }[], options: { simulated?: boolean; existingRef?: boolean } = {}) {
    const db = {
      prepare(sql: string) {
        const stmt = {
          sql,
          values: [] as unknown[],
          bind(...v: unknown[]) { this.values = v; return this; },
          first: async () => {
            if (sql.includes('FROM payment_settings')) return { account_number: '0911111111', enabled: 1, minimum_santim: 5000, maximum_santim: 1_000_000 };
            if (sql.includes('SELECT u.status, p.age_eligibility')) return { status: 'active', age_eligibility: 'verified' };
            if (sql.includes('FROM deposit_requests WHERE idempotency_key = ?')) return null;
            if (sql.includes('FROM deposit_requests WHERE provider = ? AND provider_reference = ?')) {
              return options.existingRef ? { id: 'DP-OLD', status: 'approved' } : null;
            }
            return null;
          },
          run: async () => { captured.push(stmt); return { success: true }; },
        };
        return stmt;
      },
      batch: async (statements: { sql: string; values: unknown[] }[]) => {
        captured.push(...statements);
        return [];
      },
    };
    const rateLimiter = { idFromName: (id: string) => id, get: () => ({ fetch: async () => new Response(JSON.stringify({ allowed: true }), { status: 200 }) }) };
    return {
      DB: db,
      SESSION_SECRET: secret,
      REAL_MONEY_ENABLED: 'false',
      DEMO_MODE: 'false',
      SIMULATED_WALLET_ENABLED: options.simulated ? 'true' : 'false',
      RATE_LIMITER: rateLimiter,
    } as never;
  }

  it('submits genuine SMS, auto-approves, and enqueues update statement to trigger wallet credit', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured, { simulated: true });
    const auth = `Bearer ${await signedSession(42)}`;

    const smsText = 'Dear customer, you have transferred ETB 100.00 to DIRE BET. Trans ID: FT99887766 on 2026-11-22 18:30:00. Completed.';
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'telebirr',
        amount: 100,
        senderPhone: '0912345678',
        transactionReference: 'FT99887766',
        proofMethod: 'sms',
        confirmationSms: smsText,
        idempotencyKey: 'test-auto-deposit-01',
      }),
    }), env);

    expect(response.status).toBe(201);
    const body = await response.json() as { status: string; autoApproved: boolean; verified: boolean };
    expect(body.status).toBe('approved');
    expect(body.autoApproved).toBe(true);

    // Verify batch included both the initial pending insert and the update to approved (which fires the D1 credit trigger)
    expect(captured.some((s) => s.sql.includes('INSERT INTO deposit_requests'))).toBe(true);
    expect(captured.some((s) => s.sql.includes('UPDATE deposit_requests SET status = \'approved\''))).toBe(true);
    expect(captured.some((s) => s.sql.includes("status = 'approved'") && s.sql.includes('system:auto-verified'))).toBe(true);
  });

  it('rejects duplicate transaction reference with HTTP 409', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured, { simulated: true, existingRef: true });
    const auth = `Bearer ${await signedSession(42)}`;

    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'telebirr',
        amount: 100,
        senderPhone: '0912345678',
        transactionReference: 'FTDUPE123',
        proofMethod: 'sms',
        confirmationSms: 'Trans ID: FTDUPE123 ETB 100 completed',
        idempotencyKey: 'test-dupe-ref-01',
      }),
    }), env);

    expect(response.status).toBe(409);
    const body = await response.json() as { error: string };
    expect(body.error).toContain('already submitted');
  });

  it('keeps deposit pending for admin review when SMS amount mismatches requested amount', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured, { simulated: true });
    const auth = `Bearer ${await signedSession(42)}`;

    const smsText = 'Dear customer, you have transferred ETB 50.00 to DIRE BET. Trans ID: FTMISMATCH01. Completed.';
    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/deposits', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'telebirr',
        amount: 100, // Requested 100, but SMS says 50
        senderPhone: '0912345678',
        transactionReference: 'FTMISMATCH01',
        proofMethod: 'sms',
        confirmationSms: smsText,
        idempotencyKey: 'test-mismatch-01',
      }),
    }), env);

    expect(response.status).toBe(201);
    const body = await response.json() as { status: string; autoApproved: boolean };
    expect(body.status).toBe('pending');
    expect(body.autoApproved).toBe(false);

    // Should only have INSERT INTO deposit_requests (pending), NOT the update to approved
    expect(captured.some((s) => s.sql.includes('INSERT INTO deposit_requests'))).toBe(true);
    expect(captured.some((s) => s.sql.includes('UPDATE deposit_requests SET status = \'approved\''))).toBe(false);
  });

  it('ensures withdrawals are NEVER automatically approved (manual admin review only)', async () => {
    const captured: { sql: string; values: unknown[] }[] = [];
    const env = makeMockEnv(captured, { simulated: true });
    const auth = `Bearer ${await signedSession(42)}`;

    const response = await worker.fetch(new Request('https://dire-bet.test/api/wallet/withdrawals', {
      method: 'POST',
      headers: { Authorization: auth, Origin: 'https://dire-bet.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'telebirr',
        amount: 100,
        destinationPhone: '0912345678',
        accountHolderName: 'Abebe Bikila',
        idempotencyKey: 'test-withdrawal-manual-01',
      }),
    }), env);

    expect(response.status).toBe(201);
    const body = await response.json() as { status: string };
    expect(body.status).toBe('pending');
    // Ensure no automatic approval happened
    expect(captured.some((s) => s.sql.includes('UPDATE withdrawal_requests SET status = \'approved\''))).toBe(false);
  });
});
