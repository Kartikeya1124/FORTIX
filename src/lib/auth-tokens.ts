import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { authActionTokens } from '../db/schema.js';
import { logger } from './logger.js';

export type AuthTokenPurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFICATION';

const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Bounded in-memory dev/test outbox for local verification without external SMTP
interface DevOutboxEntry {
  to: string;
  purpose: AuthTokenPurpose;
  token: string;
  expiresAt: string;
  createdAt: string;
}

const devMailOutbox: DevOutboxEntry[] = [];

export function hashActionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export async function issueAuthActionToken(
  userId: string,
  email: string,
  purpose: AuthTokenPurpose,
  customTtlMs?: number
): Promise<{ rawToken: string; expiresAt: Date }> {
  const ttlMs =
    typeof customTtlMs === 'number'
      ? customTtlMs
      : purpose === 'PASSWORD_RESET'
        ? PASSWORD_RESET_TTL_MS
        : EMAIL_VERIFY_TTL_MS;

  // Invalidate any previous unused tokens for this user + purpose
  await db
    .update(authActionTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(authActionTokens.userId, userId),
        eq(authActionTokens.purpose, purpose),
        isNull(authActionTokens.usedAt)
      )
    );

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashActionToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(authActionTokens).values({
    id: uuidv4(),
    userId,
    purpose,
    tokenHash,
    expiresAt,
  });

  await deliverAuthNotification(email, purpose, rawToken, expiresAt);

  return { rawToken, expiresAt };
}

export async function consumeAuthActionToken(
  rawToken: string,
  expectedPurpose: AuthTokenPurpose
): Promise<{ valid: boolean; userId?: string; reason?: string }> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 256) {
    return { valid: false, reason: 'Invalid or expired token' };
  }

  const tokenHash = hashActionToken(rawToken.trim());
  const [record] = await db
    .select()
    .from(authActionTokens)
    .where(and(eq(authActionTokens.tokenHash, tokenHash), eq(authActionTokens.purpose, expectedPurpose)))
    .limit(1);

  if (!record) {
    return { valid: false, reason: 'Invalid or expired token' };
  }

  if (record.usedAt !== null) {
    return { valid: false, reason: 'Token has already been used' };
  }

  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    return { valid: false, reason: 'Token has expired' };
  }

  await db
    .update(authActionTokens)
    .set({ usedAt: new Date() })
    .where(eq(authActionTokens.id, record.id));

  return { valid: true, userId: record.userId };
}

async function deliverAuthNotification(
  to: string,
  purpose: AuthTokenPurpose,
  rawToken: string,
  expiresAt: Date
): Promise<void> {
  // Optional external transactional mail webhook (never logs rawToken)
  const mailWebhookUrl = process.env.AUTH_MAIL_WEBHOOK_URL;
  if (mailWebhookUrl) {
    try {
      await fetch(mailWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.AUTH_MAIL_WEBHOOK_SECRET
            ? { Authorization: `Bearer ${process.env.AUTH_MAIL_WEBHOOK_SECRET}` }
            : {}),
        },
        body: JSON.stringify({
          to,
          purpose,
          token: rawToken,
          expiresAt: expiresAt.toISOString(),
        }),
      });
      logger.info({ purpose }, '[AuthMailer] Transactional auth notification dispatched');
      return;
    } catch (err: any) {
      logger.error({ purpose, error: err?.message }, '[AuthMailer] Transactional mail webhook delivery failed');
    }
  }

  // Record in local dev/test outbox ONLY outside production
  if (process.env.NODE_ENV !== 'production') {
    devMailOutbox.push({
      to: to.toLowerCase(),
      purpose,
      token: rawToken,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    });
    if (devMailOutbox.length > 200) {
      devMailOutbox.splice(0, devMailOutbox.length - 200);
    }
  }
}

export function getLatestDevOutboxToken(email: string, purpose: AuthTokenPurpose): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const normalized = email.trim().toLowerCase();
  for (let i = devMailOutbox.length - 1; i >= 0; i--) {
    const item = devMailOutbox[i];
    if (item.to === normalized && item.purpose === purpose) {
      return item.token;
    }
  }
  return undefined;
}
