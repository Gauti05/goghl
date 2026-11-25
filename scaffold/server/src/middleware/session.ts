import type { Request, Response, NextFunction } from 'express';
import { getRedis } from '../redis.js';

export interface WorkspaceMembership {
  id: string;
  role: 'admin' | 'agent' | string;
}

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  workspaces: WorkspaceMembership[];
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
    }
  }
}

export const SESSION_COOKIE_NAME = 'sb_sid';

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export async function getSessionUser(cookieHeader: string | undefined): Promise<{ sid: string; user: SessionUser } | null> {
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[SESSION_COOKIE_NAME];
  if (!sid) return null;

  const redis = getRedis();
  const raw = await redis.get(`session:${sid}`);
  if (!raw) return null;

  try {
    const user = JSON.parse(raw) as SessionUser;
    if (!user || !user.sub || !Array.isArray(user.workspaces)) return null;
    return { sid, user };
  } catch {
    return null;
  }
}

export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const session = await getSessionUser(req.headers.cookie);
  if (session) {
    req.user = session.user;
    req.sessionId = session.sid;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function getWorkspaceRole(user: SessionUser, workspace: string): string | null {
  const found = user.workspaces.find((w) => w.id === workspace);
  return found ? found.role : null;
}

export function requireWorkspaceMember(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const workspace = (req.query['workspace'] as string | undefined) ?? (req.body?.['workspace'] as string | undefined);
  if (!workspace || !getWorkspaceRole(req.user, workspace)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
