# Design Decisions

## What was built
- **Webhook ingestion (`POST /webhooks/pigeon`)**: Raw-buffer HMAC-SHA256 verification with 300s timestamp window, strict Level 4 status codes, idempotency by `message_id` and `event.id` (with `event.id` recorded *after* `messages` and `conversations` persistence so a mid-request `kill -9` never causes a retry to be skipped), and chronological ordering by `occurred_at`.
- **Durable outbound outbox**: Replies are persisted in MongoDB (`status: 'queued'`) before returning `202`. Workers claim jobs atomically with an 8-second `lockedUntil` lease and `150ms` recovery sweep, use `Idempotency-Key: <client_ref>` on Pigeon sends, and share a per-workspace Redis Lua token bucket (`capacity=8, refill=4/sec`) + `cooloff:${workspace}` gate across all server instances.
- **OIDC + Tenant Isolation + Multi-Copy WebSockets**: Authorization code + PKCE (`S256`) login backed by Redis sessions, strict `401`/`403` guards on REST and `/ws` upgrades, monotonic per-workspace `seq` via Redis `INCR`, history in `events:${workspace}` sorted sets for `?after=N` replay, and Redis Pub/Sub (`ws:pub:${workspace}`) fan-out.
- **React Agent Inbox**: Login screen, workspace switcher, conversation filters, live message timeline with outbound status badges, atomic claim/unclaim & close/reopen, and client-side AES-GCM encrypted private notes.

## What was cut and why
- **Elasticsearch search & Paybox billing**: Prioritized core reliability (Levels 1–5) and E2EE private notes over optional search and bonus billing within the 2-hour window.
- **Outbound status regression guard**: `queued/processing (1) < sent (2) < delivered/failed (3)` prevents late `sent` webhooks or slow HTTP timeouts from overwriting terminal states.

## Assumptions
- `IDP_URL` may differ from `OIDC_ISSUER` inside container networks, so server-to-server `token`/`userinfo` calls rewrite `http://localhost:4020` to `IDP_URL` while keeping browser redirects intact.
- Private note encryption keys are shared out-of-band among workspace agents and stored only in browser `localStorage`.

## Known limitations
- Redis `events:${workspace}` sorted sets grow unbounded between resets; in production these should be trimmed with `ZREMRANGEBYRANK`.
- `harness/check.js` uses POSIX `process.kill(-pid, 'SIGKILL')`, so Levels 2 and 3 must be executed in Linux/Docker/WSL rather than native Windows PowerShell.
