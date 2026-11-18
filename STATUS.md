# DIRE BET status

Updated: 2026-11-18

## Current product

DIRE BET is a free-play web app that can also open as a Telegram Mini App. Guest users can play practice games locally. Telegram sign-in plus sharing the user's own contact completes registration for online rooms. A username and 8-digit PIN can optionally be set for web sign-in.

## Games

- XO, Ludo, Dominoes and heads-up Texas Hold'em each have a playable browser practice mode against a bot, private two-player rooms, and the shared public room lobby. The public marketplace reuses the existing four game engines and player configurations; a full room opens the existing match.
- The Cloudflare Worker checks turns and legal moves, and records match events in D1. Poker and Dominoes hands are hidden from the other player; poker hands are shown at showdown.
- Room entry is FREE or non-redeemable demo credits (10/20/50/100, plus custom whole amounts above 100 within the configured cap). A 10% commission is simulated only for completed, verified matches, with the rate saved when a room is created. Cancelled, expired and voided matches return reserved demo credits.
- Ethiopian 41 remains unavailable.
- The four supplied posters appear in the animated home carousel and game cards.

## Wallet and staff previews

- The player wallet is server-backed but demo-only. Telebirr and eBirr are shown with receiving number `0956870660` and a repeated warning not to send money. Deposit requests capture a sender number, transaction reference and optional encrypted PNG/JPG receipt. Withdrawal requests capture an encrypted destination number and account holder name.
- Deposit and withdrawal approval never credits a balance and never sends money. Admin review only changes the request status and writes an audit entry. API responses return decrypted contact fields only to the authenticated owner and never expose stored ciphertext.
- `/admin` owner tools require a signed-in Telegram account whose numeric ID matches `SUPER_ADMIN_TELEGRAM_ID`. The browser-local demo password unlocks preview-only pages and cannot access Payments, Agents, Rooms, deposits, withdrawals or production player data. The owner dashboard has a horizontal section nav on mobile.
- `/agent` is server-backed. It shows a 5% simulated share of each referred player's positive net demo-credit loss for completed public demo matches linked to the agent's promo code, grouped by Addis Monday-to-Sunday weeks. Values are simulated credits with no cash value or payable balance. Suspended and revoked agents are denied.
- Referrals are linked from `/start agent_CODE` in Telegram or the wallet promo-code field. Invalid, inactive or already-used codes are rejected.

## Security and money status

- `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true`. No real deposits, withdrawals, cash wagers, prizes, collected commissions or payment providers are active. Marketplace commission and payout values are simulated demo-credit figures only.
- Telegram contacts are accepted only when the contact user ID matches the Telegram sender. Phone numbers, withdrawal details and receipts are encrypted before D1 storage. Web PINs use salted PBKDF2-SHA-256 with a server-side pepper; sign-in is rate-limited.
- `SUPER_ADMIN_TELEGRAM_ID` is not configured in production yet. The owner must provide their personal numeric Telegram user ID from `@userinfobot`; `9041274256` is the bot ID and must not be used as the owner ID.
- Owner access is gated by Telegram identity. MFA, additional staff roles and multi-owner administration are still future work.
- Telegram token and webhook secrets are stored in Cloudflare. The connection script successfully refreshed the webhook, bot commands and menu using the saved token; `-ReplaceBotToken` opens a hidden prompt if it needs updating.
- The GitHub repository is public. The owner can change its visibility in GitHub Settings.

## Cloudflare deployment

- Live site: `https://dire-bet.sophionasm.workers.dev`.
- Existing Worker: `dire-bet`; D1: `dire-bet-db`.
- Migrations `0001_core.sql` through `0004_wallet_preview_workflows.sql` are applied remotely. Migration 0004 adds the preview wallet schema and seeds both demo payment methods with receiving number `0956870660`; it does not enable real payments.
- Deployment keeps `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true` and leaves `SUPER_ADMIN_TELEGRAM_ID` unset until the owner supplies their personal Telegram ID.
- The new Telegram contact registration, wallet preview flows and online rooms still need a live two-account user check.

## Checks

Run `npm run typecheck`, `npm run test`, `npm run check:i18n`, `npm run check:secrets`, and `npm run build` before release. Native-speaker translation review is still pending.
