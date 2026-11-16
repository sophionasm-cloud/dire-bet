import { describe, expect, it, vi } from 'vitest';
import worker, { moneyActivationRecorded, validateInitData } from './index';

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

describe('real-money activation gate', () => {
  const evidence = { counselApproval:'signed', providerApprovals:['merchant'], telegramApproval:'written', licenseReferences:['ref'], minimumAge:18, ownerSignedAt:'2026-11-15' };
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
