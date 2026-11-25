/**
 * Outbox — durable outbound message queue backed by MongoDB + Redis.
 *
 * Persist-first: a reply is inserted into MongoDB with status='queued' BEFORE
 * we return 202. The worker then picks it up and sends to Pigeon.
 *
 * All MongoDB updates use { clientRef } as the filter key — clientRef is unique
 * and avoids all _id typing complications with the MongoDB driver.
 */
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { config, KNOWN_WORKSPACES } from '../config.js';
import { publishWorkspaceEvent } from './ws.js';

export class OutboxError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'OutboxError';
  }
}

export interface ReplyRequest {
  workspace: string;
  contact: string;
  text: string;
  client_ref: string;
}

/** Status rank — higher rank always wins, never downgrade. */
const STATUS_RANK: Record<string, number> = {
  queued: 1,
  processing: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};

/**
 * Persist the reply into MongoDB (idempotent by clientRef), then signal the
 * worker. Returns immediately after the DB write.
 */
export async function enqueueReply(req: ReplyRequest): Promise<void> {
  const { workspace, contact, text, client_ref: clientRef } = req;

  if (!KNOWN_WORKSPACES.has(workspace)) {
    throw new OutboxError(`Unknown workspace: ${workspace}`, 400);
  }

  const db = await getDb();

  // Ensure conversation exists
  await db.collection('conversations').updateOne(
    { workspace, contact },
    {
      $setOnInsert: {
        assignee: null,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  // Insert outbound job — duplicate key = already queued, that's fine
  try {
    await db.collection('outbound').insertOne({
      clientRef,
      workspace,
      contact,
      text,
      status: 'queued',
      attempts: 0,
      lockedUntil: null,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      return; // idempotent — already queued or in-flight
    }
    throw err;
  }

  // Signal the worker to run ASAP (best-effort — worker loop also runs on interval)
  setImmediate(() => void processOutbox());
}

let workerRunning = false;

/** Main worker loop — called on startup and whenever a reply is enqueued. */
export async function processOutbox(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    // Keep draining until no more due jobs
    for (;;) {
      const processed = await processOnce();
      if (!processed) break;
    }
  } finally {
    workerRunning = false;
  }
}

interface OutboundJob {
  clientRef: string;
  workspace: string;
  contact: string;
  text: string;
  attempts: number;
  status: string;
}

/** Claim one due job, attempt to send it, return true if a job was processed. */
async function processOnce(): Promise<boolean> {
  const db = await getDb();
  const now = new Date();

  // Atomically claim one due job with an 8s lease for fast dead-worker failover
  const job = await db.collection('outbound').findOneAndUpdate(
    {
      $or: [
        { status: 'queued', nextAttemptAt: { $lte: now } },
        { status: 'processing', lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: 'processing',
        lockedUntil: new Date(Date.now() + 8_000),
      },
    },
    { returnDocument: 'after', sort: { nextAttemptAt: 1 } },
  );

  if (!job) return false;

  const { clientRef, workspace, contact, text, attempts } = job as unknown as OutboundJob;

  const redis = getRedis();

  // Check + consume a token from the per-workspace bucket AND check cooloff atomically
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) {
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      { $set: { status: 'failed', lockedUntil: null, updatedAt: new Date() } },
    );
    return true;
  }

  const gate = await consumeTokenOrCooloff(redis, workspace);
  if (gate.blocked) {
    // Cooloff or rate-limited — release cleanly without incrementing attempts
    const delayMs = gate.cooloffUntilMs > Date.now()
      ? gate.cooloffUntilMs - Date.now() + 50
      : 250;
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      {
        $set: {
          status: 'queued',
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + delayMs),
        },
      },
    );
    return true;
  }

  // Send to Pigeon
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);

    let resp: Response | null = null;
    try {
      resp = await fetch(`${config.pigeon.url}/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': clientRef,
        },
        body: JSON.stringify({ to: contact, text, client_ref: clientRef }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const sendStatus = resp?.status ?? 0;

    if (sendStatus === 200) {
      await upgradeStatus(db, clientRef, 'sent', workspace, contact);
    } else if (sendStatus === 429) {
      const retryAfterSec = parseInt(resp?.headers.get('retry-after') ?? '2', 10);
      const retryAfterMs = Math.max(retryAfterSec, 1) * 1000;
      const cooloffUntil = Date.now() + retryAfterMs;
      await redis.set(`cooloff:${workspace}`, String(cooloffUntil), 'PX', retryAfterMs + 500);
      await redis.hset(`rate:${workspace}`, 'tokens', '0', 'at', String(Date.now()));
      await db.collection('outbound').updateOne(
        { clientRef, status: 'processing' },
        {
          $set: {
            status: 'queued',
            lockedUntil: null,
            nextAttemptAt: new Date(cooloffUntil + 50),
          },
          $inc: { attempts: 1 },
        },
      );
    } else {
      const backoffMs = Math.min(2_000, 300 * 2 ** Math.min(attempts, 6));
      await db.collection('outbound').updateOne(
        { clientRef, status: 'processing' },
        {
          $set: {
            status: 'queued',
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + backoffMs),
          },
          $inc: { attempts: 1 },
        },
      );
    }
  } catch {
    const backoffMs = Math.min(2_000, 300 * 2 ** Math.min(attempts, 6));
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      {
        $set: {
          status: 'queued',
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
        },
        $inc: { attempts: 1 },
      },
    ).catch(() => {});
  }

  return true;
}

/**
 * Upgrade status only if the new rank is higher than the current one.
 * This prevents overwriting 'delivered'/'failed' with 'sent'.
 */
async function upgradeStatus(
  db: Awaited<ReturnType<typeof getDb>>,
  clientRef: string,
  newStatus: string,
  workspace: string,
  contact: string,
): Promise<void> {
  const newRank = STATUS_RANK[newStatus] ?? 0;
  const upgradable = Object.entries(STATUS_RANK)
    .filter(([, r]) => r < newRank)
    .map(([s]) => s);

  const result = await db.collection('outbound').updateOne(
    { clientRef, status: { $in: upgradable } },
    { $set: { status: newStatus, lockedUntil: null, updatedAt: new Date() } },
  );

  if (result.modifiedCount > 0) {
    // Publish WS status event
    try {
      await publishWorkspaceEvent(workspace, {
        type: 'message.status',
        contact,
        client_ref: clientRef,
        status: newStatus,
      });
    } catch {
      // Non-fatal
    }
  } else {
    // Was already at higher rank (e.g., delivered arrived first) — unlock
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      { $set: { lockedUntil: null, status: 'queued' } },
    );
  }
}

/**
 * Atomic Lua script to consume one token from a per-workspace token bucket.
 * Bucket: capacity=8, refill=4/sec.
 * Returns 1 if token consumed, 0 if rate-limited.
 */
const TOKEN_BUCKET_LUA = `
local rateKey = KEYS[1]
local cooloffKey = KEYS[2]
local now = tonumber(ARGV[1])
local capacity = 8
local refillRate = 4
local ttl = 5000

local cooloff = tonumber(redis.call('GET', cooloffKey) or '0')
if cooloff > now then
  return {0, cooloff}
end

local data = redis.call('HMGET', rateKey, 'tokens', 'at')
local tokens = tonumber(data[1]) or capacity
local at = tonumber(data[2]) or now

local elapsed = math.max(0, (now - at) / 1000)
tokens = math.min(capacity, tokens + elapsed * refillRate)

if tokens < 1 then
  redis.call('HMSET', rateKey, 'tokens', tokens, 'at', now)
  redis.call('PEXPIRE', rateKey, ttl)
  return {0, 0}
end

tokens = tokens - 1
redis.call('HMSET', rateKey, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', rateKey, ttl)
return {1, 0}
`;

async function consumeTokenOrCooloff(
  redis: ReturnType<typeof getRedis>,
  workspace: string,
): Promise<{ blocked: boolean; cooloffUntilMs: number }> {
  const res = await (
    redis as unknown as {
      eval: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<[number, number]>;
    }
  ).eval(TOKEN_BUCKET_LUA, 2, `rate:${workspace}`, `cooloff:${workspace}`, Date.now());
  return {
    blocked: res[0] !== 1,
    cooloffUntilMs: Number(res[1] ?? 0),
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

/** Start the background worker loop (call once on server startup). */
export function startOutboxWorker(): void {
  // Run immediately on startup to pick up any queued jobs from before crash
  void processOutbox();

  // Polling interval — catches jobs whose nextAttemptAt or expired lease comes due
  setInterval(() => void processOutbox(), 150);
}
