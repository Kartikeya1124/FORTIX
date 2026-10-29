import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { redisConnection } from '../redis.js';

dotenv.config({ override: true });

const DEV_FALLBACK_JWT_SECRET = 'fortix_local_dev_secret_key_32_characters_minimum_entropy';
const MAX_REVOKED_CACHE_ENTRIES = 5000;

// Bounded in-memory revocation & password-version registries (backed by Redis when available)
const revokedTokenExpiries = new Map<string, number>();
const rotatedPasswordVersions = new Map<string, string>();

let runtimeProductionSecret: string | null = null;

export function getJwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured && configured.length > 0) {
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    if (process.env.STRICT_PRODUCTION_SECRETS === 'true') {
      throw new Error('JWT_SECRET must be set in production');
    }
    if (!runtimeProductionSecret) {
      runtimeProductionSecret = crypto.randomBytes(32).toString('hex');
      process.env.JWT_SECRET = runtimeProductionSecret;
    }
    return runtimeProductionSecret;
  }
  return DEV_FALLBACK_JWT_SECRET;
}

export function computePasswordVersion(passwordHash: string): string {
  return crypto.createHash('sha256').update(passwordHash || '').digest('hex').slice(0, 16);
}

export function hashJwtToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function pruneRevokedTokens(): void {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [digest, expSec] of revokedTokenExpiries.entries()) {
    if (expSec <= nowSec) {
      revokedTokenExpiries.delete(digest);
    }
  }
  if (revokedTokenExpiries.size >= MAX_REVOKED_CACHE_ENTRIES) {
    const oldest = Array.from(revokedTokenExpiries.keys()).slice(0, 500);
    for (const k of oldest) {
      revokedTokenExpiries.delete(k);
    }
  }
}

export async function revokeJwtToken(rawToken: string): Promise<void> {
  if (!rawToken || typeof rawToken !== 'string') return;
  pruneRevokedTokens();

  const digest = hashJwtToken(rawToken);
  const nowSec = Math.floor(Date.now() / 1000);
  let expSec = nowSec + 86400;

  try {
    const decoded = jwt.decode(rawToken) as { exp?: number } | null;
    if (decoded && typeof decoded.exp === 'number' && decoded.exp > nowSec) {
      expSec = decoded.exp;
    }
  } catch {
    // Use default 24h TTL
  }

  revokedTokenExpiries.set(digest, expSec);
  const ttlSeconds = Math.max(1, expSec - nowSec);
  try {
    await redisConnection.set(`fortix:revoked-jwt:${digest}`, '1', 'EX', ttlSeconds);
  } catch {
    // Local in-memory registry still enforces revocation when Redis is degraded
  }
}

export async function isJwtRevoked(rawToken: string): Promise<boolean> {
  const digest = hashJwtToken(rawToken);
  const nowSec = Math.floor(Date.now() / 1000);
  const localExp = revokedTokenExpiries.get(digest);
  if (localExp !== undefined) {
    if (localExp > nowSec) return true;
    revokedTokenExpiries.delete(digest);
  }

  try {
    const inRedis = await redisConnection.get(`fortix:revoked-jwt:${digest}`);
    if (inRedis === '1') {
      revokedTokenExpiries.set(digest, nowSec + 3600);
      return true;
    }
  } catch {
    // Fall back to local check
  }

  return false;
}

export async function recordPasswordRotation(userId: string, newPasswordHash: string): Promise<void> {
  const newVer = computePasswordVersion(newPasswordHash);
  rotatedPasswordVersions.set(userId, newVer);
  try {
    await redisConnection.set(`fortix:pwd-ver:${userId}`, newVer, 'EX', 172800);
  } catch {
    // Local map still tracks rotation
  }
}

export function extractBearerOrFortixToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const headerToken = headers['x-fortix-token'];
  let token: string | undefined = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!token) {
    const authHeader = headers['authorization'];
    const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (authStr && authStr.startsWith('Bearer ')) {
      token = authStr.slice(7).trim();
    }
  }
  return token || undefined;
}

export function extractRequestToken(req: {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}): string | undefined {
  if (req.cookies) {
    if (typeof req.cookies.fortix_session === 'string' && req.cookies.fortix_session.length > 0) {
      return req.cookies.fortix_session;
    }
    if (typeof req.cookies.fortix_token === 'string' && req.cookies.fortix_token.length > 0) {
      return req.cookies.fortix_token;
    }
  }

  const rawCookie = req.headers?.cookie;
  const cookieStr = Array.isArray(rawCookie) ? rawCookie.join('; ') : rawCookie;
  if (cookieStr && typeof cookieStr === 'string') {
    for (const part of cookieStr.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if ((k === 'fortix_session' || k === 'fortix_token') && v) {
        try {
          return decodeURIComponent(v);
        } catch {
          return v;
        }
      }
    }
  }

  return extractBearerOrFortixToken(req.headers || {});
}

export interface VerifiedUserContext {
  id: string;
  email: string;
  role: string;
  emailVerified: boolean;
}

export async function verifyAndResolveJwtUser(rawToken: string): Promise<VerifiedUserContext | null> {
  if (!rawToken || typeof rawToken !== 'string') return null;

  if (await isJwtRevoked(rawToken)) {
    return null;
  }

  let decoded: { id?: string; email?: string; role?: string; pwdVer?: string };
  try {
    decoded = jwt.verify(rawToken, getJwtSecret(), { algorithms: ['HS256'] }) as {
      id?: string;
      email?: string;
      role?: string;
      pwdVer?: string;
    };
  } catch {
    return null;
  }

  if (!decoded || typeof decoded.id !== 'string' || !decoded.id) {
    return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
  if (!user) {
    return null;
  }

  const currentPwdVer = computePasswordVersion(user.passwordHash);

  // If the token carries pwdVer, it must match the user's current password hash
  if (decoded.pwdVer && decoded.pwdVer !== currentPwdVer) {
    return null;
  }

  // If the user explicitly rotated their password, reject any legacy token lacking the current pwdVer
  let rotatedVer = rotatedPasswordVersions.get(user.id);
  if (!rotatedVer) {
    try {
      const redisVer = await redisConnection.get(`fortix:pwd-ver:${user.id}`);
      if (redisVer) {
        rotatedVer = redisVer;
        rotatedPasswordVersions.set(user.id, redisVer);
      }
    } catch {
      // Ignore Redis read failure
    }
  }
  if (rotatedVer && decoded.pwdVer !== currentPwdVer) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    emailVerified: Boolean(user.emailVerified),
  };
}
