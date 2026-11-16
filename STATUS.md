# DIRE BET status

Updated: 2026-11-16

## Current product

DIRE BET is a free-play web app that can also open as a Telegram Mini App. Guest users can play practice games locally. Telegram sign-in plus sharing the user's own contact completes registration for online rooms. A username and 8-digit PIN can optionally be set for web sign-in.

## Games

- XO, Ludo, Dominoes and heads-up Texas Hold’em each have a playable browser practice mode against a bot.
- Those four games also have private, two-player online rooms. The Cloudflare Worker checks turns and legal moves, and records match events in D1. Poker and Dominoes hands are hidden from the other player; poker hands are shown at showdown.
- Ethiopian 41 remains unavailable.
- The four supplied posters appear in the animated home carousel and game cards.

## Security and money status

- `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true`. Wallet UI is demo-only. No deposits, withdrawals, wagers, prizes, commissions or payment providers are active.
- The player wallet has a browser-local demo receipt request form. It accepts fake images only, keeps them in the current browser, and never credits a balance.
- Telegram contacts are accepted only when the contact user ID matches the Telegram sender. The phone number is encrypted before D1 storage and is not exposed by the API. Web PINs use salted PBKDF2-SHA-256 with a server-side pepper; sign-in is rate-limited.
- `/admin` has a local demo login. It generates a one-time password in the browser, stores only a salted hash locally, and reviews requests from that same browser. `/agent` shows sample metrics only. Neither page has production staff authentication or real player/payment data.
- Production staff sign-in, MFA, server-side RBAC and agent record isolation still need implementation and owner setup.
- Telegram token and webhook secrets are stored in Cloudflare. The connection script successfully refreshed the webhook, bot commands and menu using the saved token; `-ReplaceBotToken` opens a hidden prompt if it needs updating.
- The GitHub repository is public. The owner can change its visibility in GitHub Settings.

## Cloudflare deployment

- Updated site: `https://dire-bet.sophionasm.workers.dev`; deployment completed on 2026-11-16.
- Existing Worker: `dire-bet`; D1: `dire-bet-db`.
- Migrations `0001_core.sql`, `0002_enable_freeplay_games.sql`, and `0003_player_registration.sql` are applied remotely; Ludo, Dominoes and Poker are enabled in D1.
- Live health reports demo mode and no real money; all four games report playable. Ethiopian 41 reports unavailable.
- The new Telegram contact registration and optional web login need a live two-account user check, as do online rooms. Use the local connection script to refresh the webhook, then test with two Telegram accounts.

## Checks

Run `npm run typecheck`, `npm run test`, `npm run check:i18n`, `npm run check:secrets`, and `npm run build` before release. Native-speaker translation review is still pending.
