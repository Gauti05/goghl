import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { config, KNOWN_WORKSPACES } from '../config.js';
import { publishWorkspaceEvent } from '../lib/ws.js';
import { verifyPigeonSignature } from '../lib/pigeonSig.js';
import { STATUS_RANK, getStatusesBelowRank } from '../lib/statusRank.js';

export const webhookRouter = Router();

// ─── POST /webhooks/pigeon ────────────────────────────────────────────────────
// MUST be mounted with express.raw({ type: '*/*' }) BEFORE global json middleware.
webhookRouter.post('/webhooks/pigeon', async (req: Request, res: Response) => {
  const rawBody = req.body as Buffer;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(401).json({ error: 'no raw body' });
    return;
  }

  const sigCheck = verifyPigeonSignature(
    req.headers['x-pigeon-signature'],
    rawBody,
    config.pigeon.webhookSecret,
  );
  if (!sigCheck.ok) {
    res.status(401).json({ error: sigCheck.reason });
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

  // 8. Fast-path check if event.id was already fully processed
  const existingEvent = await db.collection('events').findOne({ eventId });
  if (existingEvent) {
    res.status(200).json({ ok: true });
    return;
  }

  // 9. Process event first, then record event.id so a mid-request crash never
  //    causes Pigeon's retry to be falsely skipped as a duplicate.
  if (eventType === 'message.inbound') {
    await handleInbound(db, event, eventId, workspace, res);
  } else if (eventType === 'message.status') {
    await handleStatus(db, event, eventId, workspace, res);
  } else {
    await recordEvent(db, eventId, eventType, workspace);
    res.status(200).json({ ok: true });
  }
});

async function recordEvent(
  db: Awaited<ReturnType<typeof getDb>>,
  eventId: string,
  type: string,
  workspace: string,
): Promise<void> {
  try {
    await db.collection('events').insertOne({
      eventId,
      type,
      workspace,
      processedAt: new Date(),
    });
  } catch (err: unknown) {
    if (!isDuplicateKeyError(err)) throw err;
  }
}

// ─── Inbound message ─────────────────────────────────────────────────────────
async function handleInbound(
  db: Awaited<ReturnType<typeof getDb>>,
  event: Record<string, unknown>,
  eventId: string,
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
  let isNewMessage = true;
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
      isNewMessage = false;
    } else {
      throw err;
    }
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

  // Publish WebSocket event to all instances (only for newly stored messages)
  if (isNewMessage) {
    try {
      await publishWorkspaceEvent(workspace, {
        type: 'message.inbound',
        contact: from,
        message_id: messageId,
        text: text ?? '',
        occurred_at: occurredAt.toISOString(),
      });
    } catch {
      // Non-fatal
    }
  }

  await recordEvent(db, eventId, 'message.inbound', workspace);
  res.status(200).json({ ok: true });
}

// ─── Status update ───────────────────────────────────────────────────────────
async function handleStatus(
  db: Awaited<ReturnType<typeof getDb>>,
  event: Record<string, unknown>,
  eventId: string,
  workspace: string,
  res: Response,
): Promise<void> {
  const data = event['data'] as Record<string, unknown> | undefined;
  if (!data) {
    await recordEvent(db, eventId, 'message.status', workspace);
    res.status(200).json({ ok: true });
    return;
  }

  const clientRef = data['client_ref'] as string | undefined;
  const newStatus = data['status'] as string | undefined;

  if (!clientRef || !newStatus) {
    await recordEvent(db, eventId, 'message.status', workspace);
    res.status(200).json({ ok: true });
    return;
  }

  const newRank = STATUS_RANK[newStatus];
  if (newRank === undefined) {
    await recordEvent(db, eventId, 'message.status', workspace);
    res.status(200).json({ ok: true });
    return;
  }

  // Find existing outbound record
  const outbound = await db.collection('outbound').findOne({ clientRef });
  if (!outbound) {
    await recordEvent(db, eventId, 'message.status', workspace);
    res.status(200).json({ ok: true });
    return;
  }

  const currentRank = STATUS_RANK[outbound['status'] as string] ?? 0;

  // Only upgrade if new status has higher rank (never downgrade)
  if (newRank > currentRank) {
    const upd = await db.collection('outbound').updateOne(
      { clientRef, status: { $in: getStatusesBelowRank(newRank) } },
      { $set: { status: newStatus, updatedAt: new Date() } },
    );

    if (upd.modifiedCount > 0) {
      try {
        await publishWorkspaceEvent(workspace, {
          type: 'message.status',
          contact: outbound['contact'] as string,
          client_ref: clientRef,
          status: newStatus,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  await recordEvent(db, eventId, 'message.status', workspace);
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
