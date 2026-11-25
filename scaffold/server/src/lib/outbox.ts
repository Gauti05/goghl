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

  // Atomically claim one due job — query and update by clientRef-based filter
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
        lockedUntil: new Date(Date.now() + 15_000),
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after', sort: { nextAttemptAt: 1 } },
  );

  if (!job) return false;

  const { clientRef, workspace, contact, text, attempts } = job as unknown as OutboundJob;

  const redis = getRedis();

  // Check workspace-level rate-limit cooloff (set when Pigeon returns 429)
  const cooloffTs = await redis.get(`cooloff:${workspace}`);
  if (cooloffTs && parseInt(cooloffTs, 10) > Date.now()) {
    // Release job back to queued, schedule after cooloff
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      {
        $set: {
          status: 'queued',
          lockedUntil: null,
          nextAttemptAt: new Date(parseInt(cooloffTs, 10)),
        },
      },
    );
    return true;
  }

  // Check + consume a token from the per-workspace bucket (atomic Lua)
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) {
    // No key for workspace — permanent failure
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      { $set: { status: 'failed', lockedUntil: null, updatedAt: new Date() } },
    );
    return true;
  }

  const tokenAvailable = await consumeToken(redis, workspace);
  if (!tokenAvailable) {
    // Rate limited locally — retry after a short wait
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      {
        $set: {
          status: 'queued',
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + 250),
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
      // Only upgrade if still at a rank below 'sent'
      await upgradeStatus(db, clientRef, 'sent', workspace, contact);
    } else if (sendStatus === 429) {
      // Respect Retry-After header — wait the full cooloff before retrying
      const retryAfterSec = parseInt(resp?.headers.get('retry-after') ?? '2', 10);
      const retryAfterMs = Math.max(retryAfterSec, 1) * 1000;
      await redis.set(`cooloff:${workspace}`, String(Date.now() + retryAfterMs), 'PX', retryAfterMs + 500);
      await db.collection('outbound').updateOne(
        { clientRef, status: 'processing' },
        {
          $set: {
            status: 'queued',
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + retryAfterMs),
          },
        },
      );
    } else {
      // 503 or other — exponential backoff
      const backoffMs = Math.min(2_000, 300 * 2 ** Math.min(attempts - 1, 6));
      await db.collection('outbound').updateOne(
        { clientRef, status: 'processing' },
        {
          $set: {
            status: 'queued',
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + backoffMs),
          },
        },
      );
    }
  } catch {
    // Network error / timeout — only revert to queued if still processing
    // (if Pigeon accepted-slow and already sent a status webhook, don't overwrite it)
    const backoffMs = Math.min(2_000, 300 * 2 ** Math.min(attempts - 1, 6));
    await db.collection('outbound').updateOne(
      { clientRef, status: 'processing' },
      {
        $set: {
          status: 'queued',
          lockedUntil: null,
          nextAttemptAt: new Date(Date.now() + backoffMs),
        },
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
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = 8
local refillRate = 4
local ttl = 5000

local data = redis.call('HMGET', key, 'tokens', 'at')
local tokens = tonumber(data[1]) or capacity
local at = tonumber(data[2]) or now

local elapsed = (now - at) / 1000
tokens = math.min(capacity, tokens + elapsed * refillRate)

if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'at', now)
  redis.call('PEXPIRE', key, ttl)
  return 0
end

tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', key, ttl)
return 1
`;

async function consumeToken(
  redis: ReturnType<typeof getRedis>,
  workspace: string,
): Promise<boolean> {
  const result = await (
    redis as unknown as {
      eval: (script: string, numkeys: number, ...args: (string | number)[]) => Promise<number>;
    }
  ).eval(TOKEN_BUCKET_LUA, 1, `rate:${workspace}`, Date.now());
  return result === 1;
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

  // Polling interval — catches jobs whose nextAttemptAt comes due
  setInterval(() => void processOutbox(), 200);
}
