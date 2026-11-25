# AGENT_RULES.md — Switchboard Non-Negotiable Rules

> Every code change must comply with every rule here. If a rule and an idea conflict, the rule wins.
> "Agent" = a human support agent (u_ben, u_eli, etc.). Nothing in this project is an AI bot.

---

## 0. Authoritative Config Values

### Environment Variables (from `.env.example`)

| Variable | Default / Value |
|---|---|
| `PORT` | `4000` |
| `WEB_ORIGIN` | `http://localhost:5173` |
| `GRADER_TOKEN` | `grader-dev-token` |
| `MONGO_URL` | `mongodb://localhost:27017/switchboard` |
| `REDIS_URL` | `redis://localhost:6379` |
| `ELASTICSEARCH_URL` | `http://localhost:9200` |
| `PIGEON_URL` | `http://localhost:4010` |
| `PIGEON_WEBHOOK_SECRET` | `whsec_pigeon_dev` |
| `PIGEON_KEY_WS_ACME` | `pk_acme_7d1f0a` |
| `PIGEON_KEY_WS_GLOBEX` | `pk_globex_c93b22` |
| `OIDC_ISSUER` | `http://localhost:4020` |
| `OIDC_CLIENT_ID` | `switchboard-web` |
| `OIDC_CLIENT_SECRET` | `dev-secret-not-for-production` |
| `OIDC_REDIRECT_URI` | `http://localhost:4000/auth/callback` |
| `PAYBOX_URL` | `http://localhost:4030` |
| `PAYBOX_SECRET_KEY` | `sk_test_paybox_51c0de` |
| `PAYBOX_PUBLISHABLE_KEY` | `pk_test_paybox_9a7b3e` |
| `PAYBOX_WEBHOOK_SECRET` | `whsec_paybox_dev` |

### `switchboard.json` (must remain exactly this)

```json
{ "install": "npm run scaffold:install", "start": "npm --prefix scaffold/server start", "health": "/healthz" }
```

### Known Workspaces and Pigeon API Keys

| Workspace | Pigeon API Key | Simulated Contacts |
|---|---|---|
| `ws_acme` | `pk_acme_7d1f0a` | `+14155550101`, `+14155550102`, `+14155550103`, `+12125550104`, `+12125550105`, `+13035550106` |
| `ws_globex` | `pk_globex_c93b22` | `+442079460201`, `+442079460202`, `+442079460203`, `+4930901820204`, `+34600111205`, `+34600111206` |

**Pigeon webhook signing secret:** `whsec_pigeon_dev`

### Mock IdP Test Users

| User | `sub` | Workspaces / Roles |
|---|---|---|
| Asha Rao | `u_asha` | `ws_acme` (admin) |
| Ben Ortiz | `u_ben` | `ws_acme` (agent) |
| Chloe Martin | `u_chloe` | `ws_globex` (admin) |
| Dev Patel | `u_dev` | `ws_globex` (agent) |
| Eli Novak | `u_eli` | `ws_acme` (agent) + `ws_globex` (agent) |

---

## 1. Environment & Ports

- **NEVER** hardcode `4000`, `5173`, or any URL/secret.
- Server listens on `Number(process.env.PORT) || 4000`. The grader injects a custom `PORT`.
- All URLs and secrets come from `process.env`, with defaults matching `.env.example` exactly (as already done in `scaffold/server/src/config.ts`).
- The `config.ts` pattern (`env(NAME, defaultValue)`) is correct — extend it, never bypass it.

---

## 2. Healthcheck

- `GET /healthz` → `200 { ok: true }` **only after** both MongoDB and Redis connections are ready.
- During startup, hold the healthcheck at a pending state (or loop on connection) until both stores confirm readiness.
- The grader polls `/healthz` for up to 90 seconds before giving up — it **must** be ready.

---

## 3. Grader Endpoints Auth

All routes under `/__grader/*` must:

```ts
if (req.headers['x-grader-token'] !== config.graderToken) {
  return res.status(401).json({ error: 'unauthorized' });
}
```

- Return `401` for missing, empty, or wrong token — never `403`, never skip.
- These four routes are required:

| Endpoint | Behaviour |
|---|---|
| `POST /__grader/reset` | Delete ALL app data in MongoDB + Redis (keep sessions). Return `200`. |
| `GET /__grader/snapshot` | Return current state in the exact shape documented in BRIEF.md. |
| `POST /__grader/reply` `{ workspace, contact, text, client_ref }` | Enqueue outbound reply; `202` once safely stored. Same `client_ref` twice → `202` both times (idempotent). Unknown `workspace` → `4xx`. |
| `POST /__grader/claim` `{ workspace, contact, agent }` | Atomically claim conversation. `200` if this agent now holds it; `409` if another agent holds it. Holder re-claiming → `200`. |

---

## 4. Pigeon Webhook (`POST /webhooks/pigeon`) — Level 4 Compliance

### 4.1 Signature Verification (verify BEFORE JSON parsing)

