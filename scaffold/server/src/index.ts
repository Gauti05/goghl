import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './db.js';
import { waitRedisReady } from './redis.js';
import { loadSession } from './middleware/session.js';
import { webhookRouter } from './routes/webhooks.js';
import { graderRouter } from './routes/grader.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { attachWss } from './lib/ws.js';
import { startOutboxWorker } from './lib/outbox.js';

const app = express();

// ─── 1. Raw body capture for Pigeon webhook (MUST be before express.json) ────
app.use('/webhooks/pigeon', express.raw({ type: '*/*' }));

// ─── 2. Global JSON parser + session loader for all other routes ──────────────
app.use(express.json());
app.use(loadSession);

// ─── 3. Healthcheck — only 200 after both stores are ready ───────────────────
let ready = false;

app.get('/healthz', (_req: Request, res: Response) => {
  if (ready) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ ok: false, error: 'not ready' });
  }
});

// ─── 4. API & Webhook Routes ──────────────────────────────────────────────────
app.use('/', webhookRouter);
app.use('/__grader', graderRouter);
app.use('/auth', authRouter);
app.use('/api', apiRouter);

// ─── 5. Serve built React app (scaffold/web/dist) when present ────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDistDir = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDistDir)) {
  app.use(express.static(webDistDir));
  app.get('*', (req: Request, res: Response, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/auth') ||
      req.path.startsWith('/__grader') ||
      req.path.startsWith('/webhooks') ||
      req.path.startsWith('/healthz') ||
      req.path.startsWith('/ws')
    ) {
      return next();
    }
    res.sendFile(path.join(webDistDir, 'index.html'));
  });
}

// ─── 6. HTTP server + WebSocket ───────────────────────────────────────────────
const server = createServer(app);
attachWss(server);

// ─── 7. Startup ───────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  await getDb();
  await waitRedisReady();

  ready = true;
  console.log('MongoDB and Redis ready');

  startOutboxWorker();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
