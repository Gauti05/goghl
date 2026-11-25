import { MongoClient, type Db } from 'mongodb';
import { config } from './config.js';

let client: MongoClient | undefined;
let _db: Db | undefined;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
    _db = client.db();
    await ensureIndexes(_db);
  }
  return _db!;
}

async function ensureIndexes(db: Db): Promise<void> {
  // events — deduplicate Pigeon event IDs
  await db.collection('events').createIndex({ eventId: 1 }, { unique: true });

  // messages — deduplicate by Pigeon message_id; query by workspace+contact+occurredAt
  await db.collection('messages').createIndex({ messageId: 1 }, { unique: true });
  await db.collection('messages').createIndex({ workspace: 1, contact: 1, occurredAt: 1 });

  // conversations — one per (workspace, contact)
  await db.collection('conversations').createIndex(
    { workspace: 1, contact: 1 },
    { unique: true },
  );
  await db.collection('conversations').createIndex({ workspace: 1, updatedAt: -1 });

  // outbound — deduplicate by clientRef; query by status for the worker
  await db.collection('outbound').createIndex({ clientRef: 1 }, { unique: true });
  await db.collection('outbound').createIndex({ status: 1, nextAttemptAt: 1 });
  await db.collection('outbound').createIndex({ workspace: 1, status: 1 });
}
