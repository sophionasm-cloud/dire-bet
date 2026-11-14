# Cloudflare free-tier budget

Checked against Cloudflare’s official pricing and limits pages on 2026-11-15. Verify again before deployment; Cloudflare changes quotas and billing. Free limits are hard limits, not capacity promises. Exceeding some limits causes requests to fail.

| Resource | Current free allowance used for planning |
|---|---:|
| Workers requests | 100,000/day, reset at 00:00 UTC |
| Worker CPU time | 10 ms per invocation |
| Worker subrequests | 50 per incoming request |
| D1 rows read | 5 million/day |
| D1 rows written | 100,000/day |
| D1 storage | 5 GB total across up to 10 databases |
| SQLite Durable Objects | SQLite storage backend only on Free; 100,000 requests/day and 13,000 GB-seconds/day |
| SQLite Durable Object storage | Up to 5 GB account storage on Free; Cloudflare says Workers Free users are not charged for SQLite storage |
| Durable Object classes | Up to 100 classes per account on Free |
| Cron Triggers | Up to 5 per account |
| WebSockets | Hibernation avoids idle duration while eligible; incoming WebSocket messages count toward usage with Cloudflare’s 20:1 request weighting described in Workers pricing |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [SQLite storage billing update](https://developers.cloudflare.com/changelog/post/2025-12-12-durable-objects-sqlite-storage-billing/).

## Traffic estimate

The preview has no online rooms and no load test. For planning only, a small launch should start with **about 50–100 simultaneously connected players** and watch request, message, D1 and CPU metrics. A 25-second heartbeat from 100 connected clients alone is about 345,600 heartbeats/day before moves, reconnects, HTTP requests or bot work. The weighted WebSocket allowance may cover more idle sockets, but real traffic and the shared Worker request budget reduce that number. Treat this estimate as conservative operational guidance, not a measured capacity guarantee. Do not sell an expected capacity until two-device testing and load measurements exist.

## Design limits

- Use WebSocket Hibernation; do not keep Durable Objects awake between messages.
- Use 25-second heartbeats only for real online rooms, not guest practice.
- Do not write each move to D1. Persist match start/end and bounded key events in batches.
- Cap result pages and index filters; avoid table scans on public endpoints.
- Cache public presence aggregates for 15 seconds and avoid polling from every screen.
- Clean expired sessions and rate-limit state with bounded scheduled work.
- Keep within five Cron Triggers per account. The current config uses one five-minute trigger only for session cleanup.
- Monitor usage in Cloudflare before enabling any growth campaign; feature toggles cannot override platform limits.
