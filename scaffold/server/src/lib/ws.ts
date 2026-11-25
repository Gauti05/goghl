/**
 * WebSocket server and Redis pub/sub fan-out.
 *
 * All WS-connected clients in a workspace receive every frame published to
 * `ws:pub:{workspace}` via Redis, so instances don't need to know about each other.
 */
import { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { getRedis, getSubRedis } from '../redis.js';

// Local registry: workspace -> Set of live WebSocket clients
const rooms = new Map<string, Set<WebSocket>>();

/** Add a client to a workspace room. */
function joinRoom(workspace: string, ws: WebSocket): void {
  if (!rooms.has(workspace)) rooms.set(workspace, new Set());
  rooms.get(workspace)!.add(ws);
}

/** Remove a client from all rooms. */
function leaveRooms(ws: WebSocket): void {
  for (const [, clients] of rooms) clients.delete(ws);
}

/** Publish a pre-serialised frame to this instance's local WS clients. */
export function publishWsEvent(workspace: string, frame: string): Promise<void> {
  const clients = rooms.get(workspace);
  if (!clients) return Promise.resolve();
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
    }
  }
  return Promise.resolve();
}

/**
 * Attach the WebSocket server to an existing HTTP server.
 * Also subscribes to Redis pub/sub for cross-instance fan-out.
 *
 * Authentication / workspace membership is validated by the caller before
 * this function (see index.ts upgrade handler).
 */
export function attachWss(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // Subscribe to all workspace pub/sub channels
  const sub = getSubRedis();
  sub.psubscribe('ws:pub:*', (err) => {
    if (err) console.error('Redis psubscribe error:', err);
  });
  sub.on('pmessage', (_pattern, channel, message) => {
    const workspace = channel.replace('ws:pub:', '');
    const clients = rooms.get(workspace);
    if (!clients) return;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  });

  wss.on('connection', (ws, req: IncomingMessage & { sbWorkspace?: string; sbAfter?: number }) => {
    const workspace = req.sbWorkspace!;
    const after = req.sbAfter;

    joinRoom(workspace, ws);
    ws.on('close', () => leaveRooms(ws));
    ws.on('error', () => leaveRooms(ws));

    // Replay missed events if `after` param provided
    if (after !== undefined) {
      void replayEvents(workspace, after, ws);
    }
  });

  httpServer.on('upgrade', (req: IncomingMessage & { sbWorkspace?: string; sbAfter?: number }, socket, head) => {
    if (!req.sbWorkspace) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  return wss;
}

/** Send all stored events with seq > after to this specific client. */
async function replayEvents(workspace: string, after: number, ws: WebSocket): Promise<void> {
  const redis = getRedis();
  try {
    // Scan the stream for frames with seq > after
    const entries = await redis.xrange(`stream:${workspace}`, '-', '+');
    for (const [, fields] of entries) {
      const seqIdx = fields.indexOf('seq');
      const frameIdx = fields.indexOf('frame');
      if (seqIdx === -1 || frameIdx === -1) continue;
      const seq = parseInt(fields[seqIdx + 1]!, 10);
      if (seq > after) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(fields[frameIdx + 1]);
        }
      }
    }
  } catch (err) {
    console.error('replayEvents error:', err);
  }
}
