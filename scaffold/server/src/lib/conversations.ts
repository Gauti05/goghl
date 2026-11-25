/**
 * Atomic conversation claim.
 *
 * Returns 'claimed' if the agent now holds the conversation,
 * 'contested' if another agent holds it.
 */
import { getDb } from '../db.js';
import { getRedis } from '../redis.js';
import { publishWsEvent } from './ws.js';

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

  // Publish assignment event
  try {
    const redis = getRedis();
    const seq = await redis.incr(`seq:${workspace}`);
    const frame = JSON.stringify({
      seq,
      type: 'conversation.assigned',
      contact,
      assignee: agent,
    });
    await redis.xadd(`stream:${workspace}`, '*', 'seq', String(seq), 'frame', frame);
    await redis.publish(`ws:pub:${workspace}`, frame);
    await publishWsEvent(workspace, frame);
  } catch {
    // Non-fatal
  }

  return 'claimed';
}
