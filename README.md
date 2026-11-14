# DIRE BET

DIRE BET is a Telegram-first community game project. This repository currently contains a **free-play preview**, not a production betting or payment service. The only playable game is local XO practice against a bot. Demo credits are not ETB cash.

## Stack

- React 18, Vite and TypeScript in `apps/web`
- Cloudflare Worker in `apps/worker`
- D1 schema and migrations in `migrations`
- Shared validation and types in `packages/shared`
- Client-only XO rules and bot in `packages/engines`
- Cloudflare SQLite-backed Durable Object bindings are declared, but the online room services are not implemented

## Windows setup

Install Node.js 20.19 or newer and Git. Open PowerShell in this project folder and run:

```powershell
npm install
npm run check:i18n
npm run check:secrets
npm run db:migrate:local
npm run dev
```

Open the Vite address printed in the PowerShell window (normally `http://127.0.0.1:5173`). Browser guests can browse games and play XO practice. Telegram authentication requires the Worker secrets and a valid Mini App `initData`; without them the app stays in guest mode. Do not add a real bot token to a file. The checked-in `.dev.vars.example` contains empty values only.

The local Worker is served alongside Vite at port 8787. The Vite server forwards `/api` and `/telegram` requests to it. If port 8787 is already in use, stop the other local Worker first.

## Cloudflare setup

The demo preview is deployed to `https://dire-bet.sophionasm.workers.dev`. Its D1 database is configured, and the live health check reports demo mode with live money off. It uses the existing Worker named `dire-bet`.

```powershell
npx wrangler login
./scripts/setup.ps1
npm run deploy
./scripts/connect-telegram.ps1
```

The Telegram script checks that the deployed Worker is still in demo mode, asks for the BotFather token in a hidden prompt, saves it and generated secrets directly to Cloudflare, and configures the bot menu and webhook. Never paste the token into chat, a source file or command arguments. The bot can open the demo; Telegram sign-in inside the app is still unfinished.

For local checks, run `npm run dev` and use the Vite address printed by PowerShell. The deployed app remains demo-only; its money routes are disabled.

## Commands

- `npm run dev` — run local Vite and Wrangler servers
- `npm run test` — run workspace unit tests
- `npm run typecheck` — type-check TypeScript
- `npm run lint` — current lightweight type check; a dedicated lint rule set remains to be added
- `npm run build` — build the player app and Wrangler dry-run bundle
- `npm run db:migrate:local` — apply D1 migrations to the local database
- `npm run db:migrate:remote` — apply schema migrations to remote D1; use only after reviewing the target
- `npm run seed:demo` — insert clearly labeled local dashboard sample rows; refuses remote flags
- `npm run check:secrets` — scan repository text files for Telegram token patterns and private keys
- `npm run check:i18n` — verify the four translation files have identical keys
- `./scripts/connect-telegram.ps1` — securely add the bot token and connect the bot after deployment

`npm run deploy` updates the Worker named `dire-bet`. It deploys the demo preview and does not turn on live funds. Do not enable money features.

## Backups and troubleshooting

Run `./scripts/backup.ps1` from PowerShell after Wrangler is configured. It exports the remote D1 database to an ignored `backups` folder. Review Cloudflare’s current D1 backup/Time Travel settings as well; an export script is not a substitute for tested restores.

- `wrangler login` opens Cloudflare authentication; do not paste API tokens into project files.
- If Vite opens but API calls return unavailable, check the Wrangler process in the second console and apply local migrations.
- If Telegram authentication is unavailable, confirm bot secrets exist in Wrangler and launch the app from the bot’s configured Mini App.
- If Windows says script execution is blocked, run `npm.cmd` / `npx.cmd` or use PowerShell’s process-scoped execution-policy guidance from Microsoft; do not change the machine-wide policy for this app.
- No real-money actions, admin APIs, agent data, online matchmaking, or peer-to-peer rooms are available yet.

## Costs

Cloudflare Worker, D1 and SQLite Durable Object use is designed for the free tier. Free limits can be exhausted and cause requests to fail. Payment transaction charges, legal counsel, licensing, identity verification and any provider charges are separate and unknown until providers approve the service.