1. Capture the raw request body as a `Buffer` (use `express.raw({ type: '*/*' })` on this route only).
2. Parse the `x-pigeon-signature` header: `t=<unix_seconds>,v1=<hex_mac>`.
3. Compute `HMAC-SHA256(key=PIGEON_WEBHOOK_SECRET, message="${t}.${rawBody}")`.
4. Compare result (hex) to `v1` using **timing-safe** comparison (`crypto.timingSafeEqual`).

### 4.2 Exact Response Table

| Condition | Response | Notes |
|---|---|---|
| Signature header missing or malformed | `401` | Never `5xx` |
| Signature does not match raw body | `401` | Never `5xx` |
| Signature valid, `t` > 300 seconds in the past (or future) | `401` | Clock drift window: 300 s |
| Signature valid, body is not parseable JSON | `400` | Never `5xx` |
| Signature valid, unknown `workspace` | `200` | Ignore silently |
| Signature valid, unknown event `type` | `200` | Pigeon adds types without notice |
| Signature valid, `message.status` for unknown `client_ref` | `200` | Ignore silently |
| Signature valid, event already stored (by `event.id`) | `200` | Idempotent — do not re-process |
| Signature valid, `message.inbound` already stored (by `data.message_id`) | `200` | Idempotent |
| Signature valid, genuine new event, **safely persisted** | `200` | Only after DB write |
| Any other server error during processing | `500` is acceptable ONLY if signature already returned — but prefer catching and returning `400`/`200` as appropriate | Never return `5xx` for signature or parse failures |

### 4.3 Acknowledgement Timing

- Must respond `2xx` within **5 seconds**. Pigeon retries 6 times over ~22 seconds if no `2xx`.
- Write to MongoDB then respond. Do NOT do any downstream work (Pigeon calls, etc.) before responding.
- Background work (queuing outbound, etc.) happens asynchronously after the `200` is sent.

---

## 5. Ordering, Deduplication & Idempotency

### Inbound Messages

- **Deduplicate by `event.id`** (stored in an `events` collection). If already seen → `200`, skip.
- **Also deduplicate by `data.message_id`** (stored in `messages` collection). If already stored → `200`, skip.
- The `snapshot` `inbound` array for each `contact` must contain `message_id`s ordered by `occurred_at` **ascending** (oldest first), even when webhooks arrive out of order.
- Use `occurred_at` from the event body (not `Date.now()`) as the canonical timestamp for ordering.

### Outbound Status

- Status progression: `queued` → `sent` → `delivered` | `failed`.
- **Terminal states** (`delivered`, `failed`) must **never** be overwritten by `sent`.
- If `delivered` arrives before `sent` (Pigeon makes no ordering guarantee), store `delivered` and ignore subsequent `sent` for the same `client_ref`.
- Use MongoDB `$max` trick or conditional update: only update if the new status has a higher "rank".
- Status rank: `queued=0`, `sent=1`, `delivered=2`, `failed=2` (both terminals beat `sent`).

### Outbound Sends to Pigeon

- **Always** include `Idempotency-Key: <client_ref>` header on `POST /v1/messages`.
- **Always** include `client_ref` in the body.
- Rate limit: **8-token bucket per workspace, refills at 4/sec**. After `429`, read `Retry-After` header and wait exactly that many seconds before retrying — do NOT send another request before then.
- On `503` (outage): queue the job and retry with exponential backoff. Use a Redis-backed job queue (e.g., Bull/BullMQ, or a simple sorted set) so the queue survives process crashes.
- On slow response (Pigeon may take 12 s): set a client-side timeout of ~6 s. If timeout, treat as unknown (the idempotency key ensures no double-send on retry).
- **Do NOT send the same `client_ref` to Pigeon more than once** — the grader counts duplicates.

---

## 6. Multi-Copy & Crash Safety (Levels 2 & 3)

- **Persist first, respond second**: Store outbound replies in MongoDB with `status: 'queued'` BEFORE returning `202` from `/__grader/reply` or any agent reply endpoint.
- **Redis for shared state**: session store, workspace `seq` counters (atomic `INCR`), pub/sub for WebSocket fan-out across instances, rate-limit state (token buckets per workspace), distributed locks for conversation claims.
- **Redis pub/sub** (or Redis Streams): when one instance processes a webhook or reply, it publishes an event so all instances can push to their connected WebSocket clients.
- **Distributed lock for claims**: use `SET NX PX` (or Redlock) to atomically assign a conversation. Only one process wins; the rest return `409`.
- **Worker queue for outbound**: on startup, each instance picks up `queued` jobs from the shared queue. If an instance dies mid-send, another picks it up within 60 seconds (use job lock TTLs ≤ 60 s).
- **WebSocket reconnect** (`?after=<seq>`): replay all events with `seq > after` from Redis (a Redis Stream or sorted set per workspace). Clients reconnecting to a different instance must get the same missed events.

---

## 7. Auth & Tenant Isolation (Level 5)

### OIDC Flow

