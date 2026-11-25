import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getDb } from '../db.js';
import { KNOWN_WORKSPACES } from '../config.js';
import { requireAuth, requireWorkspaceMember, getWorkspaceRole } from '../middleware/session.js';
import { claimConversation, unclaimConversation, setConversationStatus } from '../lib/conversations.js';
import { enqueueReply, OutboxError } from '../lib/outbox.js';

export const apiRouter = Router();

// ─── GET /api/me ──────────────────────────────────────────────────────────────
apiRouter.get('/me', requireAuth, (req: Request, res: Response) => {
  const { sub, email, name, workspaces } = req.user!;
  res.status(200).json({ sub, email, name, workspaces });
});

// ─── GET /api/conversations?workspace=<id> ────────────────────────────────────
apiRouter.get('/conversations', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = req.query['workspace'] as string;
  const page = Math.max(1, Number(req.query['page'] ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query['limit'] ?? 50) || 50));
  const skip = (page - 1) * limit;

  const db = await getDb();
  const [conversations, total] = await Promise.all([
    db
      .collection('conversations')
      .find({ workspace })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    db.collection('conversations').countDocuments({ workspace }),
  ]);

  const items = await Promise.all(
    conversations.map(async (conv) => {
      const contact = conv['contact'] as string;
      const [lastInbound, lastOutbound] = await Promise.all([
        db
          .collection('messages')
          .find({ workspace, contact })
          .sort({ occurredAt: -1 })
          .limit(1)
          .toArray(),
        db
          .collection('outbound')
          .find({ workspace, contact })
          .sort({ createdAt: -1 })
          .limit(1)
          .toArray(),
      ]);

      const inMsg = lastInbound[0];
      const outMsg = lastOutbound[0];
      const inTime = inMsg ? new Date(inMsg['occurredAt'] as Date).getTime() : 0;
      const outTime = outMsg ? new Date(outMsg['createdAt'] as Date).getTime() : 0;

      let lastMessage: { text: string; direction: string; at: Date } | null = null;
      if (inTime >= outTime && inMsg) {
        lastMessage = {
          text: (inMsg['text'] as string) ?? '',
          direction: 'inbound',
          at: inMsg['occurredAt'] as Date,
        };
      } else if (outMsg) {
        lastMessage = {
          text: (outMsg['text'] as string) ?? '',
          direction: 'outbound',
          at: outMsg['createdAt'] as Date,
        };
      }

      return {
        workspace,
        contact,
        assignee: (conv['assignee'] as string | null) ?? null,
        status: (conv['status'] as string) ?? 'open',
        updatedAt: conv['updatedAt'],
        lastMessage,
      };
    }),
  );

  res.status(200).json({ conversations: items, page, limit, total });
});

// ─── GET /api/conversations/:contact?workspace=<id> ───────────────────────────
apiRouter.get('/conversations/:contact', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = req.query['workspace'] as string;
  const contact = decodeURIComponent(String(req.params['contact']));

  const db = await getDb();
  const [conv, inbound, outbound, notes] = await Promise.all([
    db.collection('conversations').findOne({ workspace, contact }),
    db.collection('messages').find({ workspace, contact }).sort({ occurredAt: 1 }).toArray(),
    db.collection('outbound').find({ workspace, contact }).sort({ createdAt: 1 }).toArray(),
    db.collection('notes').find({ workspace, contact }).sort({ createdAt: 1 }).toArray(),
  ]);

  if (!conv) {
    res.status(404).json({ error: 'conversation not found' });
    return;
  }

  const timeline = [
    ...inbound.map((m) => ({
      id: m['messageId'] as string,
      direction: 'inbound' as const,
      text: m['text'] as string,
      timestamp: new Date(m['occurredAt'] as Date).toISOString(),
    })),
    ...outbound.map((o) => ({
      id: o['clientRef'] as string,
      client_ref: o['clientRef'] as string,
      direction: 'outbound' as const,
      text: o['text'] as string,
      status: o['status'] as string,
      timestamp: new Date(o['createdAt'] as Date).toISOString(),
    })),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  res.status(200).json({
    conversation: {
      workspace,
      contact,
      assignee: (conv['assignee'] as string | null) ?? null,
      status: (conv['status'] as string) ?? 'open',
      updatedAt: conv['updatedAt'],
    },
    messages: timeline,
    notes: notes.map((n) => ({
      id: n['id'],
      authorSub: n['authorSub'],
      ciphertext: n['ciphertext'],
      iv: n['iv'],
      createdAt: n['createdAt'],
    })),
  });
});

