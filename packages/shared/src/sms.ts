export type ExtractedSmsData = {
  raw: string;
  amount: number | null;
  amountSantim: number | null;
  reference: string | null;
  dateTime: string | null;
  status: 'successful' | 'completed' | 'failed' | 'unknown';
  provider: 'telebirr' | 'ebirr' | 'cbe' | 'bank' | null;
  senderPhone: string | null;
  receiverAccount: string | null;
  isCrediblePaymentSms: boolean;
};

export function parseTransactionSms(smsText: unknown, providerHint?: string | null): ExtractedSmsData | null {
  if (typeof smsText !== 'string') return null;
  const text = smsText.trim();
  if (text.length < 8) return null;

  const lower = text.toLowerCase();

  // 1. Initial Provider detection from keywords
  let provider: 'telebirr' | 'ebirr' | 'cbe' | 'bank' | null = null;
  if (lower.includes('telebirr') || text.includes('ቴሌብር')) provider = 'telebirr';
  else if (lower.includes('ebirr') || text.includes('ኢ-ብር') || text.includes('ኢብር')) provider = 'ebirr';
  else if (lower.includes('cbe') || text.includes('ንግድ ባንክ') || lower.includes('commercial bank')) provider = 'cbe';
  else if (lower.includes('abyssinia') || text.includes('አቢሲንያ') || lower.includes('awash') || text.includes('አዋሽ') || lower.includes('dashen') || text.includes('ዳሸን')) provider = 'bank';
  else if (providerHint === 'telebirr' || providerHint === 'ebirr') provider = providerHint;

  // 2. Reference extraction (supporting English and Ethiopic punctuation)
  let reference: string | null = null;
  const refPatterns = [
    /(?:transaction\s*id|trans(?:\.|\s*)id|txn\s*id|trx\s*id|ref(?:\.|\s*no|\s*number)?|የግብይት\s*ቁጥር|የትራንዛክሽን\s*ቁጥር|ማጣቀሻ(?:\s*ቁጥር)?|የማጣቀሻ\s*ቁጥር)[፡:\s]+([A-Za-z0-9_/-]{5,36})/i,
    /\b(FT\d{8,16})\b/i,
    /\b(EB[A-Za-z0-9]{6,16})\b/i,
    /\b([A-Z0-9]{10})\b/
  ];
  for (const pat of refPatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(candidate) && candidate.length >= 5) {
        reference = candidate;
        break;
      }
    }
  }

  // If reference starts with CBE standard FT and no provider detected yet
  if (!provider && reference && /^FT\d+/i.test(reference)) {
    provider = 'cbe';
  }

  // 3. Amount extraction (excluding embedded numbers inside tokens, balances, or phone numbers)
  let amount: number | null = null;
  const amountPatterns = [
    /(?:transferred|paid|debited|sent|credited)[፡:\s]*(?:etb|birr|ብር)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
    /(?:amount|መጠን)[፡:\s]+(?:etb|birr|ብር)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
    /(?:^|[^\w.])([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ብር|etb|birr)\s*(?:ወደ|ተላልፏል|ተከፍሏል|ተቀንሷል|አስተላልፈዋል)/i,
    /(?:etb|birr|ብር)[፡:\s]*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:transferred|paid|debited|sent|credited|ወደ)/i,
    /(?:^|[^\w.])([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ብር|etb|birr)\b/i,
    /\b(?:etb|birr|ብር)[፡:\s]*([0-9,]+(?:\.[0-9]{1,2})?)\b/i,
  ];
  for (const pat of amountPatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      const cleanNum = m[1].replace(/,/g, '');
      const val = parseFloat(cleanNum);
      if (Number.isFinite(val) && val > 0 && val < 5_000_000 && !/^09\d{8}$/.test(cleanNum) && !/^251\d{9}$/.test(cleanNum)) {
        amount = val;
        break;
      }
    }
  }

  // If text has neither reference nor amount, it is not an SMS payment notification
  if (!amount && !reference) {
    return null;
  }

  // 4. Date and Time extraction
  let dateTime: string | null = null;
  const datePatterns = [
    /(?:on|at|date|ቀን)[፡:\s]*([0-9]{1,4}[-/][0-9]{1,2}[-/][0-9]{1,4}(?:\s+[0-9]{1,2}:[0-9]{1,2}(?::[0-9]{1,2})?)?)/i,
    /\b(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:[0-9]{1,2}(?::\d{1,2})?)?)\b/,
    /\b(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)\b/,
    /\b(\d{1,2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}(?:\s+\d{1,2}:\d{1,2}(?::\d{1,2})?)?)\b/i
  ];
  for (const pat of datePatterns) {
    const m = text.match(pat);
    if (m && m[1]) { dateTime = m[1].trim(); break; }
  }

  // 5. Phone / Account information
  let senderPhone: string | null = null;
  const senderMatch = text.match(/(?:from|የላኪ(?:\s*ቁጥር)?)[፡:\s]+([0-9+]{9,15})/i);
  if (senderMatch && senderMatch[1]) senderPhone = senderMatch[1].trim();

  let receiverAccount: string | null = null;
  const receiverMatch = text.match(/(?:to|ወደ)[፡:\s]+(?:account\s*)?([0-9+]{9,16})/i);
  if (receiverMatch && receiverMatch[1]) receiverAccount = receiverMatch[1].trim();

  // 6. Status detection
  let status: 'successful' | 'completed' | 'failed' | 'unknown' = 'unknown';
  const failWords = ['failed', 'unsuccessful', 'cancelled', 'reversed', 'አልተሳካም', 'ውድቅ'];
  const successWords = ['success', 'successful', 'completed', 'transferred', 'debited', 'credited', 'paid', 'ተሳክቷል', 'ተጠናቋል', 'ተከናውኗል', 'አስተላልፈዋል'];
  if (failWords.some((w) => lower.includes(w) || text.includes(w))) {
    status = 'failed';
  } else if (successWords.some((w) => lower.includes(w) || text.includes(w))) {
    status = 'successful';
  }

  const isCrediblePaymentSms = Boolean(
    amount && amount > 0 &&
    reference && reference.length >= 5 &&
    status !== 'failed'
  );

  return {
    raw: text,
    amount,
    amountSantim: amount ? Math.round(amount * 100) : null,
    reference,
    dateTime,
    status,
    provider,
    senderPhone,
    receiverAccount,
    isCrediblePaymentSms,
  };
}
