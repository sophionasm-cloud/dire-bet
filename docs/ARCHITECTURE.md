# DIRE BET architecture

Last updated: 2026-11-19

## Application and room services

- `apps/web` is the React and Vite player app. English, Amharic, Somali and Afaan Oromoo are included. The home carousel uses the supplied posters.
- `packages/engines` contains XO, Ludo, Checkers and Texas Hold’em rules. Practice games run locally against bots.
- `apps/worker` verifies Telegram Mini App data, creates short-lived player sessions, serves the public catalog and handles room APIs.
- `GameRoom` is the authoritative Cloudflare Durable Object for private two-player rooms. It validates turns and game actions, uses server-generated room randomness, records match results/events in D1, and redacts private Poker and Dominoes state from player views.
- `Matchmaker` is the shared Durable Object for public rooms across XO, Ludo, Checkers and heads-up Poker. It owns waiting-room state, server-side expiry, atomic seat assignment, wallet holds/refunds, room events and live public-list updates. When a room fills, it creates the D1 game-room record and starts `GameRoom` with the selected game and seat options.
- Free rooms remain available while paid entries are locked. After activation, room entries reserve real ETB from the D1 wallet ledger. Verified results pay the winner or split draws; voids, cancellations and expirations refund the original holds. Idempotency keys make retries safe. No room commission or agent cash commission is enabled.
- `migrations/0001_core.sql` creates the initial database. Migrations `0002` through `0007` add game, registration, review, wallet-ledger and room-stake schema.
- `0003_player_registration.sql` adds optional web credentials and an encrypted contact record for Telegram registration.

```mermaid
flowchart LR
  G[Browser guest] --> W[Cloudflare Worker and web app]
  T[Telegram Mini App] --> W
  W --> D[D1 accounts and match history]
  W --> R[Durable Object game room]
  G --> P[Local practice engines]
  T --> P
  T -->|Telegram identity required| R
```

## Authentication and staff routes

Telegram `initData` is HMAC-verified and age-checked before creating or updating a player record. In a private bot chat, users can share their own contact using Telegram's consent prompt. The bot verifies the contact belongs to the sender, encrypts the phone number with a key derived from `SESSION_SECRET`, and stores it in D1. The number is not returned by any API. A linked contact is required to create or join online rooms.

After sharing a contact, a user can set an optional web username and 8-digit PIN while signed in through Telegram. The PIN uses PBKDF2-SHA-256 with a random salt and a server-side pepper. Password sign-in is rate-limited to six attempts per username and 30 attempts per network per 15 minutes. Password sessions last 12 hours; Telegram sessions last 15 minutes. Forgotten web credentials can be reset from the Telegram account session. Private room requests also use a short-lived room ticket for WebSocket access.

`/admin` requires the configured Super Admin Telegram identity and uses server-backed payment, age-review, activation, agent and room APIs. `/agent` shows real referral attribution only; agent earnings are disabled. The removed browser-local demo login and receipt store do not authorize or alter server records.

The Rooms panel calls server-backed APIs. These require a valid session whose Telegram numeric ID matches `SUPER_ADMIN_TELEGRAM_ID`. Configure it with the owner's personal Telegram ID before owner tools can be used. Setting changes, request reviews, age decisions and cancellations are audited. Admins cannot alter match results.

## Wallet and activation boundary

- The application has server-controlled ETB balances in an append-only D1 ledger. Deposits require a Telebirr or eBirr reference and encrypted screenshot; an administrator must verify and approve before a database trigger credits the wallet. Withdrawals reserve funds when requested, support administrator approval/rejection, and require a manual transfer reference to mark payout complete. Duplicate references and request keys are rejected.
- P2P room holds, verified payouts and refunds also use that ledger. No payment provider API is integrated; deposit verification and withdrawal transfers are manual. Age-check references are reviewed by an administrator before the account is eligible.
- `REAL_MONEY_ENABLED=false` and `DEMO_MODE=false` are the checked-in production settings. Migration `0006` clears the seeded payment numbers and disables both methods. The app serves free play; wallet and paid-room APIs refuse funds until real-money configuration and the immutable activation evidence gate both pass.

## Remaining operational work

No deployment or remote migration was performed in this task. Before any live funds are enabled, complete every owner action in `LEGAL_ACTIVATION_CHECKLIST.md`, configure the owner account and payment details, verify the age-check method and retention policy, and run ledger/RBAC/age/provider reconciliation checks. Do not change the live-money flags while any approval is missing. Two Telegram accounts are needed for end-to-end room checks. Ethiopian 41 has no engine and stays unavailable.
