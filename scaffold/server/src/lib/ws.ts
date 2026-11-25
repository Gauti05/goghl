/**
 * WebSocket server and Redis pub/sub fan-out.
 *
 * - Authenticates upgrade requests via the Redis session cookie and checks
 *   workspace membership (401 / 403 before upgrade).
 * - Awaits Redis `psubscribe('ws:pub:*')` before upgrading any socket.
 * - Uses Redis INCR `seq:{workspace}` + ZADD `events:{workspace}` + PUBLISH `ws:pub:{workspace}`
 *   so all server copies share monotonic sequence numbers and replay history.
 * - On connection with `?after=N`, registers synchronously and buffers live messages
 *   while reading history from `events:{workspace}`, then flushes without gaps or duplicates.
 */
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { getRedis, getSubRedis } from '../redis.js';
import { getSessionUser, getWorkspaceRole } from '../middleware/session.js';

interface ClientState {
  ws: WebSocket;
  workspace: string;
  ready: boolean;
  buffer: Array<{ seq: number; raw: string }>;
  lastSentSeq: number;
}

const rooms = new Map<string, Set<ClientState>>();

function joinRoom(client: ClientState): void {
  let set = rooms.get(client.workspace);
  if (!set) {
    set = new Set();
    rooms.set(client.workspace, set);
  }
  set.add(client);
}

function leaveRoom(client: ClientState): void {
  const set = rooms.get(client.workspace);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) rooms.delete(client.workspace);
}

export async function publishWorkspaceEvent(
  workspace: string,
  frameWithoutSeq: Record<string, unknown>,
): Promise<number> {
  const redis = getRedis();
  const seq = await redis.incr(`seq:${workspace}`);
  const json = JSON.stringify({ seq, ...frameWithoutSeq });
  await redis.zadd(`events:${workspace}`, seq, json);
  await redis.publish(`ws:pub:${workspace}`, json);
  return seq;
}

export function attachWss(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  const sub = getSubRedis();
  const subReady = sub.psubscribe('ws:pub:*').catch((err) => {
    console.error('Redis psubscribe error:', err);
  });

  sub.on('pmessage', (_pattern, channel, message) => {
    const workspace = channel.slice('ws:pub:'.length);
    const clients = rooms.get(workspace);
    if (!clients || clients.size === 0) return;

    let seq = 0;
    try {
      const parsed = JSON.parse(message) as { seq?: number };
      seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
    } catch {
      return;
    }

    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (!client.ready) {
        client.buffer.push({ seq, raw: message });
      } else if (seq > client.lastSentSeq) {
        client.ws.send(message, { binary: false });
        client.lastSentSeq = seq;
      }
    }
  });

  wss.on('connection', (ws, req: IncomingMessage & { sbWorkspace?: string; sbAfter?: number }) => {
    const workspace = req.sbWorkspace!;
    const after = req.sbAfter;

    const client: ClientState = {
      ws,
      workspace,
      ready: after === undefined,
      buffer: [],
      lastSentSeq: after ?? 0,
    };

    // Register synchronously so no live messages are missed
    joinRoom(client);
    ws.on('close', () => leaveRoom(client));
    ws.on('error', () => leaveRoom(client));

    if (after !== undefined) {
      void (async () => {
        try {
          const redis = getRedis();
          const history = await redis.zrangebyscore(`events:${workspace}`, `(${after}`, '+inf');
          for (const raw of history) {
            if (ws.readyState !== WebSocket.OPEN) break;
            try {
              const parsed = JSON.parse(raw) as { seq?: number };
              const seq = typeof parsed.seq === 'number' ? parsed.seq : 0;
              if (seq > client.lastSentSeq) {
                ws.send(raw, { binary: false });
                client.lastSentSeq = seq;
              }
            } catch {
              // ignore malformed
            }
          }

          for (const item of client.buffer) {
            if (ws.readyState !== WebSocket.OPEN) break;
            if (item.seq > client.lastSentSeq) {
              ws.send(item.raw, { binary: false });
              client.lastSentSeq = item.seq;
            }
          }
        } catch (err) {
          console.error('WS connection replay error:', err);
        } finally {
          client.buffer = [];
          client.ready = true;
        }
      })();
    }
  });

  httpServer.on('upgrade', async (req: IncomingMessage & { sbWorkspace?: string; sbAfter?: number }, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace') ?? '';
      const afterParam = url.searchParams.get('after');
      const after = afterParam !== null && afterParam !== '' ? Number(afterParam) : undefined;

      const session = await getSessionUser(req.headers.cookie);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!workspace || !getWorkspaceRole(session.user, workspace)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      await subReady;

      req.sbWorkspace = workspace;
      req.sbAfter = after !== undefined && Number.isFinite(after) ? after : undefined;

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}
