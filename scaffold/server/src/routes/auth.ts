import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import { SESSION_COOKIE_NAME, type SessionUser } from '../middleware/session.js';

export const authRouter = Router();

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
}

let cachedDiscovery: { issuer: string; doc: OidcDiscovery } | null = null;

async function getDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery && cachedDiscovery.issuer === config.oidc.issuer) {
    return cachedDiscovery.doc;
  }
  const url = `${config.oidc.issuer}/.well-known/openid-configuration`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) {
    throw new Error(`OIDC discovery failed: ${resp.status}`);
  }
  const doc = (await resp.json()) as OidcDiscovery;
  cachedDiscovery = { issuer: config.oidc.issuer, doc };
  return doc;
}

function resolveRedirectUri(req: Request): string {
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  if (host.includes(':5173')) {
    return 'http://localhost:5173/auth/callback';
  }
  if (host.includes(':3000')) {
    return 'http://localhost:3000/auth/callback';
  }
  return config.oidc.redirectUri;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── GET /auth/login ──────────────────────────────────────────────────────────
authRouter.get('/login', async (req: Request, res: Response) => {
  const discovery = await getDiscovery();

  const state = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const redirectUri = resolveRedirectUri(req);

  const redis = getRedis();
  await redis.set(
    `oidc:state:${state}`,
    JSON.stringify({ codeVerifier, redirectUri }),
    'EX',
    600,
  );

  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set('client_id', config.oidc.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  res.redirect(302, authUrl.toString());
});

// ─── GET /auth/callback ───────────────────────────────────────────────────────
authRouter.get('/callback', async (req: Request, res: Response) => {
  const code = req.query['code'] as string | undefined;
  const state = req.query['state'] as string | undefined;

  if (!code || !state) {
    res.status(400).json({ error: 'missing code or state' });
    return;
  }

  const redis = getRedis();
  const stateKey = `oidc:state:${state}`;
  const rawState = await redis.get(stateKey);
  await redis.del(stateKey);

  if (!rawState) {
    res.status(400).json({ error: 'invalid or expired state' });
    return;
  }

  const { codeVerifier, redirectUri } = JSON.parse(rawState) as {
    codeVerifier: string;
    redirectUri: string;
  };

  const discovery = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
  });

  const tokenResp = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(5000),
  });

  if (!tokenResp.ok) {
    const errText = await tokenResp.text().catch(() => '');
    res.status(401).json({ error: 'token exchange failed', detail: errText });
    return;
  }

  const tokenData = (await tokenResp.json()) as {
    access_token?: string;
    id_token?: string;
  };

  let claims = tokenData.id_token ? decodeJwtPayload(tokenData.id_token) : null;
  if ((!claims || !claims['sub']) && tokenData.access_token && discovery.userinfo_endpoint) {
    const uiResp = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (uiResp.ok) {
      claims = (await uiResp.json()) as Record<string, unknown>;
    }
  }

  if (!claims || typeof claims['sub'] !== 'string') {
    res.status(401).json({ error: 'missing user claims' });
    return;
  }

  const user: SessionUser = {
    sub: claims['sub'],
    email: typeof claims['email'] === 'string' ? claims['email'] : '',
    name: typeof claims['name'] === 'string' ? claims['name'] : claims['sub'],
    workspaces: Array.isArray(claims['workspaces'])
      ? (claims['workspaces'] as SessionUser['workspaces'])
      : [],
  };

  const sid = crypto.randomBytes(24).toString('base64url');
  await redis.set(`session:${sid}`, JSON.stringify(user), 'EX', 86400);

  res.cookie(SESSION_COOKIE_NAME, sid, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    maxAge: 86400 * 1000,
  });

  res.redirect(302, '/');
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
authRouter.post('/logout', async (req: Request, res: Response) => {
  if (req.sessionId) {
    await getRedis().del(`session:${req.sessionId}`);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.status(200).json({ ok: true });
});
