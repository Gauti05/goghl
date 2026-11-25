import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { config, KNOWN_WORKSPACES } from '../config.js';
import { publishWsEvent } from '../lib/ws.js';

export const webhookRouter = Router();

// Status rank — higher rank wins; terminal states never downgraded
const STATUS_RANK: Record<string, number> = {
  queued: 1,
  processing: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};

// ─── POST /webhooks/pigeon ────────────────────────────────────────────────────
// MUST be mounted with express.raw({ type: '*/*' }) BEFORE global json middleware.
webhookRouter.post('/webhooks/pigeon', async (req: Request, res: Response) => {
  // 1. Extract raw body (express.raw gives us Buffer)
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(401).json({ error: 'no raw body' });
    return;
  }

  // 2. Parse and verify signature header
  const sigHeader = req.headers['x-pigeon-signature'];
  if (!sigHeader || typeof sigHeader !== 'string') {
    res.status(401).json({ error: 'missing signature' });
    return;
  }

  const sigMatch = sigHeader.match(/^t=(\d+),v1=([0-9a-f]+)$/i);
  if (!sigMatch) {
    res.status(401).json({ error: 'malformed signature' });
    return;
  }

  const t = parseInt(sigMatch[1]!, 10);
  const providedMac = sigMatch[2]!;

  if (isNaN(t)) {
    res.status(401).json({ error: 'invalid timestamp' });
    return;
  }

  // 3. Enforce 5-minute timestamp window
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > 300) {
    res.status(401).json({ error: 'timestamp too old or too far in future' });
    return;
  }

  // 4. HMAC-SHA256 verification using raw body bytes
  const expectedMac = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${t}.`)
    .update(rawBody)
    .digest('hex');

  let macValid = false;
  try {
    macValid = crypto.timingSafeEqual(
      Buffer.from(expectedMac, 'hex'),
      Buffer.from(providedMac.toLowerCase(), 'hex'),
    );
  } catch {
    // length mismatch — invalid
  }

  if (!macValid) {
    res.status(401).json({ error: 'signature mismatch' });
    return;
  }

  // 5. Parse JSON — after signature validation
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  // 6. Unknown workspace → 200 and ignore
  const workspace = event['workspace'] as string | undefined;
  if (!workspace || !KNOWN_WORKSPACES.has(workspace)) {
    res.status(200).json({ ok: true });
    return;
  }

  // 7. Unknown event type → 200 and ignore
  const eventType = event['type'] as string | undefined;
  if (!eventType) {
    res.status(200).json({ ok: true });
    return;
  }

  const eventId = event['id'] as string | undefined;
  if (!eventId) {
    res.status(200).json({ ok: true });
    return;
  }

  const db = await getDb();

  // 8. Deduplicate by event.id (atomic insert; duplicate key = already processed)
  try {
    await db.collection('events').insertOne({
      eventId,
      type: eventType,
      workspace,
      processedAt: new Date(),
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      // Already processed — idempotent 200
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }

  // 9. Handle known event types
  if (eventType === 'message.inbound') {
    await handleInbound(db, event, workspace, res);
  } else if (eventType === 'message.status') {
    await handleStatus(db, event, workspace, res);
  } else {
    // Unknown type — 200, ignore (Pigeon adds types without notice)
    res.status(200).json({ ok: true });
  }
});

// ─── Inbound message ─────────────────────────────────────────────────────────
async function handleInbound(
  db: Awaited<ReturnType<typeof getDb>>,
  event: Record<string, unknown>,
  workspace: string,
  res: Response,
): Promise<void> {
  const data = event['data'] as Record<string, unknown> | undefined;
  if (!data) {
    res.status(400).json({ error: 'missing data' });
    return;
  }

  const messageId = data['message_id'] as string | undefined;
  const from = data['from'] as string | undefined;
  const text = data['text'] as string | undefined;
  const occurredAtStr = event['occurred_at'] as string | undefined;

  if (!messageId || !from || !occurredAtStr) {
    res.status(400).json({ error: 'missing required inbound fields' });
    return;
  }

  const occurredAt = new Date(occurredAtStr);

  // Deduplicate by message_id
  try {
    await db.collection('messages').insertOne({
      messageId,
      workspace,
      contact: from,
      text: text ?? '',
      occurredAt,
      direction: 'inbound',
      createdAt: new Date(),
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }

  // Upsert conversation — $setOnInsert only on creation, $max for updatedAt
  await db.collection('conversations').updateOne(
    { workspace, contact: from },
    {
      $setOnInsert: {
        assignee: null,
        status: 'open',
        createdAt: new Date(),
      },
      $max: { updatedAt: occurredAt },
    },
    { upsert: true },
  );

  // Publish WebSocket event to all instances
  await publishInboundEvent(workspace, from, messageId);

  res.status(200).json({ ok: true });
}

// ─── Status update ───────────────────────────────────────────────────────────
async function handleStatus(
  db: Awaited<ReturnType<typeof getDb>>,
  event: Record<string, unknown>,
  workspace: string,
  res: Response,
): Promise<void> {
  const data = event['data'] as Record<string, unknown> | undefined;
  if (!data) {
    res.status(200).json({ ok: true });
    return;
  }

  const clientRef = data['client_ref'] as string | undefined;
  const newStatus = data['status'] as string | undefined;

  if (!clientRef || !newStatus) {
    res.status(200).json({ ok: true });
    return;
  }

  const newRank = STATUS_RANK[newStatus];
  if (newRank === undefined) {
    // Unknown status string — ignore
    res.status(200).json({ ok: true });
    return;
  }

  // Find existing outbound record
  const outbound = await db.collection('outbound').findOne({ clientRef });
  if (!outbound) {
    // Unknown client_ref — ignore per spec
    res.status(200).json({ ok: true });
    return;
  }

  const currentRank = STATUS_RANK[outbound['status'] as string] ?? 0;

  // Only upgrade if new status has higher or equal rank (never downgrade)
  if (newRank > currentRank) {
    await db.collection('outbound').updateOne(
      { clientRef, status: { $in: getStatusesBelowRank(newRank) } },
      { $set: { status: newStatus, updatedAt: new Date() } },
    );

    // Publish WS event for status change
    await publishStatusEvent(workspace, outbound['contact'] as string, clientRef, newStatus);
  }

  res.status(200).json({ ok: true });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: number }).code === 11000
  );
}

function getStatusesBelowRank(rank: number): string[] {
  return Object.entries(STATUS_RANK)
    .filter(([, r]) => r < rank)
    .map(([s]) => s);
}

async function publishInboundEvent(
  workspace: string,
  contact: string,
  messageId: string,
): Promise<void> {
  try {
    const redis = getRedis();
    // Assign a workspace-scoped sequence number
    const seq = await redis.incr(`seq:${workspace}`);
    const frame = JSON.stringify({
      seq,
      type: 'message.inbound',
      contact,
      message_id: messageId,
    });
    // Store in Redis stream for replay (keep 10k events per workspace)
    await redis.xadd(`stream:${workspace}`, '*', 'seq', String(seq), 'frame', frame);
    // Pub/sub fan-out to all instances' WebSocket clients
    await redis.publish(`ws:pub:${workspace}`, frame);
    await publishWsEvent(workspace, frame);
  } catch {
    // Non-fatal — WS delivery is best-effort at this layer
  }
}

async function publishStatusEvent(
  workspace: string,
  contact: string,
  clientRef: string,
  status: string,
): Promise<void> {
  try {
    const redis = getRedis();
    const seq = await redis.incr(`seq:${workspace}`);
    const frame = JSON.stringify({
      seq,
      type: 'message.status',
      contact,
      client_ref: clientRef,
      status,
    });
    await redis.xadd(`stream:${workspace}`, '*', 'seq', String(seq), 'frame', frame);
    await redis.publish(`ws:pub:${workspace}`, frame);
    await publishWsEvent(workspace, frame);
  } catch {
    // Non-fatal
  }
}
