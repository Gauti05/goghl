/**
 * Atomic conversation claim, unclaim, and status transitions.
 */
import { getDb } from '../db.js';
import { publishWorkspaceEvent } from './ws.js';

export type ClaimResult = 'claimed' | 'contested';

export async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
): Promise<ClaimResult> {
  const db = await getDb();

  // Ensure conversation exists first
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

  // Atomically claim: only if currently unassigned OR already held by this agent
  const result = await db.collection('conversations').findOneAndUpdate(
    {
      workspace,
      contact,
      $or: [{ assignee: null }, { assignee: agent }],
    },
    { $set: { assignee: agent, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

  if (!result) {
    return 'contested';
  }

  try {
    await publishWorkspaceEvent(workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: agent,
    });
  } catch {
    // Non-fatal
  }

  return 'claimed';
}

export async function unclaimConversation(
  workspace: string,
  contact: string,
  agent: string,
  isAdmin: boolean,
): Promise<boolean> {
  const db = await getDb();
  const filter = isAdmin
    ? { workspace, contact }
    : { workspace, contact, $or: [{ assignee: agent }, { assignee: null }] };

  const result = await db.collection('conversations').findOneAndUpdate(
    filter,
    { $set: { assignee: null, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

  if (!result) return false;

  try {
    await publishWorkspaceEvent(workspace, {
      type: 'conversation.assigned',
      contact,
      assignee: null,
    });
  } catch {
    // Non-fatal
  }

  return true;
}

export async function setConversationStatus(
  workspace: string,
  contact: string,
  status: 'open' | 'closed',
): Promise<void> {
  const db = await getDb();
  await db.collection('conversations').updateOne(
    { workspace, contact },
    { $set: { status, updatedAt: new Date() } },
  );

  try {
    await publishWorkspaceEvent(workspace, {
      type: 'conversation.status',
      contact,
      status,
    });
  } catch {
    // Non-fatal
  }
}
