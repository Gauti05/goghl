# Switchboard

Shared team inbox for customer messaging built on Express, TypeScript, React, MongoDB, and Redis.

## Prerequisites

- Node.js `>= 22`
- Docker & Docker Compose (for MongoDB, Redis, Pigeon, Mock IdP, Paybox)

## Running from a clean clone

```bash
# 1. Start MongoDB, Redis, and the simulators
npm run up
npm run doctor

# 2. Install & build server + web
npm run scaffold:install
npm --prefix scaffold/server run build
npm --prefix scaffold/web run build

# 3. Start the server (serves API, WebSocket, and built React app on PORT, default 4000)
npm run start:server
```

For local development with Vite hot-reload:

```bash
npm run scaffold:server   # API + WS on :4000
npm run scaffold:web      # Vite dev server on :5173 (proxies /api, /auth, /ws, /healthz)
```

## Verification

Stop any running dev server first, then run:

```bash
# Unit tests
npm --prefix scaffold/server test

# Level 1 quick check
npm run check

# Full check (Levels 1, 2, 3, and 5) -> writes CHECK_REPORT.json
npm run check:full
```
