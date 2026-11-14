# Owner checklist

Actions are ordered. The platform is a free-play preview until every applicable review and implementation step is complete.

1. **Make the GitHub repository private.** The current `sophionasm-cloud/dire-bet` repository is public. In GitHub, open **Settings → General → Danger Zone → Change repository visibility → Make private**. Then confirm access is limited to the intended people.
2. **Obtain Ethiopian legal review.** Ask qualified Ethiopian counsel about this exact P2P game model, Telegram distribution, age requirements, game rules, entry fees, prizes, deposits, withdrawals, agent commissions, licensing and responsible-play duties. Record the signed written opinion and required approvals in `docs/LEGAL_ACTIVATION_CHECKLIST.md`.
3. **Ask Telegram in writing.** Send the exact product and payment flow for review. Do not use an off-platform payment path to get around Telegram’s digital-goods rules or a refusal.
4. **Get written merchant approval.** Each provider must approve this exact gaming activity and merchant account. Confirm applicable National Bank of Ethiopia rules. Do not use personal accounts for customer funds without written authorization.
5. **Confirm privacy, age and retention rules.** Set the minimum age only from qualified legal review. Define age verification, self-exclusion, cooling-off, data access/deletion and retention before production accounts are accepted.
6. **Install Node.js LTS and Git on Windows.** Use a current Node 20.19+ release. Open PowerShell in the project folder and run `npm install`.
7. **Set up Cloudflare access.** Run `npx wrangler login`, then `./scripts/setup.ps1`. The script creates or reuses `dire-bet-db`, saves the D1 ID, applies migrations and uploads the webhook/session secrets through Wrangler stdin. It asks you to enter a strong, one-time `SETUP_KEY` securely; keep it in a password manager until Telegram setup is complete.
8. **Set the bot token only in Wrangler.** Run `npx wrangler secret put TELEGRAM_BOT_TOKEN` and type the token only into Wrangler’s prompt. Never paste it into Codex, a script, a source file or a chat. If it was ever shared, revoke and replace it with BotFather first.
9. **Check the preview locally.** Run `npm run dev`, open the local URL printed by Vite, and check that `/api/health` reports `mode: demo` and `realMoneyAvailable: false`.
10. **Review translations and legal drafts.** Ask native speakers to review `docs/TRANSLATION_REVIEW.md`; ask counsel to review the draft Terms and Privacy material before publishing it.
11. **Do not activate money features yet.** Multiplayer, admin MFA/RBAC, agent isolation, payment integrations and all required focused checks are still incomplete. The production activation record cannot be created by the current UI or API.
12. **Before any later deployment**, run the required reviews and focused checks, inspect the exact Worker target in Cloudflare, confirm the legal checklist is complete, and verify the published health endpoint. After an approved free-play deployment, run `./scripts/complete-telegram-setup.ps1` once to configure the bot webhook/menu. The current Worker target and login could not be inspected in this build session.

## Cost notes

The configured app uses Cloudflare’s free-tier Worker, D1 and SQLite-backed Durable Object resources. Usage can exceed free limits and cause requests to fail; review `docs/FREE_TIER.md` and the account’s usage page. Payment-provider transaction fees, licensing, legal counsel, identity verification and payment-service charges are not hosting costs and are not included in a $0 estimate.
