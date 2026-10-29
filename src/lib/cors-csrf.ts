import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

export const SESSION_COOKIE_NAME = 'fortix_session';
export const LEGACY_SESSION_COOKIE_NAME = 'fortix_token';
export const CSRF_COOKIE_NAME = 'fortix_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export function parseRawCookies(cookieHeader?: string | string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!raw || typeof raw !== 'string') return result;

  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

export function getCookieValue(req: Pick<Request, 'headers'> & { cookies?: Record<string, string> }, name: string): string | undefined {
  if (req.cookies && typeof req.cookies[name] === 'string' && req.cookies[name].length > 0) {
    return req.cookies[name];
  }
  const parsed = parseRawCookies(req.headers?.cookie);
  return parsed[name] || undefined;
}

export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  if (typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  return false;
}

export function resolveCookieSameSite(isHttps: boolean): 'strict' | 'lax' | 'none' {
  const configured = (process.env.COOKIE_SAMESITE || '').trim().toLowerCase();
  if (configured === 'strict' || configured === 'lax') {
    return configured;
  }
  if (configured === 'none') {
    return isHttps ? 'none' : 'lax';
  }
  // Over HTTPS, SameSite=None; Secure works in both top-level tabs and cross-site preview iframes
  // while strict CORS + Double-Submit CSRF + Origin validation protect state-changing operations.
  return isHttps ? 'none' : 'lax';
}

export function issueSessionCookie(req: Request, res: Response, jwtToken: string, maxAgeMs = 24 * 60 * 60 * 1000): void {
  const isHttps = isHttpsRequest(req);
  const sameSite = resolveCookieSameSite(isHttps);

  res.cookie(SESSION_COOKIE_NAME, jwtToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite,
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function issueCsrfCookie(req: Request, res: Response, maxAgeMs = 24 * 60 * 60 * 1000): string {
  const existing = getCookieValue(req as any, CSRF_COOKIE_NAME);
  const csrfToken =
    existing && /^[a-f0-9]{64}$/i.test(existing)
      ? existing
      : crypto.randomBytes(32).toString('hex');

  const isHttps = isHttpsRequest(req);
  const sameSite = resolveCookieSameSite(isHttps);

  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: isHttps,
    sameSite,
    path: '/',
    maxAge: maxAgeMs,
  });

  return csrfToken;
}

export function clearSessionCookies(req: Request, res: Response): void {
  const isHttps = isHttpsRequest(req);
  const sameSite = resolveCookieSameSite(isHttps);
  const opts = {
    secure: isHttps,
    sameSite,
    path: '/',
  } as const;

  res.clearCookie(SESSION_COOKIE_NAME, { ...opts, httpOnly: true });
  res.clearCookie(LEGACY_SESSION_COOKIE_NAME, { ...opts, httpOnly: true });
  res.clearCookie(LEGACY_SESSION_COOKIE_NAME, { path: '/' });
  res.clearCookie(CSRF_COOKIE_NAME, { ...opts, httpOnly: false });
}

export function getConfiguredAllowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  const rawList = [process.env.ALLOWED_ORIGINS, process.env.APP_URL, process.env.PUBLIC_APP_URL]
    .filter(Boolean)
    .join(',');

  for (const item of rawList.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      allowed.add(u.origin.toLowerCase());
    } catch {
      // Ignore malformed origin entries
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://localhost:3000');
    allowed.add('http://127.0.0.1:3000');
    allowed.add('http://localhost:5173');
    allowed.add('http://127.0.0.1:5173');
  }

  return allowed;
}

export function resolveRequestHost(req?: Pick<Request, 'headers'>): string | undefined {
  if (!req?.headers) return undefined;
  const xfHost = req.headers['x-forwarded-host'];
  const hostHeader = (Array.isArray(xfHost) ? xfHost[0] : xfHost) || req.headers.host;
  if (!hostHeader || typeof hostHeader !== 'string') return undefined;
  return hostHeader.split(',')[0].trim().toLowerCase();
}

export function isOriginAllowed(origin: string | undefined, requestHost?: string): boolean {
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const normalizedOrigin = parsed.origin.toLowerCase();
  if (requestHost && parsed.host.toLowerCase() === requestHost.toLowerCase()) {
    return true;
  }

  const allowed = getConfiguredAllowedOrigins();
  return allowed.has(normalizedOrigin);
}

function timingSafeMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const CSRF_EXEMPT_PUBLIC_AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/verify-email',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfProtectionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  const reqHost = resolveRequestHost(req);
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

  // Always block cross-origin state-changing requests from untrusted Origin headers
  if (originHeader && !isOriginAllowed(originHeader, reqHost)) {
    res.status(403).json({
      error: 'Forbidden: Cross-origin request from untrusted origin blocked',
      code: 'CSRF_ORIGIN_DENIED',
    });
    return;
  }

  const normalizedPath = (req.originalUrl || req.url || '').split('?')[0];
  if (CSRF_EXEMPT_PUBLIC_AUTH_PATHS.has(normalizedPath)) {
    return next();
  }

  // Programmatic API clients using explicit Authorization: Bearer or X-Fortix-Token headers
  // are not subject to browser ambient-cookie CSRF.
  const hasExplicitHeaderAuth =
    (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) ||
    (typeof req.headers['x-fortix-token'] === 'string' && req.headers['x-fortix-token'].length > 0);

  if (hasExplicitHeaderAuth) {
    return next();
  }

  // If the request carries a session cookie, strictly enforce Double-Submit CSRF token validation
  const sessionCookie =
    getCookieValue(req as any, SESSION_COOKIE_NAME) ||
    getCookieValue(req as any, LEGACY_SESSION_COOKIE_NAME);

  if (!sessionCookie) {
    return next();
  }

  const csrfCookie = getCookieValue(req as any, CSRF_COOKIE_NAME);
  const rawHeader = req.headers[CSRF_HEADER_NAME];
  const csrfHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!csrfCookie || !csrfHeader || typeof csrfHeader !== 'string' || !timingSafeMatch(csrfCookie, csrfHeader)) {
    res.status(403).json({
      error: 'CSRF token missing or invalid. Reload the page and retry.',
      code: 'CSRF_TOKEN_INVALID',
    });
    return;
  }

  next();
}
