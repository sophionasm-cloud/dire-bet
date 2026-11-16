export type DemoDepositStatus = 'pending' | 'approved' | 'declined';
export type DemoDepositRequest = {
  id: string;
  amount: number;
  receiptName: string;
  receiptData: string;
  smsReference: string;
  status: DemoDepositStatus;
  createdAt: string;
};

export const DEMO_DEPOSITS_KEY = 'direbet.demoDepositRequests.v1';
export const DEMO_ADMIN_KEY = 'direbet.demoAdmin.v1';

export function readDemoDeposits(): DemoDepositRequest[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEMO_DEPOSITS_KEY) || '[]') as DemoDepositRequest[];
    return Array.isArray(parsed) ? parsed.filter(isDemoDeposit) : [];
  } catch { return []; }
}

export function writeDemoDeposits(requests: DemoDepositRequest[]): void {
  localStorage.setItem(DEMO_DEPOSITS_KEY, JSON.stringify(requests.slice(0, 10)));
}

export function generateDemoPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*?';
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const output: string[] = [];
  while (output.length < 22) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) if (byte < limit && output.length < 22) output.push(alphabet[byte % alphabet.length]);
  }
  return output.join('');
}

export async function demoPasswordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 310_000 }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function isDemoDeposit(value: unknown): value is DemoDepositRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DemoDepositRequest>;
  return typeof request.id === 'string' && Number.isInteger(request.amount) && typeof request.receiptName === 'string'
    && typeof request.receiptData === 'string' && typeof request.smsReference === 'string'
    && (request.status === 'pending' || request.status === 'approved' || request.status === 'declined')
    && typeof request.createdAt === 'string';
}
