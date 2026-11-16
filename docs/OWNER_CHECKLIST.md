# Owner checklist

The current app is a free-play release with four games. This checklist covers repository privacy, deployment and any later product expansion.

1. **Make the GitHub repository private.** The current `sophionasm-cloud/dire-bet` repository is public. In GitHub, open **Settings → General → Danger Zone → Change repository visibility → Make private**. Then confirm access is limited to the intended people.
2. **Obtain Ethiopian legal review.** Ask qualified Ethiopian counsel about this exact P2P game model, Telegram distribution, age requirements, game rules, entry fees, prizes, deposits, withdrawals, agent commissions, licensing and responsible-play duties. Record the signed written opinion and required approvals in `docs/LEGAL_ACTIVATION_CHECKLIST.md`.
3. **Ask Telegram in writing.** Send the exact product and payment flow for review. Do not use an off-platform payment path to get around Telegram’s digital-goods rules or a refusal.
4. **Get written merchant approval.** Each provider must approve this exact gaming activity and merchant account. Confirm applicable National Bank of Ethiopia rules. Do not use personal accounts for customer funds without written authorization.
5. **Confirm privacy, age and retention rules.** Set the minimum age only from qualified legal review. Define age verification, self-exclusion, cooling-off, data access/deletion and retention before production accounts are accepted.
6. **Install Node.js LTS and Git on Windows.** Use a current Node 20.19+ release. Open PowerShell in the project folder and run `npm install`.
7. **Set up Cloudflare.** Run `npx wrangler login`, then `./scripts/setup.ps1`. It creates or reuses `dire-bet-db`, saves the D1 ID and applies migrations.
8. **Deploy the free-play app.** Apply migrations with `npm run db:migrate:remote`, then run `npm run deploy`. Verify the four-game catalog, home posters and health endpoint at `https://dire-bet.sophionasm.workers.dev`.
9. **Connect Telegram.** Run `./scripts/connect-telegram.ps1` to refresh the webhook. Use `./scripts/connect-telegram.ps1 -ReplaceBotToken` only if the token needs replacing; typing is hidden. Telegram sign-in is implemented; online rooms require two Telegram accounts.
10. **Check locally if needed.** Run `npm run dev` and open the local URL printed by Vite.
11. **Review translations and product documents.** Ask native speakers to review `docs/TRANSLATION_REVIEW.md`.
12. **Keep money features off.** The app has no real-money wallet, payment provider, deposit, withdrawal, wager, prize or commission flow. Admin and agent pages remain locked until secure staff authentication, MFA and permissions are built.
13. **Before later deployments**, rerun checks, confirm the intended Worker in Cloudflare, and verify its health endpoint and game catalog.

## Cost notes

The configured app uses Cloudflare’s free-tier Worker, D1 and SQLite-backed Durable Object resources. Usage can exceed free limits and cause requests to fail; review `docs/FREE_TIER.md` and the account’s usage page. Payment-provider transaction fees, licensing, legal counsel, identity verification and payment-service charges are not hosting costs and are not included in a $0 estimate.
