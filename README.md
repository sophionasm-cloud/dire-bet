# DIRE BET

DIRE BET is a free-play game app for browser and Telegram. Guests can practice on this device. Telegram users can share their own contact to complete registration and play online. **It is not a real-money betting or wallet service.**

## Games available now

- XO
- Ludo
- Dominoes
- Texas Hold’em (two players)

Each game has practice play against a bot, a private two-player room, and the shared public room lobby. Public rooms reuse the current game engines and two-player setup. Ethiopian 41 is unavailable. The supplied game posters are used in the home carousel and game cards.

Public rooms use FREE play or non-redeemable demo credits. Standard demo entries are 10, 20, 50 and 100 credits; custom entries start above 100 and are capped by the room settings. The 10% commission shown in room previews is simulated only and is recorded for completed, verified matches. Cancellations, expirations and voided matches return reserved demo credits. There are no ETB stakes, deposits, withdrawals or cash prizes.

## Run on Windows

Install Node.js 20.19 or newer and Git. Open PowerShell in this project folder and run:

```powershell
npm install
npm run db:migrate:local
npm run dev
```

Open the local web address printed by Vite. The Worker runs alongside it, usually on port 8787. Telegram login needs Worker secrets; without them the app stays in guest mode. The local example secrets file contains blanks only. Never put a bot token in project files or chat.

## Cloudflare

The existing preview is `https://dire-bet.sophionasm.workers.dev`, using Worker `dire-bet` and D1 database `dire-bet-db`.

```powershell
npx wrangler login
npm run db:migrate:remote
npm run deploy
```

The checked-in settings keep `REAL_MONEY_ENABLED=false` and `DEMO_MODE=true`. Do not change them. Telegram tokens stay in Cloudflare secrets. Run `./scripts/connect-telegram.ps1` to reconnect the bot; use `./scripts/connect-telegram.ps1 -ReplaceBotToken` only when replacing its token. Both prompts hide token typing.

## Project commands

- `npm run dev` — run the app locally
- `npm run test` — run unit tests
- `npm run typecheck` — check TypeScript
- `npm run build` — build the web app and Worker bundle
- `npm run deploy` — build and deploy the Worker
- `npm run db:migrate:local` — apply local D1 migrations
- `npm run db:migrate:remote` — apply remote D1 migrations
- `npm run check:i18n` — check English, Amharic, Somali and Afaan Oromoo key parity
- `npm run check:secrets` — scan repository text files for exposed credentials

## Staff preview and money status

In Telegram, use **Share contact** to link your own phone contact to your Telegram account. After that, open **Account** in the app to choose a username and 8-digit PIN for optional web sign-in. The PIN is stored as a salted hash; login attempts are rate-limited. Avoid reusing a bank PIN. Phone numbers are encrypted in D1 and are not shown in the app.

Open `/admin` to create a browser-local demo login. Username: `demo-admin`; the page generates a random password and provides a copy button. The Rooms & Commissions view reads room activity only for the owner Telegram account configured in Cloudflare as `SUPER_ADMIN_TELEGRAM_ID`; the browser-local demo password does not grant those controls. `/agent` shows sample metrics only. Production staff accounts and agent tools are unfinished. There is no real-money wallet or payment provider. See [STATUS.md](STATUS.md) and [docs/OWNER_CHECKLIST.md](docs/OWNER_CHECKLIST.md).
