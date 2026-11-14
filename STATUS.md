# DIRE BET status

Updated: 2026-11-15

## Built in this checkout

- React/Vite player preview, Cloudflare Worker, shared packages, D1 schema and local setup scripts.
- Four interface languages (English, Amharic, Somali and Afaan Oromoo), guest navigation, wallet lock screen and a playable local XO practice round against a bot.
- Telegram init-data verification and short-lived session code, bot webhook/setup endpoints, health/catalog endpoints, and disabled live-money routes.
- Demo-safe defaults: `REAL_MONEY_ENABLED=false`, `DEMO_MODE=true`. Ethiopian 41 is locked in both catalog and schema.
- Owner, legal, privacy, free-tier and translation-review documents. Phone and desktop browser screenshots are in `docs/screenshots/`.

## Browser and local checks

- All four interface languages checked at 360×740; no horizontal page overflow observed.
- Wallet checked at 390×844 and 1440×900. Admin and agent screens checked at phone and desktop sizes; both are access-locked previews with no data.
- XO practice played to a finished round. Local `/api/health` returned `{ "ok": true, "mode": "demo", "realMoneyAvailable": false }`.
- `npm run test`: 10 unit tests passed (i18n 2, Worker security 4, XO engine 4).
- `npm run typecheck`, `npm run build`, `npm run check:i18n`, `npm run check:secrets` passed. Translation parity is 78 keys × 4 languages; secret scan covered 58 repository text files.
- `npm run db:migrate:local` applied the local D1 schema. The Wrangler build was a dry run only.

## Not implemented or not verified

- **Peer-to-peer games complete: 0.** XO is single-player practice against a local bot. Ludo, Dominoes and Poker are coming soon; there is no online room or matchmaking service.
- Telegram login is not wired into the player UI. Bot/D1 production setup, remote database, webhook configuration and deployment have not been run.
- Admin MFA/RBAC and operational APIs, agent onboarding/isolation, wallet endpoints, payment integrations, referrals/promos, multiplayer, voice, notifications, support backend, PNG export and age verification remain unimplemented.
- Admin and agent routes are static locked previews; they are not functioning portals.
- No Ethiopian legal opinion, applicable license confirmation, Telegram approval or provider approval has been supplied. Keep all cash features off.
- Translation review by native speakers remains pending.
- Wrangler is not authenticated on this machine. No production account, remote resources or live URL were verified.
- The GitHub repository is public. The owner asked for privacy; change it to private before pushing code.

## Costs

Cloudflare use can be $0 while the account stays within current free limits. Payment processing, licensing, legal counsel, identity/age checks, support and other provider charges are separate and unknown. See `docs/FREE_TIER.md`.

## Deployment

Not deployed and not ready for a live-money launch. Review `docs/OWNER_CHECKLIST.md` and `docs/LEGAL_ACTIVATION_CHECKLIST.md` before using any hosted service. Do not enable live funds.