// ─── POST /api/conversations/:contact/claim?workspace=<id> ────────────────────
apiRouter.post('/conversations/:contact/claim', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));

  const result = await claimConversation(workspace, contact, req.user!.sub);
  if (result === 'claimed') {
    res.status(200).json({ ok: true, assignee: req.user!.sub });
  } else {
    res.status(409).json({ error: 'conversation held by another agent' });
  }
});

// ─── POST /api/conversations/:contact/unclaim?workspace=<id> ──────────────────
apiRouter.post('/conversations/:contact/unclaim', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));
  const isAdmin = getWorkspaceRole(req.user!, workspace) === 'admin';

  const ok = await unclaimConversation(workspace, contact, req.user!.sub, isAdmin);
  if (ok) {
    res.status(200).json({ ok: true, assignee: null });
  } else {
    res.status(409).json({ error: 'cannot unclaim conversation held by another agent' });
  }
});

// ─── POST /api/conversations/:contact/close?workspace=<id> ────────────────────
apiRouter.post('/conversations/:contact/close', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));
  await setConversationStatus(workspace, contact, 'closed');
  res.status(200).json({ ok: true, status: 'closed' });
});

// ─── POST /api/conversations/:contact/reopen?workspace=<id> ───────────────────
apiRouter.post('/conversations/:contact/reopen', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));
  await setConversationStatus(workspace, contact, 'open');
  res.status(200).json({ ok: true, status: 'open' });
});

// ─── POST /api/conversations/:contact/reply?workspace=<id> ────────────────────
apiRouter.post('/conversations/:contact/reply', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));
  const { text, client_ref } = req.body as { text?: string; client_ref?: string };

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  if (!KNOWN_WORKSPACES.has(workspace)) {
    res.status(400).json({ error: `Unknown workspace: ${workspace}` });
    return;
  }

  const ref = client_ref && typeof client_ref === 'string' ? client_ref : `cr_${crypto.randomUUID()}`;

  try {
    await enqueueReply({ workspace, contact, text: text.trim(), client_ref: ref });
    res.status(202).json({ ok: true, client_ref: ref });
  } catch (err) {
    if (err instanceof OutboxError) {
      res.status(err.statusCode).json({ error: err.message });
    } else {
      throw err;
    }
  }
});

// ─── POST /api/conversations/:contact/notes?workspace=<id> ────────────────────
apiRouter.post('/conversations/:contact/notes', requireWorkspaceMember, async (req: Request, res: Response) => {
  const workspace = (req.query['workspace'] as string) ?? (req.body?.['workspace'] as string);
  const contact = decodeURIComponent(String(req.params['contact']));
  const { ciphertext, iv } = req.body as { ciphertext?: string; iv?: string };

  if (!ciphertext || !iv || typeof ciphertext !== 'string' || typeof iv !== 'string') {
    res.status(400).json({ error: 'ciphertext and iv are required' });
    return;
  }

  const db = await getDb();
  const note = {
    id: `note_${crypto.randomUUID()}`,
    workspace,
    contact,
    authorSub: req.user!.sub,
    ciphertext,
    iv,
    createdAt: new Date(),
  };

  await db.collection('notes').insertOne(note);
  res.status(201).json({
    id: note.id,
    authorSub: note.authorSub,
    ciphertext: note.ciphertext,
    iv: note.iv,
    createdAt: note.createdAt,
  });
});
