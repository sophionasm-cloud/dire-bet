import type { ExtractedSmsData } from '@dire-bet/shared';

export type PaymentProvider = 'telebirr' | 'ebirr';

export type BankVerifyEnv = {
  DB: D1Database;
  SESSION_SECRET?: string;
  BANK_VERIFICATION_API_URL?: string;
  BANK_VERIFICATION_API_KEY?: string;
  TELEBIRR_VERIFY_KEY?: string;
  SIMULATED_WALLET_ENABLED?: string;
  REAL_MONEY_ENABLED?: string;
  DEMO_MODE?: string;
};

export type BankVerifyInput = {
  provider: PaymentProvider;
  reference: string;
  expectedAmountSantim: number;
  extractedSms: ExtractedSmsData | null;
  walletKind: 'real' | 'demo';
  simulationOnly: boolean;
};

export type BankVerifyOutcome = {
  verified: boolean;
  autoApprove: boolean;
  status: 'approved' | 'pending';
  reason: string;
  duplicate?: boolean;
  error?: string;
};

/**
 * Verifies a deposit transaction against duplicate checks, extracted SMS details,
 * and an authoritative bank/payment verification source.
 */
export async function verifyDepositTransaction(
  env: BankVerifyEnv,
  input: BankVerifyInput
): Promise<BankVerifyOutcome> {
  const { provider, reference, expectedAmountSantim, extractedSms, walletKind, simulationOnly } = input;

  // 1. Prevent duplicate transactions using the transaction/reference ID
  const existing = await env.DB.prepare(
    'SELECT id, status FROM deposit_requests WHERE provider = ? AND provider_reference = ?'
  ).bind(provider, reference).first<{ id: string; status: string }>();

  if (existing) {
    return {
      verified: false,
      autoApprove: false,
      status: 'pending',
      duplicate: true,
      error: 'That transaction reference was already submitted.',
      reason: `Duplicate reference: ${reference} was already used in request ${existing.id}`,
    };
  }

  // 2. Check if the SMS was parseable and credible
  if (!extractedSms || !extractedSms.isCrediblePaymentSms) {
    return {
      verified: false,
      autoApprove: false,
      status: 'pending',
      reason: 'SMS text could not be verified as a valid payment confirmation; queued for manual admin review.',
    };
  }

  // 3. Check transaction status in SMS
  if (extractedSms.status === 'failed') {
    return {
      verified: false,
      autoApprove: false,
      status: 'pending',
      reason: 'Transaction status in SMS indicates failed/reversed; queued for manual admin review.',
    };
  }

  // 4. Check that the transaction amount matches the requested deposit
  if (extractedSms.amountSantim !== null && extractedSms.amountSantim !== expectedAmountSantim) {
    return {
      verified: false,
      autoApprove: false,
      status: 'pending',
      reason: `SMS amount (${(extractedSms.amountSantim / 100).toFixed(2)} ETB) does not match requested amount (${(expectedAmountSantim / 100).toFixed(2)} ETB); queued for manual admin review.`,
    };
  }

  // 5. Authoritative verification source check
  if (env.BANK_VERIFICATION_API_URL) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(env.BANK_VERIFICATION_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.BANK_VERIFICATION_API_KEY ? { Authorization: `Bearer ${env.BANK_VERIFICATION_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          provider,
          reference,
          amount: expectedAmountSantim / 100,
          amountSantim: expectedAmountSantim,
          timestamp: extractedSms.dateTime,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json().catch(() => null) as { verified?: boolean; settled?: boolean; error?: string } | null;
        if (data && data.verified === true && data.settled !== false) {
          return {
            verified: true,
            autoApprove: true,
            status: 'approved',
            reason: `Automatically verified via authoritative ${provider} gateway: ${reference}`,
          };
        }
      }
      return {
        verified: false,
        autoApprove: false,
        status: 'pending',
        reason: 'Bank verification service returned unconfirmed status; queued for manual admin review.',
      };
    } catch {
      return {
        verified: false,
        autoApprove: false,
        status: 'pending',
        reason: 'Bank verification gateway timed out or unreachable; queued for manual admin review.',
      };
    }
  }

  // 6. When external bank verification integration is unavailable:
  // For simulated / demo wallet, we auto-verify credible SMS messages so testing & demo mode work smoothly.
  if (walletKind === 'demo' || simulationOnly || env.SIMULATED_WALLET_ENABLED === 'true') {
    return {
      verified: true,
      autoApprove: true,
      status: 'approved',
      reason: `Auto-verified via ${provider} transaction reference: ${reference}`,
    };
  }

  // For live real money, per requirement:
  // "Do not trust SMS text alone as proof of payment; verify transactions through an authoritative bank/payment source.
  // If bank verification integration is unavailable, keep the deposit pending for admin review rather than pretending verification succeeded."
  return {
    verified: false,
    autoApprove: false,
    status: 'pending',
    reason: 'Authoritative bank verification integration unavailable; queued for manual admin review.',
  };
}
