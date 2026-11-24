# DIRE BET

DIRE BET is a browser and Telegram game app with a server-backed wallet architecture. Free play is available now. Deposits, withdrawals and paid rooms remain locked until the required legal, provider, age and owner approvals are recorded; do not send funds while the wallet gate is locked.

## Games available now

- XO
- Ludo
- Checkers
- Texas Hold’em (two players)

Each game has practice play against a bot, a private two-player room, and the shared public room lobby. Public rooms reuse the current game engines and two-player setup. Ethiopian 41 is unavailable. The supplied game posters are used in the home carousel and game cards.

Public rooms are FREE while the money gate is locked. Once separately activated, entries are reserved from the persistent ETB wallet ledger and verified winners receive the full pool; no platform or agent commission is enabled. Cancellations, expirations and voided matches refund held funds.

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

The Worker config identifies the environment as production and serves free play with `REAL_MONEY_ENABLED=false` and `DEMO_MODE=false`. Keep real-money features disabled until every item in `docs/LEGAL_ACTIVATION_CHECKLIST.md` is satisfied. Telegram tokens stay in Cloudflare secrets. Run `./scripts/connect-telegram.ps1` to reconnect the bot; use `./scripts/connect-telegram.ps1 -ReplaceBotToken` only when replacing its token. Both prompts hide token typing.

## Telegram bot presentation

The Worker sets the bot description, short description, command menu and chat menu button during Telegram setup. After deploying, run `./scripts/connect-telegram.ps1` once so those fields refresh.

Set `TELEGRAM_CHANNEL_URL` to the official channel (`@channelname` or `https://t.me/...`) in the Worker variables, then redeploy. Until it is set, the Channel button replies that the channel is being prepared; the bot never invents a link.

Configure these in BotFather/Telegram manually:

- Profile photo: upload a square DIRE BET logo. The Bot API cannot set the bot photo.
- Bot name and username: confirm `DIRE BET` and `@Dire_Bet_bot`.
- About and Description: the setup call fills these from the bot profile copy; paste the same text manually if BotFather shows older values.
- Commands: the setup call adds `/start`, `/play`, `/games`, `/wallet`, `/deposit`, `/channel`, `/account` and `/help`.
- Channel: create or confirm the official channel, add the bot as an admin only if you want it to post there, then set `TELEGRAM_CHANNEL_URL`.
- Web App domain: if Telegram requests it, allow `dire-bet.sophionasm.workers.dev` in BotFather.

The owner-only `/promo` command sends the branded play-together post with a **Play Now** button. Forward that post to the channel; `/promo` is deliberately hidden from the public command menu.

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

## Wallet, staff and money status

In Telegram, use **Share contact** to link your own phone contact to your Telegram account. After that, open **Account** in the app to choose a username and 8-digit PIN for optional web sign-in. The PIN is stored as a salted hash; login attempts are rate-limited. Avoid reusing a bank PIN. Phone numbers are encrypted in D1 and are not shown in the app.

The player **Wallet** only shows Telebirr/eBirr payment details after the server activation gate is active. Deposits require a screenshot and transaction reference and are credited only after manual administrator approval. Withdrawals reserve the requested amount, then an administrator manually sends and records the payout. Receipts and account details are encrypted. No provider API or automated payment integration is configured.

Open `/admin` while signed in with the owner's Telegram account. Access requires the owner's personal numeric Telegram ID in Cloudflare as `SUPER_ADMIN_TELEGRAM_ID`; `9041274256` is the bot ID and must not be used. Admins can review payment requests, configure payment accounts, record activation evidence, and manage rooms. Agent accounts only track referrals; no agent earnings are enabled. See [docs/LEGAL_ACTIVATION_CHECKLIST.md](docs/LEGAL_ACTIVATION_CHECKLIST.md) and [docs/OWNER_CHECKLIST.md](docs/OWNER_CHECKLIST.md).
