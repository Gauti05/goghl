import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis, waitRedisReady } from './redis.js';
import { webhookRouter } from './routes/webhooks.js';
import { graderRouter } from './routes/grader.js';
import { attachWss } from './lib/ws.js';
import { startOutboxWorker } from './lib/outbox.js';

const app = express();

// ─── 1. Raw body capture for Pigeon webhook (MUST be before express.json) ────
app.use('/webhooks/pigeon', express.raw({ type: '*/*' }));

// ─── 2. Global JSON parser for all other routes ───────────────────────────────
app.use(express.json());

// ─── 3. Healthcheck — only 200 after both stores are ready ───────────────────
let ready = false;

app.get('/healthz', (_req: Request, res: Response) => {
  if (ready) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ ok: false, error: 'not ready' });
  }
});

// ─── 4. Routes ────────────────────────────────────────────────────────────────
app.use('/', webhookRouter);
app.use('/__grader', graderRouter);

// ─── 5. HTTP server + WebSocket ───────────────────────────────────────────────
const server = createServer(app);
attachWss(server);

// ─── 6. Startup ───────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Connect to MongoDB (creates indexes) and Redis before accepting traffic
  await getDb();
  await waitRedisReady();

  ready = true;
  console.log('MongoDB and Redis ready');

  // Start outbound message worker (picks up queued jobs from before crash)
  startOutboxWorker();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
