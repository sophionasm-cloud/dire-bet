export type ActivationEnv = { DB: D1Database; REAL_MONEY_ENABLED: string; DEMO_MODE: string };

export async function freePlayEligibilityError(env: Pick<ActivationEnv, 'DB'>, userId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT status FROM users WHERE id = ?').bind(userId).first<{ status: string }>();
  if (!row || row.status !== 'active') return 'Your account is not eligible to use DIRE BET.';
  return null;
}

export async function moneyActivationRecorded(env: ActivationEnv): Promise<boolean> {
  if (env.REAL_MONEY_ENABLED !== 'true' || env.DEMO_MODE !== 'false') return false;
  try {
    const record = await env.DB.prepare('SELECT id, evidence_json, minimum_age FROM activation_records ORDER BY approved_at DESC, id DESC LIMIT 1').first<{ id: string; evidence_json: string; minimum_age: number }>();
    if (!record || !Number.isInteger(record.minimum_age) || record.minimum_age < 18) return false;
    const audit = await env.DB.prepare("SELECT id FROM audit_logs WHERE action = 'REAL_MONEY_ACTIVATION_RECORDED' AND entity_type = 'activation_record' AND entity_id = ? LIMIT 1").bind(record.id).first();
    if (!audit) return false;
    const evidence = JSON.parse(record.evidence_json) as Record<string, unknown>;
    const references = [evidence.counselApproval, evidence.licenseReview, evidence.telegramApproval, evidence.nationalBankReview,
      evidence.ageVerificationMethod, evidence.responsiblePlayPolicy, evidence.privacyReview];
    const providers = evidence.providerApprovals as Record<string, unknown> | null;
    return references.every((value) => typeof value === 'string' && value.trim().length >= 3)
      && Array.isArray(evidence.licenseReferences) && evidence.licenseReferences.length > 0 && evidence.licenseReferences.every((value) => typeof value === 'string' && value.trim().length >= 3)
      && typeof providers?.telebirr === 'string' && providers.telebirr.trim().length >= 3
      && typeof providers?.ebirr === 'string' && providers.ebirr.trim().length >= 3
      && Number.isInteger(evidence.minimumAge) && (evidence.minimumAge as number) >= 18 && evidence.minimumAge === record.minimum_age
      && typeof evidence.ownerSignedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(evidence.ownerSignedAt);
  } catch { return false; }
}

export async function moneyEligibilityError(env: Pick<ActivationEnv, 'DB'>, userId: number): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT u.status, p.age_eligibility,
    CASE WHEN p.self_excluded_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS self_excluded,
    CASE WHEN p.cooling_off_until > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS cooling_off
    FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = ?`).bind(userId).first<{
      status: string; age_eligibility: string | null; self_excluded: number; cooling_off: number;
    }>();
  if (!row || row.status !== 'active') return 'Your account is not eligible for money features.';
  if (row.age_eligibility !== 'verified') return 'Complete an approved 18+ age check before using money features.';
  if (row.self_excluded || row.cooling_off) return 'Money features are unavailable during your break.';
  return null;
}
