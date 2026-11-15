# DIRE BET status

Updated: 2026-11-15

## Live demo preview

- Deployed to `https://dire-bet.sophionasm.workers.dev` on the existing `dire-bet` Worker.
- Remote D1 database `dire-bet-db` exists in region EEUR; migration `0001_core.sql` applied successfully.
- Live `/api/health` verified `{ "ok": true, "mode": "demo", "realMoneyAvailable": false }`.
- Live `/api/games` verified. XO is marked playable for practice; Ludo, Dominoes and Poker are preview-only; Ethiopian 41 is unavailable.
- Telegram bot setup succeeded: Cloudflare has the required secrets, and Telegram accepted the webhook, commands and menu. The token was entered through a hidden local prompt and was not shared in chat.
- Telegram login inside the player app is still unfinished. The bot's `/start` and menu open the demo.
- `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true`. No deposit, withdrawal, stake, prize or cash-commission feature is enabled.

## Built

- React/Vite player preview, Cloudflare Worker, shared packages and D1 schema.
- Four languages (English, Amharic, Somali, Afaan Oromoo), guest navigation, wallet lock screen and local XO practice against a bot.
- Telegram init-data verification and short-lived session code, bot webhook/setup endpoints, health/catalog endpoints and disabled live-money routes.
- Responsive browser previews for player, wallet, admin and agent. Screenshots are in `docs/screenshots/`.

## Checks

- All four languages checked at 360×740; no horizontal overflow observed.
- Wallet checked at 390×844 and 1440×900. Admin and agent previews checked at phone and desktop sizes.
- XO practice played to a finished round.
- `npm run test`: 10 unit tests passed (i18n 2, Worker security 4, XO engine 4).
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run check:i18n`, `npm run check:secrets` passed. The lint command is currently a TypeScript check. Translation parity is 78 keys × 4 languages; secret scan covered 65 repository files.
- PowerShell scripts parsed successfully. Local D1 migration and live remote migration both completed.

## Not implemented

- **Peer-to-peer games complete: 0.** XO is single-player practice against a local bot. Online rooms and matchmaking do not exist.
- Telegram login is not wired into the player UI. The bot token has not been added, so the bot has not been connected yet.
- Admin MFA/RBAC and operational APIs, agent onboarding/isolation, wallet endpoints, payment integrations, referrals/promos, multiplayer, voice, notifications, support backend and PNG export remain unfinished. Admin and agent routes are locked previews.
- Translation review by native speakers remains pending.
- The GitHub repository is public. Owner may make it private in GitHub Settings if needed.

## Costs and safeguards

Cloudflare use may remain $0 within its free quotas. Provider fees, licensing and other service costs are separate. The deployment is demo-only; keep money features off.
