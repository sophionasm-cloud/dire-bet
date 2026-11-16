# DIRE BET status

Updated: 2026-11-16

## Current product

DIRE BET is a free-play web app that can also open as a Telegram Mini App. Guest users can play practice games locally. Telegram sign-in creates a player account and is required to create or join an online room.

## Games

- XO, Ludo, Dominoes and heads-up Texas Hold’em each have a playable browser practice mode against a bot.
- Those four games also have private, two-player online rooms. The Cloudflare Worker checks turns and legal moves, and records match events in D1. Poker and Dominoes hands are hidden from the other player; poker hands are shown at showdown.
- Ethiopian 41 remains unavailable.
- The four supplied posters appear in the animated home carousel and game cards.

## Security and money status

- `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true`. Wallet UI is informational/demo-only. No deposits, withdrawals, wagers, prizes, commissions or payment providers are active.
- Admin and agent pages remain locked previews. There is no default admin username or password. Do not invent or publish one; secure staff sign-in, MFA, RBAC and isolated agent records still need implementation and owner setup.
- Telegram token and webhook secrets are stored in Cloudflare. The connection script successfully refreshed the webhook, bot commands and menu using the saved token; `-ReplaceBotToken` opens a hidden prompt if it needs updating.
- The GitHub repository is public. The owner can change its visibility in GitHub Settings.

## Cloudflare deployment

- Updated site: `https://dire-bet.sophionasm.workers.dev`; deployment completed on 2026-11-16.
- Existing Worker: `dire-bet`; D1: `dire-bet-db`.
- Migration `0002_enable_freeplay_games.sql` is applied remotely; Ludo, Dominoes and Poker are enabled in D1.
- Live checks: home page HTTP 200, Ludo poster HTTP 200, health reports demo mode and no real money, and all four games report playable. Ethiopian 41 reports unavailable.
- Telegram sign-in and two-account multiplayer have not been verified end to end. Use the local connection script to refresh the webhook, then test with two Telegram accounts.

## Checks

Run `npm run typecheck`, `npm run test`, `npm run check:i18n`, `npm run check:secrets`, and `npm run build` before release. Native-speaker translation review is still pending.
