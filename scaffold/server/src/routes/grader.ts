import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { config, KNOWN_WORKSPACES } from '../config.js';
import { enqueueReply, OutboxError } from '../lib/outbox.js';
import { claimConversation } from '../lib/conversations.js';

export const graderRouter = Router();

// ─── Auth middleware for all grader routes ───────────────────────────────────
graderRouter.use((req: Request, res: Response, next) => {
  const token = req.headers['x-grader-token'];
  if (!token || token !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

// ─── POST /__grader/reset ─────────────────────────────────────────────────────
graderRouter.post('/reset', async (_req: Request, res: Response) => {
  const db = await getDb();
  const redis = getRedis();

  // Delete all application data from MongoDB
  await Promise.all([
    db.collection('events').deleteMany({}),
    db.collection('messages').deleteMany({}),
    db.collection('outbound').deleteMany({}),
    db.collection('conversations').deleteMany({}),
  ]);

  // Delete application keys from Redis (keep session keys)
  const patterns = ['seq:*', 'stream:*', 'rate:*', 'cooloff:*', 'ws:pub:*', 'claim:*'];
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  res.status(200).json({ ok: true });
});

// ─── GET /__grader/snapshot ───────────────────────────────────────────────────
graderRouter.get('/snapshot', async (_req: Request, res: Response) => {
  const db = await getDb();

  // Build the snapshot shape required by BRIEF.md
  const workspaces: Record<string, {
    contacts: Record<string, { inbound: string[]; assignee: string | null }>;
    outbound: Record<string, string>;
  }> = {};

  // Initialise known workspaces
  for (const ws of KNOWN_WORKSPACES) {
    workspaces[ws] = { contacts: {}, outbound: {} };
  }

  // Load all conversations
  const conversations = await db.collection('conversations').find({}).toArray();
  for (const conv of conversations) {
    const ws = conv['workspace'] as string;
    const contact = conv['contact'] as string;
    if (!workspaces[ws]) workspaces[ws] = { contacts: {}, outbound: {} };
    workspaces[ws]!.contacts[contact] = {
      inbound: [],
      assignee: (conv['assignee'] as string | null) ?? null,
    };
  }

  // Load all inbound messages, ordered by occurredAt ascending (oldest first)
  const messages = await db
    .collection('messages')
    .find({ direction: 'inbound' })
    .sort({ occurredAt: 1 })
    .toArray();

  for (const msg of messages) {
    const ws = msg['workspace'] as string;
    const contact = msg['contact'] as string;
    const messageId = msg['messageId'] as string;
    if (!workspaces[ws]) workspaces[ws] = { contacts: {}, outbound: {} };
    if (!workspaces[ws]!.contacts[contact]) {
      workspaces[ws]!.contacts[contact] = { inbound: [], assignee: null };
    }
    workspaces[ws]!.contacts[contact]!.inbound.push(messageId);
  }

  // Load all outbound messages
  const outbound = await db.collection('outbound').find({}).toArray();
  for (const ob of outbound) {
    const ws = ob['workspace'] as string;
    const clientRef = ob['clientRef'] as string;
    const status = ob['status'] as string;
    if (!workspaces[ws]) workspaces[ws] = { contacts: {}, outbound: {} };
    workspaces[ws]!.outbound[clientRef] = status;
  }

  res.status(200).json({ workspaces });
});

// ─── POST /__grader/reply ─────────────────────────────────────────────────────
graderRouter.post('/reply', async (req: Request, res: Response) => {
  const { workspace, contact, text, client_ref } = req.body as {
    workspace?: string;
    contact?: string;
    text?: string;
    client_ref?: string;
  };

  if (!workspace || !contact || !text || !client_ref) {
    res.status(400).json({ error: 'workspace, contact, text, and client_ref are required' });
    return;
  }

  try {
    await enqueueReply({ workspace, contact, text, client_ref });
    res.status(202).json({ ok: true });
  } catch (err) {
    if (err instanceof OutboxError) {
      res.status(err.statusCode).json({ error: err.message });
    } else {
      throw err;
    }
  }
});

// ─── POST /__grader/claim ─────────────────────────────────────────────────────
graderRouter.post('/claim', async (req: Request, res: Response) => {
  const { workspace, contact, agent } = req.body as {
    workspace?: string;
    contact?: string;
    agent?: string;
  };

  if (!workspace || !contact || !agent) {
    res.status(400).json({ error: 'workspace, contact, and agent are required' });
    return;
  }

  if (!KNOWN_WORKSPACES.has(workspace)) {
    res.status(400).json({ error: `Unknown workspace: ${workspace}` });
    return;
  }

  const result = await claimConversation(workspace, contact, agent);

  if (result === 'claimed') {
    res.status(200).json({ ok: true });
  } else {
    res.status(409).json({ error: 'conversation held by another agent' });
  }
});
