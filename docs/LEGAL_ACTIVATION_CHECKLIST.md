# Legal and platform activation evidence

Created: 2026-11-15
Status: **NOT APPROVED — live funds must remain disabled**

This is an evidence tracker, not legal advice. No approval or counsel opinion has been supplied or verified for this product. The code defaults to demo mode and refuses live-money routes.

## Official starting sources checked 2026-11-15

- [Ethiopian Criminal Code, Federal Negarit Gazette No. 414/2004, Article 789](https://www.fjli.gov.et/Tedocs/CE/e5.pdf) — counsel must confirm the relevant current text and its application to this product.
- [Sports Betting Lottery Licensing Directive No. 856/2014](https://justice.gov.et/en/directives/sports-betting-lottery-licensing-directive-no-856-2014/) — confirm current status and whether it applies.
- [National Lottery Administration Re-establishment Proclamation No. 510/2006](https://justice.gov.et/en/law/national-lottery-administration-re-establishment-proclamation/) — the Ministry of Justice page labels this proclamation **Repealed**. Do not treat it as current authority without counsel’s confirmation.
- [Telegram Bot Developer Terms](https://telegram.org/tos/bot-developers) — current terms require privacy/security safeguards and prohibit certain regulated or questionable services. Telegram may change its terms.
- [Telegram Stars payment rules](https://core.telegram.org/bots/payments-stars) — Telegram says digital goods and services sold inside bots or Mini Apps must be paid for in Stars (XTR); the page says other currencies/providers are not permitted for those sales inside Telegram apps.
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — free allowances and enforcement change over time.

## Required evidence — every item is pending

| Evidence | Required record | Status |
|---|---|---|
| Ethiopian legal opinion | Dated, signed conclusion covering P2P play, games, entry fees, prizes, deposits, withdrawals, commissions, licensing and current legislation | **OWNER ACTION** |
| Required licenses and authorities | License name, number, issuer, scope, expiry and copy, or written counsel conclusion that none is needed | **OWNER ACTION** |
| Payment providers | Written merchant approval for this exact gaming service and account; provider fees, refund, reconciliation and safeguarding terms | **OWNER ACTION** |
| National Bank / financial requirements | Counsel or authority review of any applicable financial rules | **OWNER ACTION** |
| Telegram | Written response that the exact product and payment flow are permitted; document applicable Stars classification | **OWNER ACTION** |
| Minimum age | Counsel-confirmed age and the verification method | **OWNER ACTION** |
| Responsible play | Loss/deposit limits, reminders, cooling-off, self-exclusion and support process | **OWNER ACTION** |
| Privacy and retention | Approved privacy policy, data purposes, retention schedule, deletion and access request process | **OWNER ACTION** |
| Owner sign-off | Named Super Admin, date, reviewed evidence references and explicit activation decision | **OWNER ACTION** |

## Activation rule

Do not enable `REAL_MONEY_ENABLED=true` or set `DEMO_MODE=false` until all evidence is recorded, the product is implemented, and focused security, ledger, RBAC, age-gate and provider reconciliation checks pass. Activation must be a Super Admin action that creates an immutable audit record. A configuration flag by itself is insufficient. If any approval is missing or refuses the product, leave live deposits, withdrawals, stakes, prizes and cash commissions disabled.