- `GET /auth/login` → build authorization URL with PKCE (S256), store `code_verifier` and `state` in session, redirect to IdP.
- `GET /auth/callback` → verify `state`, exchange `code` for tokens, verify PKCE, extract `id_token` claims (`sub`, `workspaces`), write session cookie, redirect to frontend.
- Use the `id_token` JWT `workspaces` claim (array of `{ id, role }`) — do NOT call IdP's `/userinfo` on every request (it's stateless in the mock).
- Session cookie: `httpOnly`, `sameSite: 'lax'`. Use `express-session` with a Redis store.

### API Guards

```
GET /api/me           → 401 if no session, else 200 { sub, workspaces }
GET /api/conversations?workspace=<id>  → 401 no session | 403 not a member | 200 member
GET /ws?workspace=<id>  → refuse upgrade (close socket) if no session or not a member
```

- **Workspace isolation is absolute**: never return data from workspace A to a user of workspace B.
- Role checks: `admin` can do everything `agent` can; use role-based guards for any admin-only actions.

---

## 8. WebSocket Contract

- Path: `GET /ws?workspace=<id>[&after=<seq>]`
- Reject (HTTP 401 before upgrade) if no valid session.
- Reject (HTTP 403 before upgrade) if user is not a member of the workspace.
- After open, if `after=N` is provided, **first** send all stored events with `seq > N` (replay), then continue live.
- Every JSON frame must carry a monotonically increasing `seq` (per-workspace, shared across all instances via Redis `INCR`).
- Required frame shapes:
  ```json
  { "seq": 41, "type": "message.inbound",     "contact": "+14155550101", "message_id": "pmsg_..." }
  { "seq": 42, "type": "message.status",       "contact": "+14155550101", "client_ref": "...", "status": "delivered" }
  { "seq": 43, "type": "conversation.assigned","contact": "+14155550101", "assignee": "u_ben" }
  ```
- Fan-out across instances: publish to a Redis channel per workspace; each instance subscribes and pushes to its local WebSocket clients.

---

## 9. Snapshot Shape (from `GET /__grader/snapshot`)

Must return exactly:

```json
{
  "workspaces": {
    "ws_acme": {
      "contacts": {
        "+14155550101": {
          "inbound":  ["pmsg_00001ab12", "pmsg_00007cd34"],
          "assignee": "u_ben"
        }
      },
      "outbound": { "<client_ref>": "delivered" }
    }
  }
}
```

- `inbound`: ordered oldest→newest by `occurred_at`.
- `assignee`: the `sub` of the holding agent, or `null`.
- `outbound`: maps every known `client_ref` to its current status string.

---

## 10. Stack Constraints

- **Server**: Express + TypeScript, `tsx` runner, Node ≥22, ES modules (`"type": "module"`). Extend `scaffold/server/` only. No new frameworks (no NestJS, Fastify, Hono, etc.).
- **Frontend**: Vite + React 19 + TypeScript. Extend `scaffold/web/` only. No new bundlers, no Next.js.
- **New server deps allowed**: `express-session`, `connect-redis` (or `ioredis` session adapter), `ws` (WebSocket), `openid-client` or manual OIDC, `bullmq` (or manual Redis queue) — all via `npm install` inside `scaffold/server/`.
- **No new web deps unless essential** — React + Vite are enough for the UI.
- **TypeScript strict mode** is on in both `tsconfig.json`s — keep it that way.
- Folder structure: add files under `scaffold/server/src/routes/`, `scaffold/server/src/lib/`, etc. Keep `config.ts`, `db.ts`, `redis.ts` as the foundation.

---

## 11. What "Done" Looks Like Per Level

| Level | Key invariants to never break |
|---|---|
| 1 | All genuine inbound stored (no dupes, ordered), forged/stale rejected with `401`, replies go out exactly once with idempotency key, rate-limit cooloff respected, claims are atomic |
| 2 | Queued replies survive `kill -9`; inbound webhooks re-delivered by Pigeon after restart are stored without duplication |
| 3 | Shared Redis means only one Pigeon request per reply across N instances; `seq` monotonically increases globally; WebSocket clients on instance A see events processed by instance B |
| 4 | Level 4 rules table in §4.2 satisfied exactly |
| 5 | Real PKCE OIDC login; `GET /api/me` correct; `403` for wrong workspace; WebSocket refuses non-members; `?after=N` replays missed frames |

---

## 12. Things People Get Wrong (from `START_HERE.md`)

1. **"Agent" is never an AI.** It's u_ben, u_asha, u_eli, etc.
2. `npm run check` **deletes your data and starts its own server** — always stop your dev server first.
3. The check injects its own `PORT`. A server that only works on 4000 scores **zero**.
4. Never respond `2xx` to a webhook before it is safely in MongoDB.
5. Never send a request to Pigeon inside the `Retry-After` cooloff window — the grader counts these.
6. `occurred_at` from the event body determines message order, not arrival time.
7. `switchboard.json` must remain exactly as given — do not change `start` or `health`.
